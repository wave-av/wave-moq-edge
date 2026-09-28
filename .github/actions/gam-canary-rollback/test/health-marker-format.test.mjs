// REL-003 regression test: the `expect-marker:` value gam-post-deploy-guard.yml feeds into the
// canary probe MUST match the ACTUAL live /health response shape, not a hand-assumed one.
//
// THE BUG THIS CATCHES: the guard used to hardcode `expect-marker: '"sha":"<sha>"'` — a
// zero-whitespace JSON key:value substring. The real /health endpoint returns PRETTY-PRINTED JSON
// (`"sha": "<sha>"`, a space after the colon — confirmed live 2026-09-28 against
// https://moq.wave.online/health). `canary-probe.mjs`'s marker check is a literal
// `body.includes(expectMarker)` substring test (see canary-probe.mjs), so the old marker could
// NEVER match a real healthy deploy body — every healthy deploy would read as "regressed" and get
// rolled back the moment GAM_ROLLBACK_ENABLED is turned on.
//
// This test extracts the REAL `expect-marker:` line out of the REAL workflow file (not a
// reimplementation — same extraction discipline as wrapper-failclosed.test.mjs) and proves it
// matches a body shaped exactly like the live endpoint's pretty-printed JSON. It is written to
// FAIL against the old `"sha":"<sha>"` marker and PASS against the fixed raw-sha marker, so it
// pins the fix rather than merely re-describing it.
//
// Run: node --test health-marker-format.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD_YML = join(__dirname, '..', '..', '..', 'workflows', 'gam-post-deploy-guard.yml');

const FAKE_SHA = '61e3d27c1055852e92092535243af9413f65a2cf';

// The exact shape /health returns live (pretty-printed, 2-space indent, space after every colon).
// Mirrors the real `curl https://moq.wave.online/health` receipt in the REL-003 defect record.
const LIVE_HEALTH_BODY = JSON.stringify(
  { ok: true, service: 'wave-moq-edge', sha: FAKE_SHA },
  null,
  2,
);

/** Pull the raw `expect-marker: '...'` value out of the real workflow file and substitute the
 *  `${{ steps.target.outputs.sha }}` expression the way GitHub Actions would at run time. This is
 *  extraction, not reimplementation: if the line moves or is reworded, the anchor regex below
 *  fails loudly instead of silently testing stale text. */
function resolvedExpectMarker() {
  const src = readFileSync(GUARD_YML, 'utf8');
  const m = src.match(/expect-marker:\s*'([^']*)'/);
  if (!m) {
    throw new Error('could not find an `expect-marker:` line in gam-post-deploy-guard.yml — extraction anchor drifted, fix this test before trusting it');
  }
  return m[1].replaceAll('${{ steps.target.outputs.sha }}', FAKE_SHA);
}

test('the REAL expect-marker line, resolved, is found verbatim in a pretty-printed (space-after-colon) /health body', () => {
  const marker = resolvedExpectMarker();
  assert.ok(
    LIVE_HEALTH_BODY.includes(marker),
    `resolved marker '${marker}' was not found in a live-shaped health body:\n${LIVE_HEALTH_BODY}`,
  );
});

test('regression pin: the OLD zero-whitespace `"sha":"<sha>"` marker style would NOT match the live pretty-printed body (proves the bug this fix closes, and that the fix does not silently degrade to it)', () => {
  const oldStyleMarker = `"sha":"${FAKE_SHA}"`;
  assert.ok(
    !LIVE_HEALTH_BODY.includes(oldStyleMarker),
    'the old marker style unexpectedly matched — the live body fixture no longer reproduces the bug this test is pinning',
  );
  // And the CURRENT workflow's marker must differ from that broken old style.
  assert.notEqual(resolvedExpectMarker(), oldStyleMarker);
});
