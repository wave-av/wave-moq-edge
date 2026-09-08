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
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  const line = lines[lines.length - 1];
  if (!line) return null;
  return JSON.parse(line);
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
    // execFile rejects on non-zero exit; the receipt is still on stdout. If it ISN'T — a crash
    // before emit(), or an execFile timeout that killed the child — surface THAT, rather than a
    // `JSON.parse of undefined` that hides the real failure from whoever reads the test output.
    const receipt = lastJsonLine(err.stdout);
    if (receipt === null) {
      throw new Error(
        `probe exited ${err.code ?? err.signal} with NO receipt on stdout — stderr:\n${String(err.stderr || '').slice(0, 2000)}`,
      );
    }
    return { code: err.code, receipt };
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
    // no EXPECT_MARKER / EXPECT_HEADER / EXPECT_STATUS / EXPECT_JSON
  });
  assert.equal(code, 2);
  assert.equal(receipt.state, 'refuse');
  assert.equal(receipt.healthy, false);
});

// ---------------------------------------------------------------- input-validation refusals
// Each of these was a way to make the probe stop being a probe while still looking configured.

test('MAX_ATTEMPTS=Infinity is a config REFUSE, not an unbounded retry loop that never reaches rollback', async () => {
  const { code, receipt } = await runProbe({
    CANARY_URL: 'http://127.0.0.1:1/', EXPECT_STATUS: '200', MAX_ATTEMPTS: 'Infinity', RETRY_DELAY_MS: '0',
  });
  assert.equal(code, 2);
  assert.equal(receipt.state, 'refuse');
  assert.match(receipt.reason, /MAX_ATTEMPTS/);
});

test('MAX_ATTEMPTS=abc (NaN) is a config REFUSE, not zero probes reported as attempts:null', async () => {
  const { code, receipt } = await runProbe({
    CANARY_URL: 'http://127.0.0.1:1/', EXPECT_STATUS: '200', MAX_ATTEMPTS: 'abc', RETRY_DELAY_MS: '0',
  });
  assert.equal(code, 2);
  assert.equal(receipt.state, 'refuse');
  assert.match(receipt.reason, /MAX_ATTEMPTS/);
});

test("EXPECT_HEADER=':' is a config REFUSE — an empty expected value matches every response and would promote a holding page", async () => {
  await withServer(
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('holding page'); },
    async (url) => {
      const { code, receipt } = await runProbe({
        CANARY_URL: url, EXPECT_HEADER: ':', MAX_ATTEMPTS: '1', RETRY_DELAY_MS: '0',
      });
      assert.equal(code, 2, "':' must not be accepted as a header criterion");
      assert.equal(receipt.state, 'refuse');
      assert.notEqual(receipt.state, 'healthy');
    },
  );
});

test('a MISSING expected header is regressed, never healthy (has() is checked before the substring match)', async () => {
  await withServer(
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('body'); },
    async (url) => {
      const { code, receipt } = await runProbe({
        CANARY_URL: url, EXPECT_HEADER: 'x-build: v9', MAX_ATTEMPTS: '1', RETRY_DELAY_MS: '0',
      });
      assert.equal(code, 1);
      assert.equal(receipt.state, 'regressed');
      assert.equal(receipt.hdrOk, false);
    },
  );
});

test('a non-loopback plaintext CANARY_URL is a config REFUSE — CANARY_HEADERS may carry a token and an on-path attacker could forge the verdict', async () => {
  const { code, receipt } = await runProbe({
    CANARY_URL: 'http://example.invalid/health', EXPECT_STATUS: '200', MAX_ATTEMPTS: '1', RETRY_DELAY_MS: '0',
  });
  assert.equal(code, 2);
  assert.equal(receipt.state, 'refuse');
  assert.match(receipt.reason, /https/);
});

