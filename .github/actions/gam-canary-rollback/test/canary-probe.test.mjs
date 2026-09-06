// Unit tests for canary-probe.mjs — the 3-state (healthy / regressed / refuse) canary signal.
//
// REL-003: this probe used to be binary (healthy true/false). A canary that cannot distinguish
// "the deploy is provably wrong" from "I could not get an answer at all" can promote to 100% on
// silence — that is the exact defect these tests are written to catch and keep caught. Each test
// runs the REAL script as a child process against a REAL local HTTP server (no fetch mocking),
// so the behavior proven here is the behavior GitHub Actions will actually run.
//
// Run: node --test canary-probe.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBE = join(__dirname, '..', 'canary-probe.mjs');

function lastJsonLine(stdout) {
  const lines = stdout.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runProbe(env) {
  try {
    const { stdout } = await execFileP('node', [PROBE], {
      env: { ...process.env, ...env },
      timeout: 20_000,
    });
    return { code: 0, receipt: lastJsonLine(stdout) };
  } catch (err) {
    // execFile rejects on non-zero exit; the receipt is still on stdout.
    return { code: err.code, receipt: lastJsonLine(err.stdout || '') };
  }
}

test('healthy: determinate 200 + matching marker -> state=healthy, exit 0', async () => {
  await withServer(
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello WAVE-CANARY-MARKER world'); },
    async (url) => {
      const { code, receipt } = await runProbe({
        CANARY_URL: url,
        EXPECT_MARKER: 'WAVE-CANARY-MARKER',
        MAX_ATTEMPTS: '1',
        RETRY_DELAY_MS: '0',
      });
      assert.equal(code, 0);
      assert.equal(receipt.state, 'healthy');
      assert.equal(receipt.healthy, true);
    },
  );
});

test('regressed: determinate 200 but WRONG marker -> state=regressed, exit 1 (positive control: proves the probe can tell healthy from regressed, not merely always-false)', async () => {
  await withServer(
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('holding page, nothing real here'); },
    async (url) => {
      const { code, receipt } = await runProbe({
        CANARY_URL: url,
        EXPECT_MARKER: 'WAVE-CANARY-MARKER',
        MAX_ATTEMPTS: '1',
        RETRY_DELAY_MS: '0',
      });
      assert.equal(code, 1);
      assert.equal(receipt.state, 'regressed');
      assert.equal(receipt.healthy, false);
    },
  );
});

test('refuse: every attempt fails to connect (no determinate answer) -> state=refuse, exit 3, healthy=false — REFUSE must never equal healthy', async () => {
  // Port 1 on loopback: no listener, ECONNREFUSED on every attempt, deterministically and fast.
  const { code, receipt } = await runProbe({
    CANARY_URL: 'http://127.0.0.1:1/',
    EXPECT_STATUS: '200',
    MAX_ATTEMPTS: '2',
    RETRY_DELAY_MS: '0',
    TIMEOUT_MS: '1000',
  });
  assert.equal(code, 3);
  assert.equal(receipt.state, 'refuse');
  assert.equal(receipt.healthy, false, 'REFUSE must not be treated as healthy');
  assert.notEqual(receipt.state, 'healthy');
});

test('config error (no acceptance criterion given) -> refuse, exit 2, never healthy (all-negative assertion paired with the healthy positive control above)', async () => {
  const { code, receipt } = await runProbe({
    CANARY_URL: 'http://127.0.0.1:1/',
    // no EXPECT_MARKER / EXPECT_HEADER / EXPECT_STATUS
  });
  assert.equal(code, 2);
  assert.equal(receipt.state, 'refuse');
  assert.equal(receipt.healthy, false);
});
