// Tests resolve-prior-good-sha.mjs against a STUBBED `gh` (a fake executable placed first on
// PATH) — no real network call, no real repo. Proves: (1) it correctly SKIPS the excluded
// (currently-failing) run and returns the next-most-recent successful one, (2) it REFUSES
// (exit 1, no stdout SHA) rather than guessing when no prior successful run exists — the same
// fail-closed shape as the canary probe's refuse state, (3) it never returns a STAGING run as a
// production rollback target, (4) it never rolls FORWARD to a run newer than the regression, and
// (5) it queries the API path it is supposed to query, with the status filter that makes the
// returned SHA "proven good" in the first place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, chmodSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'resolve-prior-good-sha.mjs');

// Writes a fake `gh` on a scratch dir that answers `gh api <path>` with a fixed JSON payload,
// RECORDS the argv it was called with, and prepends that dir to PATH so the real gh CLI is never
// invoked. Recording argv is the point: without it these tests would still pass if the script
// dropped the `status=success` filter or pointed at the wrong workflow file — i.e. they would
// not actually be testing the fail-closed property this resolver exists to provide.
function stubGhReturning(json) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
  const ghPath = join(dir, 'gh');
  const argvLog = join(dir, 'argv.log');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\ncat <<'JSON'\n${JSON.stringify(json)}\nJSON\n`,
  );
  chmodSync(ghPath, 0o755);
  return { dir, argv: () => (existsSync(argvLog) ? readFileSync(argvLog, 'utf8').trim().split('\n') : []) };
}

const run = (stub, args) =>
  execFileP('node', [SCRIPT, ...args], { env: { ...process.env, PATH: `${stub.dir}:${process.env.PATH}` } });

const prodRun = (id, sha, extra = {}) => ({
  id, head_sha: sha, head_branch: 'main', event: 'push',
  created_at: `2026-09-0${id % 9 || 1}T00:00:00Z`, ...extra,
});

test('skips the excluded (currently-canarying) run and returns the NEXT prior successful run head_sha', async () => {
  const stub = stubGhReturning({
    workflow_runs: [
      { ...prodRun(300, 'cccccccccccccccccccccccccccccccccccccccc'), created_at: '2026-09-03T00:00:00Z' }, // just failed canary
      { ...prodRun(200, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), created_at: '2026-09-02T00:00:00Z' }, // prior good
      { ...prodRun(100, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), created_at: '2026-09-01T00:00:00Z' },
    ],
  });
  const { stdout } = await run(stub, ['wave-av/example-owner-repo', 'deploy.yml', '300']);
  assert.equal(stdout.trim(), 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('queries the right workflow with the status=success + event=push filters (the filters are what make the returned SHA proven-good and production)', async () => {
  const stub = stubGhReturning({ workflow_runs: [prodRun(200, 'b'.repeat(40))] });
  await run(stub, ['wave-av/example-owner-repo', 'deploy.yml', '300']);
  const argv = stub.argv();
  assert.deepEqual(argv[0], 'api', 'must call `gh api`, not some other subcommand');
  const path = argv[1];
  assert.match(path, /^repos\/wave-av\/example-owner-repo\/actions\/workflows\/deploy\.yml\/runs\?/);
  assert.match(path, /status=success/, 'dropping status=success would let a FAILED run be chosen as the rollback target');
  assert.match(path, /event=push/, 'dropping event=push would let an ambiguous workflow_dispatch run be chosen');
});

test('REFUSES (exit 1, no SHA printed) when every successful run is the excluded one — never guesses', async () => {
  const stub = stubGhReturning({
    workflow_runs: [prodRun(300, 'cccccccccccccccccccccccccccccccccccccccc')],
  });
  await assert.rejects(
    run(stub, ['wave-av/example-owner-repo', 'deploy.yml', '300']),
    (err) => {
      assert.equal(err.code, 1);
      assert.equal((err.stdout || '').trim(), '');
      return true;
    },
  );
});

test('never returns a STAGING run as a production rollback target — the most-recent-success-wins bug', async () => {
  // The realistic failure window: staging is pushed constantly, so the newest successful deploy
  // run is almost always a staging one. The old resolver returned it and would have "rolled
  // production back" to a commit that was only ever deployed to staging.
  const stub = stubGhReturning({
    workflow_runs: [
      { ...prodRun(300, 'c'.repeat(40)), created_at: '2026-09-05T00:00:00Z' },                      // failing prod run
      { ...prodRun(250, 's'.repeat(40)), head_branch: 'staging', created_at: '2026-09-04T00:00:00Z' }, // newer, but staging
      { ...prodRun(200, 'b'.repeat(40)), created_at: '2026-09-02T00:00:00Z' },                      // the real prior good
    ],
  });
  const { stdout } = await run(stub, ['wave-av/example-owner-repo', 'deploy.yml', '300']);
  assert.equal(stdout.trim(), 'b'.repeat(40));
});

test('never rolls FORWARD: a successful run newer than the regression is not a "prior good" target', async () => {
  const stub = stubGhReturning({
    workflow_runs: [
      { ...prodRun(400, 'f'.repeat(40)), created_at: '2026-09-06T00:00:00Z' }, // newer than the anchor
      { ...prodRun(300, 'c'.repeat(40)), created_at: '2026-09-05T00:00:00Z' }, // anchor (excluded)
      { ...prodRun(200, 'b'.repeat(40)), created_at: '2026-09-02T00:00:00Z' }, // the real prior good
    ],
  });
  const { stdout } = await run(stub, ['wave-av/example-owner-repo', 'deploy.yml', '300']);
  assert.equal(stdout.trim(), 'b'.repeat(40));
});

test('--exclude-sha drops EVERY run at the just-regressed commit, not merely the triggering run id', async () => {
  const bad = 'c'.repeat(40);
  const stub = stubGhReturning({
    workflow_runs: [
      { ...prodRun(300, bad), created_at: '2026-09-05T00:00:00Z' },        // the run that failed canary
      { ...prodRun(290, bad), created_at: '2026-09-04T00:00:00Z' },        // a DIFFERENT run at the SAME bad commit
      { ...prodRun(200, 'b'.repeat(40)), created_at: '2026-09-02T00:00:00Z' },
    ],
  });
  const { stdout } = await run(stub, ['wave-av/example-owner-repo', 'deploy.yml', '300', '--exclude-sha', bad]);
  assert.equal(stdout.trim(), 'b'.repeat(40), 're-dispatching the regressed commit would ship the regression again');
});
