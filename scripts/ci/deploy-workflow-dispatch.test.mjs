// deploy.yml's workflow_dispatch lets `env` and the dispatched-from branch be chosen independently.
// Combined with CLOUDFLARE_API_TOKEN as a repo secret (no GitHub Environment), a write collaborator
// can push unreviewed code to a throwaway branch, Run workflow → env=production, and ship that
// bundle to moq.wave.online. The ancestry guard then checks GITHUB_SHA against origin/$REF_NAME,
// so the throwaway branch's own tip "proves" itself.
//
// This test extracts the real resolve-target `run:` block from deploy.yml and executes it.
// On an unfixed workflow the exploit case exits 0. After the guard it must fail.
//
// Run: node --test scripts/ci/deploy-workflow-dispatch.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_YML = join(__dirname, '..', '..', '.github', 'workflows', 'deploy.yml');

function extractResolveTargetBlock() {
  const src = readFileSync(DEPLOY_YML, 'utf8');
  const startAnchor = 'case "$EVENT_NAME" in';
  const endAnchor = 'echo "Deploying to: $ENV_NAME"';
  const start = src.indexOf(startAnchor);
  if (start === -1) {
    throw new Error('could not find resolve-target start anchor in deploy.yml');
  }
  const end = src.indexOf(endAnchor, start);
  if (end === -1) {
    throw new Error('could not find resolve-target end anchor in deploy.yml');
  }
  return src.slice(start, end + endAnchor.length);
}

async function runResolveTarget(env) {
  const block = extractResolveTargetBlock();
  const dir = mkdtempSync(join(os.tmpdir(), 'deploy-dispatch-test-'));
  const outFile = join(dir, 'github-output');
  writeFileSync(outFile, '');
  try {
    try {
      const result = await execFileP('bash', ['-c', block], {
        env: { ...process.env, GITHUB_OUTPUT: outFile, ...env },
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (err) {
      return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('workflow_dispatch env=production from a throwaway branch is rejected', async () => {
  const { code, stdout, stderr } = await runResolveTarget({
    EVENT_NAME: 'workflow_dispatch',
    REF_NAME: 'attacker-throwaway-branch',
    INPUT_ENV: 'production',
  });
  assert.notEqual(
    code,
    0,
    `expected rejection of production dispatch from a non-main ref, got exit 0\nstdout: ${stdout}\nstderr: ${stderr}`,
  );
  assert.match(`${stdout}\n${stderr}`, /must be dispatched from main or master/);
});

test('workflow_dispatch env=production from main is accepted', async () => {
  const { code, stdout } = await runResolveTarget({
    EVENT_NAME: 'workflow_dispatch',
    REF_NAME: 'main',
    INPUT_ENV: 'production',
  });
  assert.equal(code, 0, `expected success, stdout: ${stdout}`);
  assert.match(stdout, /Deploying to: production/);
});

test('workflow_dispatch env=production from master is accepted', async () => {
  const { code } = await runResolveTarget({
    EVENT_NAME: 'workflow_dispatch',
    REF_NAME: 'master',
    INPUT_ENV: 'production',
  });
  assert.equal(code, 0);
});

test('workflow_dispatch env=staging from an arbitrary branch is still accepted', async () => {
  const { code, stdout } = await runResolveTarget({
    EVENT_NAME: 'workflow_dispatch',
    REF_NAME: 'feature/whatever',
    INPUT_ENV: 'staging',
  });
  assert.equal(code, 0);
  assert.match(stdout, /Deploying to: staging/);
});

test('push to main still maps to production', async () => {
  const { code, stdout } = await runResolveTarget({
    EVENT_NAME: 'push',
    REF_NAME: 'main',
    INPUT_ENV: '',
  });
  assert.equal(code, 0);
  assert.match(stdout, /Deploying to: production/);
});
