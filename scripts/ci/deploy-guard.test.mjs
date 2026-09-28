// REL-003 review fix (BLOCKING): deploy.yml's workflow_dispatch let `env` and the dispatched-from
// branch be chosen INDEPENDENTLY, and its post-checkout ancestry guard checked TARGET_SHA against
// `origin/$REF_NAME` (the arbitrary branch a workflow_dispatch was run from) instead of
// `origin/main`/`origin/master` whenever the resolved env was 'production'. Combined with
// `environment: production` being an admitted no-op passthrough until a repo admin separately
// configures GitHub Environment protection, this let any collaborator with repo write access push
// unreviewed code to a throwaway branch, dispatch deploy.yml from it with env=production (sha
// left empty defaults to that branch's own tip), and reach production with no review and no
// branch restriction enforced anywhere in code.
//
// Two independent layers now close this:
//   1. resolve-target job: workflow_dispatch env=production is REJECTED unless dispatched from
//      main or master (before checkout, before secrets, before the deploy job even starts).
//   2. deploy job's ancestry guard: for a resolved env=production, ancestry is checked against
//      origin/main (falling back to origin/master), never against origin/$REF_NAME — so even if
//      layer 1 were ever loosened, a throwaway branch's own tip can no longer "prove" itself an
//      ancestor of itself.
//
// This test extracts BOTH real `run:` blocks from deploy.yml (not a reimplementation — if the
// blocks drift, the anchor lookups below fail loudly) and exercises them directly with `bash`,
// including reproducing the exact exploit scenario from the review finding against BOTH layers,
// and a positive control proving the OLD (pre-fix) guard-2 logic really did let it through.
//
// Run: node --test scripts/ci/deploy-guard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_YML = join(__dirname, '..', '..', '.github', 'workflows', 'deploy.yml');

function extractRunBlock(startAnchor, endAnchor) {
  const src = readFileSync(DEPLOY_YML, 'utf8');
  const start = src.indexOf(startAnchor);
  if (start === -1) {
    throw new Error(`could not find start anchor ${JSON.stringify(startAnchor)} in deploy.yml — extraction drifted, fix this test before trusting it`);
  }
  const end = src.indexOf(endAnchor, start);
  if (end === -1) {
    throw new Error(`could not find end anchor ${JSON.stringify(endAnchor)} in deploy.yml — extraction drifted, fix this test before trusting it`);
  }
  return src.slice(start, end + endAnchor.length);
}

function resolveTargetBlock() {
  return extractRunBlock('set -e\n          case "$EVENT_NAME" in', 'echo "Deploying to: $ENV_NAME @ $SHA"');
}

function guardBlock() {
  return extractRunBlock('set -e\n          # REL-003 fix: for a PRODUCTION deploy', 'echo "deploy guard OK: $TARGET_SHA is an ancestor of origin/$BASE_REF (tip $TIP)"');
}

