// Tests the EXACT jq fail-closed default line lifted from action.yml's "canary probe" step —
// not a reimplementation of it. If a future edit to action.yml changes that line without updating
// this extraction, the extraction step below fails loudly (the regex must match), so this cannot
// silently drift into testing a copy instead of the real thing.
//
// This is the single line the whole REL-003 program is named after: "a canary that promotes to
// 100% because its health check returned nothing is the exact defect this program exists to
// close." That defect lives here — in the shell glue around the probe, not in the probe itself —
// because a probe can be perfect and still get its receipt mangled/truncated by transport (Actions
// step summaries, `tail -1`, a runner OOM mid-write) before the caller reads it.
//
// Run: node --test wrapper-failclosed.test.mjs   (requires `jq` on PATH, as does the real action)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ACTION_YML = join(__dirname, '..', 'action.yml');

// Extract the FULL fail-closed sequence — the jq read AND the case-statement safety net that
// follows it — not just the jq filter in isolation. jq on a truly EMPTY stdin exits 0 with empty
// output (not an error), so the `|| echo refuse` fallback alone does not catch that case; it is
// the case-statement's `*) STATE="refuse"` catch-all that closes it. Testing only the jq filter
// in isolation would miss that and falsely fail on the exact input this test exists to cover —
// which is what happened when this test was first written and caught its own gap.
function extractFailClosedBlock() {
  const src = readFileSync(ACTION_YML, 'utf8');
  const start = src.indexOf('STATE="$(printf');
  const end = src.indexOf('esac', start);
  if (start === -1 || end === -1) {
    throw new Error('could not find the fail-closed STATE block in action.yml — extraction anchor drifted, fix this test before trusting it');
  }
  return src.slice(start, end + 'esac'.length);
}

async function applyBlock(block, receiptText) {
  // Pass the receipt via env var (not stdin/interpolation) so an empty string, a truncated
  // fragment, or a value containing quotes all round-trip byte-for-byte with zero shell escaping.
  const script = `RECEIPT="$WRAPPER_TEST_RECEIPT"; ${block}; echo "$STATE"`;
  const { stdout } = await execFileP('bash', ['-c', script], {
    env: { ...process.env, WRAPPER_TEST_RECEIPT: receiptText },
  });
  return stdout.trim();
}

test('real action.yml block: a WELL-FORMED healthy receipt reads through as healthy (positive control)', async () => {
  const block = extractFailClosedBlock();
  const state = await applyBlock(block, JSON.stringify({ state: 'healthy', healthy: true }));
  assert.equal(state, 'healthy');
});

test('real action.yml block: an EMPTY receipt (probe crashed before emitting anything) defaults to refuse, never healthy', async () => {
  const block = extractFailClosedBlock();
  const state = await applyBlock(block, '');
  assert.equal(state, 'refuse');
  assert.notEqual(state, 'healthy');
});

test('real action.yml block: a TRUNCATED/malformed JSON receipt (mid-write truncation) defaults to refuse, never healthy', async () => {
  const block = extractFailClosedBlock();
  const state = await applyBlock(block, '{"state":"heal');
  assert.equal(state, 'refuse');
  assert.notEqual(state, 'healthy');
});

test('real action.yml block: VALID JSON that legitimately has NO .state key (e.g. an old binary-only {healthy:false} receipt, or a stray {}) defaults to refuse via the jq "// refuse" fallback, never healthy — this is the one case where the case-statement catch-all does NOT already save you, so this is the test the `.state // "refuse"` default actually exists for', async () => {
  const block = extractFailClosedBlock();
  const state = await applyBlock(block, JSON.stringify({ healthy: false, reason: 'old-format receipt, no state key' }));
  assert.equal(state, 'refuse');
  assert.notEqual(state, 'healthy');
});
