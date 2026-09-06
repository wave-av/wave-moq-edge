// Tests resolve-prior-good-sha.mjs against a STUBBED `gh` (a fake executable placed first on
// PATH) — no real network call, no real repo. Proves: (1) it correctly SKIPS the excluded
// (currently-failing) run and returns the next-most-recent successful one, and (2) it REFUSES
// (exit 1, no stdout SHA) rather than guessing when no prior successful run exists — the same
// fail-closed shape as the canary probe's refuse state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'resolve-prior-good-sha.mjs');

// Writes a fake `gh` on a scratch dir that answers `gh api <path>` with a fixed JSON payload,
// and prepends that dir to PATH so the real gh CLI is never invoked.
function stubGhReturning(json) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
  const ghPath = join(dir, 'gh');
  writeFileSync(ghPath, `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(json)}\nJSON\n`);
  chmodSync(ghPath, 0o755);
  return dir;
}

test('skips the excluded (currently-canarying) run and returns the NEXT prior successful run head_sha', async () => {
  const stubDir = stubGhReturning({
    workflow_runs: [
      { id: 300, head_sha: 'cccccccccccccccccccccccccccccccccccccccc' }, // the one that just failed canary
      { id: 200, head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, // prior good
      { id: 100, head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    ],
  });
  const { stdout } = await execFileP('node', [SCRIPT, 'wave-av/example-owner-repo', 'deploy.yml', '300'], {
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
  });
  assert.equal(stdout.trim(), 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('REFUSES (exit 1, no SHA printed) when every successful run is the excluded one — never guesses', async () => {
  const stubDir = stubGhReturning({
    workflow_runs: [
      { id: 300, head_sha: 'cccccccccccccccccccccccccccccccccccccccc' },
    ],
  });
  await assert.rejects(
    execFileP('node', [SCRIPT, 'wave-av/example-owner-repo', 'deploy.yml', '300'], {
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
    }),
    (err) => {
      assert.equal(err.code, 1);
      assert.equal((err.stdout || '').trim(), '');
      return true;
    },
  );
});