async function runResolveTarget(env) {
  const block = resolveTargetBlock();
  const outFile = join(os.tmpdir(), `deploy-guard-test-output-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    let result;
    try {
      result = await execFileP('bash', ['-c', block], {
        env: { ...process.env, GITHUB_OUTPUT: outFile, ...env },
      });
    } catch (err) {
      return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } finally {
    try { rmSync(outFile); } catch { /* may not exist on early exit */ }
  }
}

test('resolve-target rejects workflow_dispatch env=production dispatched from a throwaway branch (the exploit scenario)', async () => {
  const { code, stdout, stderr } = await runResolveTarget({
    EVENT_NAME: 'workflow_dispatch',
    REF_NAME: 'attacker-throwaway-branch',
    INPUT_ENV: 'production',
    INPUT_SHA: '',
    TIP_SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  });
  assert.notEqual(code, 0, `expected rejection, got exit 0\nstdout: ${stdout}\nstderr: ${stderr}`);
  assert.match(stdout, /must be dispatched from main or master/);
});

test('resolve-target accepts workflow_dispatch env=production dispatched from main', async () => {
  const { code, stdout } = await runResolveTarget({
    EVENT_NAME: 'workflow_dispatch',
    REF_NAME: 'main',
    INPUT_ENV: 'production',
    INPUT_SHA: '',
    TIP_SHA: 'cafebabecafebabecafebabecafebabecafebabe',
  });
  assert.equal(code, 0, `expected success, stdout: ${stdout}`);
  assert.match(stdout, /Deploying to: production @ cafebabecafebabecafebabecafebabecafebabe/);
});

test('resolve-target accepts workflow_dispatch env=production dispatched from master', async () => {
  const { code } = await runResolveTarget({
    EVENT_NAME: 'workflow_dispatch',
    REF_NAME: 'master',
    INPUT_ENV: 'production',
    INPUT_SHA: '',
    TIP_SHA: 'cafebabecafebabecafebabecafebabecafebabe',
  });
  assert.equal(code, 0);
});

test('resolve-target still accepts workflow_dispatch env=staging from an arbitrary branch (staging is unaffected by this fix)', async () => {
  const { code, stdout } = await runResolveTarget({
    EVENT_NAME: 'workflow_dispatch',
    REF_NAME: 'feature/whatever',
    INPUT_ENV: 'staging',
    INPUT_SHA: '',
    TIP_SHA: 'cafebabecafebabecafebabecafebabecafebabe',
  });
  assert.equal(code, 0);
  assert.match(stdout, /Deploying to: staging @/);
});

test('resolve-target still accepts a normal push to main/staging (push path unaffected)', async () => {
  const main = await runResolveTarget({ EVENT_NAME: 'push', REF_NAME: 'main', INPUT_ENV: '', INPUT_SHA: '', TIP_SHA: 'cafebabecafebabecafebabecafebabecafebabe' });
  assert.equal(main.code, 0);
  assert.match(main.stdout, /Deploying to: production @/);

  const staging = await runResolveTarget({ EVENT_NAME: 'push', REF_NAME: 'staging', INPUT_ENV: '', INPUT_SHA: '', TIP_SHA: 'cafebabecafebabecafebabecafebabecafebabe' });
  assert.equal(staging.code, 0);
  assert.match(staging.stdout, /Deploying to: staging @/);
});

// --- Layer 2: the ancestry guard, against a REAL git repo standing in for `origin` ---

function makeFakeOriginWithThrowawayBranch() {
  const dir = mkdtempSync(join(os.tmpdir(), 'deploy-guard-fake-origin-'));
  const run = (cmd, args, cwd) => execFileP(cmd, args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'wave-av-bot[bot]@users.noreply.github.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'wave-av-bot[bot]@users.noreply.github.com' } });
  return (async () => {
    await run('git', ['init', '-q', '-b', 'main', '.'], dir);
    await execFileP('bash', ['-c', 'echo main-content > f.txt && git add f.txt && git commit -q -m "reviewed main commit"'], { cwd: dir });
    const { stdout: mainSha } = await run('git', ['rev-parse', 'HEAD'], dir);
    await run('git', ['checkout', '-q', '-b', 'attacker-branch'], dir);
    await execFileP('bash', ['-c', 'echo unreviewed-payload > f.txt && git commit -q -am "unreviewed attacker commit"'], { cwd: dir });
    const { stdout: attackerSha } = await run('git', ['rev-parse', 'HEAD'], dir);
    await run('git', ['checkout', '-q', 'main'], dir);

    const checkout = mkdtempSync(join(os.tmpdir(), 'deploy-guard-fake-checkout-'));
    await execFileP('git', ['clone', '-q', dir, checkout]);
    await execFileP('git', ['fetch', '-q', 'origin', 'attacker-branch:refs/remotes/origin/attacker-branch'], { cwd: checkout });
    await execFileP('git', ['checkout', '-q', attackerSha.trim()], { cwd: checkout });
    return { origin: dir, checkout, mainSha: mainSha.trim(), attackerSha: attackerSha.trim() };
  })();
}

async function runGuard(cwd, env) {
  const block = guardBlock();
  try {
    const result = await execFileP('bash', ['-c', block], { cwd, env: { ...process.env, ...env } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('deploy guard rejects the exploit: env=production, REF_NAME=throwaway branch, sha=that branch\'s own unreviewed tip', async (t) => {
  const { checkout, attackerSha } = await makeFakeOriginWithThrowawayBranch();
  t.after(() => { rmSync(checkout, { recursive: true, force: true }); });
  const { code, stdout, stderr } = await runGuard(checkout, {
    REF_NAME: 'attacker-branch',
    TARGET_ENV: 'production',
    TARGET_SHA: attackerSha,
  });
  assert.notEqual(code, 0, `expected rejection\nstderr: ${stderr}`);
  assert.match(stdout, /not an ancestor of origin\/main/);
});

test('deploy guard accepts a legitimate production deploy: sha is an ancestor of origin/main', async (t) => {
  const { checkout, mainSha } = await makeFakeOriginWithThrowawayBranch();
  t.after(() => { rmSync(checkout, { recursive: true, force: true }); });
  const { code, stdout } = await runGuard(checkout, {
    REF_NAME: 'main',
    TARGET_ENV: 'production',
    TARGET_SHA: mainSha,
  });
  assert.equal(code, 0, `expected success\nstdout: ${stdout}`);
  assert.match(stdout, /is an ancestor of origin\/main/);
});

test('deploy guard staging path is unaffected: still checks ancestry against origin/$REF_NAME', async (t) => {
  const { checkout, attackerSha } = await makeFakeOriginWithThrowawayBranch();
  t.after(() => { rmSync(checkout, { recursive: true, force: true }); });
  const { code, stdout } = await runGuard(checkout, {
    REF_NAME: 'attacker-branch',
    TARGET_ENV: 'staging',
    TARGET_SHA: attackerSha,
  });
  assert.equal(code, 0, `staging deploys should still check ancestry against their own ref_name\nstdout: ${stdout}`);
});

test('control: the OLD (pre-fix) guard logic — ancestry checked against origin/$REF_NAME even for production — DOES let the exploit through', async (t) => {
  const { checkout, attackerSha } = await makeFakeOriginWithThrowawayBranch();
  t.after(() => { rmSync(checkout, { recursive: true, force: true }); });
  const oldBlock = [
    'set -e',
    'git fetch origin "$REF_NAME" --quiet',
    'TIP=$(git rev-parse "origin/$REF_NAME")',
    'if ! git merge-base --is-ancestor "$TARGET_SHA" "origin/$REF_NAME"; then',
    '  echo "::error::not an ancestor" >&2',
    '  exit 1',
    'fi',
    'echo "deploy guard OK (OLD/VULNERABLE): $TARGET_SHA is an ancestor of origin/$REF_NAME (tip $TIP)"',
  ].join('\n');
  const result = await execFileP('bash', ['-c', oldBlock], {
    cwd: checkout,
    env: { ...process.env, REF_NAME: 'attacker-branch', TARGET_SHA: attackerSha },
  });
  assert.match(result.stdout, /deploy guard OK \(OLD\/VULNERABLE\)/, 'expected the OLD logic to incorrectly pass the exploit — if this fails, the old pattern was not actually vulnerable as documented');
});