// -------------------------------------------------------------------------- redirect handling
test('a CROSS-ORIGIN redirect is rejected, not followed — an unrelated origin must never be judged as production health', async () => {
  await withServer(
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('WAVE-CANARY-MARKER'); },
    async (otherOrigin) => {
      await withServer(
        (_req, res) => { res.writeHead(302, { location: `${otherOrigin}/health` }); res.end(); },
        async (url) => {
          const { code, receipt } = await runProbe({
            CANARY_URL: url, EXPECT_MARKER: 'WAVE-CANARY-MARKER', MAX_ATTEMPTS: '1', RETRY_DELAY_MS: '0',
          });
          assert.equal(code, 1, 'the marker is served by the redirect TARGET; following it would have said healthy');
          assert.equal(receipt.state, 'regressed');
          assert.match(receipt.redirectRejected, /cross-origin/);
        },
      );
    },
  );
});

test('a SAME-ORIGIN redirect is followed and the final response is evaluated (a trailing-slash 301 is not a regression)', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/health') { res.writeHead(301, { location: '/health/' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('WAVE-CANARY-MARKER');
    },
    async (url) => {
      const { code, receipt } = await runProbe({
        CANARY_URL: `${url}/health`, EXPECT_MARKER: 'WAVE-CANARY-MARKER', MAX_ATTEMPTS: '1', RETRY_DELAY_MS: '0',
      });
      assert.equal(code, 0);
      assert.equal(receipt.state, 'healthy');
    },
  );
});

// ------------------------------------------------------------------------- JSON-field matching
test('EXPECT_JSON matches the PARSED field, so pretty-printed JSON is not a spurious regression', async () => {
  const sha = 'a'.repeat(40);
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Exactly the shape the live /health serves: pretty-printed, space after the colon.
      res.end(JSON.stringify({ ok: true, sha }, null, 2));
    },
    async (url) => {
      const asMarker = await runProbe({
        CANARY_URL: url, EXPECT_MARKER: `"sha":"${sha}"`, MAX_ATTEMPTS: '1', RETRY_DELAY_MS: '0',
      });
      assert.equal(asMarker.receipt.state, 'regressed',
        'positive control: the whitespace-sensitive substring marker DOES fail on this body — that was the live defect');

      const asJson = await runProbe({
        CANARY_URL: url, EXPECT_JSON: `sha=${sha}`, MAX_ATTEMPTS: '1', RETRY_DELAY_MS: '0',
      });
      assert.equal(asJson.code, 0);
      assert.equal(asJson.receipt.state, 'healthy');
    },
  );
});

test('EXPECT_JSON on a WRONG sha is regressed (proves the JSON check discriminates, not merely always-passes)', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sha: 'b'.repeat(40) }, null, 2));
    },
    async (url) => {
      const { code, receipt } = await runProbe({
        CANARY_URL: url, EXPECT_JSON: `sha=${'a'.repeat(40)}`, MAX_ATTEMPTS: '1', RETRY_DELAY_MS: '0',
      });
      assert.equal(code, 1);
      assert.equal(receipt.state, 'regressed');
      assert.equal(receipt.jsonOk, false);
    },
  );
});

// --------------------------------------------------------------------------- receipt coherence
test('a regressed verdict emits the last DETERMINATE attempt, never a receipt that says determinate:false', async () => {
  let n = 0;
  await withServer(
    (_req, res) => {
      n += 1;
      if (n === 1) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('holding page'); return; }
      // Second attempt: hang past TIMEOUT_MS so it aborts and yields a NON-determinate result.
      setTimeout(() => { try { res.end('late'); } catch { /* socket gone */ } }, 5000).unref?.();
    },
    async (url) => {
      const { code, receipt } = await runProbe({
        CANARY_URL: url, EXPECT_MARKER: 'WAVE-CANARY-MARKER',
        MAX_ATTEMPTS: '2', RETRY_DELAY_MS: '0', TIMEOUT_MS: '1000',
      });
      assert.equal(code, 1);
      assert.equal(receipt.state, 'regressed');
      assert.equal(receipt.determinate, true, 'a regressed receipt claiming determinate:false contradicts its own verdict');
      assert.equal(receipt.status, 200);
      assert.equal(receipt.markerOk, false);
    },
  );
});
