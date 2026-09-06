#!/usr/bin/env node
// resolve-prior-good-sha.mjs — GAM rollback target resolver.
//
// The rollback-command a gam-post-deploy-guard workflow runs needs a SHA to re-dispatch the
// deploy workflow at. The naive `git rev-parse HEAD~1` heuristic (used by the wave-changelog-edge
// pilot) rolls back exactly one COMMIT, which is fine for a low-traffic static spoke but wrong for
// a path-filtered, high-traffic, money-critical deploy: several non-deploying commits can sit
// between two real deploys, so HEAD~1 may not be a commit that was ever actually live.
//
// This resolves the LAST SUCCESSFUL RUN of the named workflow, EXCLUDING the run that triggered
// this guard (which just failed its canary and is the run being rolled back FROM), and prints that
// run's head_sha — the commit that was last PROVEN live by this same workflow succeeding.
//
// READ-ONLY: one `gh api` GET call. It never dispatches a workflow, never touches production.
//
// Usage: node resolve-prior-good-sha.mjs <owner/repo> <workflow-file.yml> <exclude-run-id>
// Exit: 0 = printed a SHA to stdout · 1 = no prior successful run found (refuse to guess) ·
//       2 = usage/API error
import { execFileSync } from "node:child_process";

const [repo, workflowFile, excludeRunId] = process.argv.slice(2);
if (!repo || !workflowFile) {
  console.error("usage: resolve-prior-good-sha.mjs <owner/repo> <workflow-file.yml> [exclude-run-id]");
  process.exit(2);
}

function gh(path) {
  const out = execFileSync("gh", ["api", path], {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
  });
  return JSON.parse(out);
}

try {
  const data = gh(`repos/${repo}/actions/workflows/${workflowFile}/runs?status=success&per_page=10`);
  const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
  const excludeId = excludeRunId ? String(excludeRunId) : null;
  const prior = runs.find((r) => String(r.id) !== excludeId);
  if (!prior || !prior.head_sha) {
    console.error(`no prior successful run of ${workflowFile} found in ${repo} (excluding run ${excludeId}) — refusing to guess a rollback target`);
    process.exit(1);
  }
  process.stdout.write(prior.head_sha + "\n");
  process.exit(0);
} catch (err) {
  console.error(`gh api failed: ${String(err && err.message || err).slice(0, 300)}`);
  process.exit(2);
}
