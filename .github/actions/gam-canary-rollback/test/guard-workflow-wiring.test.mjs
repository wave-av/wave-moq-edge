// Wiring tests for .github/workflows/gam-post-deploy-guard.yml and the rollback script it calls.
//
// WHY THIS FILE EXISTS. The probe and the resolver each have real behavioural tests, but the
// safety path is only as good as the YAML that WIRES them together — and that YAML is where the
// worst bug in the first cut of this feature lived: the canary's acceptance marker was
// `"sha":"<sha>"` while the live /health body is pretty-printed as `"sha": "<sha>"`. Every field
// was individually correct; the composition was not, and nothing in the suite could see it.
// GitHub Actions YAML cannot be executed locally, so these are STRUCTURAL assertions on the
// composition: the kill-switch is read first and gates everything, production identity is
// established before any probe, and the rollback dispatch names production explicitly.
//
// Deliberately dependency-free (no YAML parser): these assert on the exact text an operator
// reads, which is also the text GitHub reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACTION_DIR = join(__dirname, '..');
const REPO_ROOT = join(ACTION_DIR, '..', '..', '..');
const GUARD = readFileSync(join(REPO_ROOT, '.github/workflows/gam-post-deploy-guard.yml'), 'utf8');
const DEPLOY = readFileSync(join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8');
const ROLLBACK = readFileSync(join(ACTION_DIR, 'rollback-to-prior-good.sh'), 'utf8');
// The script's header comment quotes the OLD, broken invocation to explain why it is gone, so a
// "must not appear" assertion has to look at executable lines only or it flags the explanation.
const ROLLBACK_CODE = ROLLBACK.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('kill-switch: the guard is inert unless GAM_ROLLBACK_ENABLED == 1, and every acting step is gated on it', () => {
  assert.match(GUARD, /GAM_ROLLBACK_ENABLED/, 'the kill-switch variable must be read');
  assert.match(GUARD, /!=\s*"1"/, 'anything other than exactly "1" must be OFF');
  // Every step after the kill-switch step must be conditioned on it. Count the gates rather than
  // eyeballing them: a new step added without the gate is the way this goes live by accident.
  const gates = GUARD.match(/steps\.killswitch\.outputs\.enabled == 'true'/g) || [];
  assert.ok(gates.length >= 5, `expected every acting step to be gated on the kill-switch, found ${gates.length}`);
});

test('the canary matches the PARSED /health sha field, not a whitespace-fragile substring', () => {
  assert.match(
    GUARD,
    /expect-json:\s*'sha=\$\{\{ steps\.target\.outputs\.sha \}\}'/,
    'the live /health body is pretty-printed (`"sha": "<sha>"`, with a space), so a `"sha":"<sha>"` substring marker never matches and would classify EVERY deploy as regressed',
  );
  assert.doesNotMatch(GUARD, /expect-marker:\s*'"sha":"/, 'the whitespace-fragile marker must not come back');
});

test('production identity is established before probing: push-only AND a production branch, on both trigger paths', () => {
  assert.match(GUARD, /WR_EVENT:\s*\$\{\{ github\.event\.workflow_run\.event \}\}/, 'the upstream trigger type must be carried in');
  assert.match(GUARD, /WR_EVENT.*!=\s*"push"/s, 'a workflow_dispatch deploy could have targeted staging — it must not be canaried as production');
  // Both the workflow_run path and the manual path must gate on main|master.
  const branchGates = GUARD.match(/main\|master\)/g) || [];
  assert.equal(branchGates.length, 2, 'both the workflow_run path and the manual workflow_dispatch path need a production-branch gate');
  assert.match(GUARD, /GITHUB_REF_NAME/, 'the manual path must check the ref it was dispatched from');
});

test('the rollback dispatches PRODUCTION at a BRANCH ref, carrying the target commit as an input', () => {
  assert.match(ROLLBACK_CODE, /-f env=production/, 'omitting env would fall back to deploy.yml\'s default, which is staging');
  assert.match(ROLLBACK_CODE, /--ref "\$PROD_BRANCH"/, 'the workflow-dispatch API rejects a commit SHA in --ref; it must be a branch');
  assert.match(ROLLBACK_CODE, /-f sha="\$PRIOR_SHA"/, 'the rollback target commit therefore travels as an input');
  assert.doesNotMatch(ROLLBACK_CODE, /--ref "\$\{?PRIOR_SHA/, 'dispatching --ref <sha> is the bug this replaced');
});

test('deploy.yml accepts that sha input, validates it, and stamps it as the live GIT_SHA', () => {
  assert.match(DEPLOY, /^\s{6}sha:$/m, 'deploy.yml must expose the rollback-target input the guard passes');
  assert.match(DEPLOY, /\^\[0-9a-f\]\{40\}\$/, 'the input reaches actions/checkout `ref:`, so it must be validated as a bare commit id first');
  assert.match(DEPLOY, /--var GIT_SHA:\$\{\{ steps\.ref\.outputs\.deploy_sha \}\}/,
    'a rollback that stamped the branch tip instead of the deployed commit would make /health lie about what is live');
  assert.match(DEPLOY, /EXPECT_SHA:\s*\$\{\{ steps\.ref\.outputs\.deploy_sha \}\}/,
    "deploy.yml's own post-deploy verify must check the commit it actually deployed");
});

test('the rollback is idempotent: it does not re-dispatch a SHA that is already live (no unbounded guard→deploy→guard loop)', () => {
  assert.match(ROLLBACK_CODE, /LIVE_SHA/, 'the currently-live sha must be read before dispatching');
  assert.match(ROLLBACK_CODE, /\[ "\$LIVE_SHA" = "\$PRIOR_SHA" \]/, 'equal means there is nothing to roll back to');
  assert.match(ROLLBACK_CODE, /exit 0/, 'that case must be a clean skip, not another dispatch');
});
