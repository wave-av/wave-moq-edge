// REL-003 review follow-up (non-blocking, defense-in-depth): gam-post-deploy-guard.yml used to
// splice `${{ steps.dispatch.outputs.branch }}` / `${{ steps.target.outputs.run_id }}` directly
// into the `rollback-command:` string, which action.yml then runs via `bash -c
// "${ROLLBACK_COMMAND}"`. The reviewer confirmed this was NOT currently exploitable (branch is
// case-gated to main/master, run_id is a GitHub-generated integer) but flagged it as fragile to a
// future edit that loosens either constraint.
//
// The fix: dedicated `rollback-branch` / `rollback-run-id` inputs are exported as env vars
// (ROLLBACK_BRANCH / ROLLBACK_RUN_ID) BEFORE `bash -c "${ROLLBACK_COMMAND}"` runs, so
// rollback-command references them as a single opaque "$ROLLBACK_BRANCH" shell-variable
// expansion instead of having their raw text woven into the command string at
// workflow-authoring time.
//
// This test extracts the REAL "rollback on regressed-or-refuse" step's run: block from action.yml
// (not a reimplementation — if the block's shape drifts, the anchor regex below fails loudly) and
// proves, with an ACTUAL shell-metacharacter payload, that:
//   1. A malicious ROLLBACK_BRANCH value cannot break out of the command it's substituted into
//      (the env-var-indirection fix — this is the regression this test guards).
//   2. For contrast, the OLD pattern (payload spliced directly into command TEXT, simulating what
//      `${{ }}` interpolation at YAML-authoring time would have produced) DOES execute injected
//      commands — proving the fix changes real behavior, not just cosmetics.
//
// Run: node --test rollback-command-injection.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ACTION_YML = join(__dirname, '..', 'action.yml');

// Extract the rollback step's run: script body, from the "if -z ROLLBACK_COMMAND" guard through
// the final `bash -c "${ROLLBACK_COMMAND}"` line (inclusive) — the part that actually executes
// the caller-supplied command.
function extractRollbackExecBlock() {
  const src = readFileSync(ACTION_YML, 'utf8');
  const start = src.indexOf('if [ -z "${ROLLBACK_COMMAND}" ]');
  const marker = 'bash -c "${ROLLBACK_COMMAND}"';
  const markerAt = src.indexOf(marker, start);
  if (start === -1 || markerAt === -1) {
    throw new Error('could not find the rollback-exec block in action.yml — extraction anchor drifted, fix this test before trusting it');
  }
  return src.slice(start, markerAt + marker.length);
}

// Also assert the action wires ROLLBACK_BRANCH / ROLLBACK_RUN_ID via this step's own `env:` block
// (i.e. from dedicated inputs), not via string-splicing into rollback-command's text anywhere in
// the caller workflow.
test('action.yml exports ROLLBACK_BRANCH / ROLLBACK_RUN_ID via env:, sourced from dedicated inputs', () => {
  const src = readFileSync(ACTION_YML, 'utf8');
  assert.match(src, /ROLLBACK_BRANCH:\s*\$\{\{\s*inputs\.rollback-branch\s*\}\}/);
  assert.match(src, /ROLLBACK_RUN_ID:\s*\$\{\{\s*inputs\.rollback-run-id\s*\}\}/);
});

test('gam-post-deploy-guard.yml passes branch/run_id via rollback-branch / rollback-run-id inputs, not spliced into rollback-command text', () => {
  const guardYml = readFileSync(join(__dirname, '..', '..', '..', 'workflows', 'gam-post-deploy-guard.yml'), 'utf8');
  const withBlockStart = guardYml.indexOf('expect-marker:');
  const rollbackCmdStart = guardYml.indexOf('rollback-command:', withBlockStart);
  assert.notEqual(withBlockStart, -1, 'expect-marker: not found — extraction anchor drifted');
  assert.notEqual(rollbackCmdStart, -1, 'rollback-command: not found — extraction anchor drifted');
  const withBlock = guardYml.slice(withBlockStart, rollbackCmdStart);
  assert.match(withBlock, /rollback-branch:\s*'\$\{\{\s*steps\.dispatch\.outputs\.branch\s*\}\}'/);
  assert.match(withBlock, /rollback-run-id:\s*'\$\{\{\s*steps\.target\.outputs\.run_id\s*\}\}'/);
  const rollbackCmdBlock = guardYml.slice(rollbackCmdStart);
  // The command text itself must reference the shell vars, never the raw GH expression.
  assert.match(rollbackCmdBlock, /\$\{ROLLBACK_BRANCH\}/);
  assert.match(rollbackCmdBlock, /\$\{ROLLBACK_RUN_ID\}/);
  assert.doesNotMatch(rollbackCmdBlock, /steps\.dispatch\.outputs\.branch/);
  assert.doesNotMatch(rollbackCmdBlock, /steps\.target\.outputs\.run_id/);
});

test('real action.yml block: a malicious ROLLBACK_BRANCH value cannot inject a command (env-var indirection holds)', async (t) => {
  const block = extractRollbackExecBlock();
  const marker = `PWNED-${process.pid}-${Date.now()}`;
  const pwnFile = join(os.tmpdir(), `gam-rollback-injection-proof-${marker}.txt`);
  t.after(() => { if (existsSync(pwnFile)) rmSync(pwnFile); });

  // ROLLBACK_COMMAND does exactly what gam-post-deploy-guard.yml's real command does: reference
  // the branch as a shell variable, never inline text.
  const rollbackCommand = 'echo "resolved branch: $ROLLBACK_BRANCH"';
  // A branch name that would break out of a naive double-quoted splice and run an extra command.
  const maliciousBranch = `main"; touch ${pwnFile}; echo "`;

  const { stdout } = await execFileP('bash', ['-c', block], {
    env: {
      ...process.env,
      ROLLBACK_COMMAND: rollbackCommand,
      ROLLBACK_BRANCH: maliciousBranch,
      ROLLBACK_RUN_ID: '123',
      STATE: 'regressed',
    },
  });

  assert.ok(!existsSync(pwnFile), 'injection succeeded — the malicious ROLLBACK_BRANCH value executed as a command, the fix regressed');
  assert.match(stdout, /resolved branch: main"; touch .*; echo "/, 'the malicious value should appear as inert literal text, not be re-parsed as shell syntax');
});

test('control: splicing the SAME payload directly into command TEXT (the OLD pre-fix pattern) DOES execute the injected command — proves the fix changes real behavior', async (t) => {
  const marker = `PWNED-OLD-${process.pid}-${Date.now()}`;
  const pwnFile = join(os.tmpdir(), `gam-rollback-injection-OLD-${marker}.txt`);
  t.after(() => { if (existsSync(pwnFile)) rmSync(pwnFile); });

  const maliciousBranch = `main"; touch ${pwnFile}; echo "`;
  // Simulates the OLD gam-post-deploy-guard.yml pattern: `${{ steps.dispatch.outputs.branch }}`
  // substituted directly into the rollback-command STRING at workflow-authoring time, before
  // bash -c ever sees it — i.e. the payload is baked into the command text itself, not passed as
  // a separate env var.
  const oldStyleRollbackCommand = `echo "resolved branch: ${maliciousBranch}"`;

  await execFileP('bash', ['-c', 'bash -c "${ROLLBACK_COMMAND}"'], {
    env: { ...process.env, ROLLBACK_COMMAND: oldStyleRollbackCommand },
  });

  assert.ok(existsSync(pwnFile), 'expected the OLD text-splicing pattern to execute the injected command (demonstrating what the fix closes) — if this fails, the old pattern was not actually as fragile as documented');
});
