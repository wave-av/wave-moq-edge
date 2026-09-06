#!/usr/bin/env node
// resolve-prior-good-sha.mjs — GAM rollback target resolver.
//
// The rollback-command a gam-post-deploy-guard workflow runs needs a SHA to re-dispatch the
// deploy workflow at. The naive `git rev-parse HEAD~1` heuristic used by the earlier pilot spoke
// rolls back exactly one COMMIT, which is fine for a low-traffic static surface but wrong for a
// path-filtered, high-traffic, money-critical deploy: several non-deploying commits can sit
// between two real deploys, so HEAD~1 may not be a commit that was ever actually live.
//
// This resolves the LAST SUCCESSFUL PRODUCTION RUN of the named workflow and prints that run's
// head_sha — the commit that was last PROVEN live by this same workflow succeeding.
//
// PRODUCTION SCOPING (review sweep, 2026-09-06) — the defect this closes: deploy.yml runs on
// `push` to main, master AND staging, and also on `workflow_dispatch` with an `env` choice. The
// first version of this resolver filtered only on `status=success` and "not the excluded run id",
// so the most recent successful run it found was, in almost any real failure window, a STAGING
// push — and the guard would then re-dispatch that staging commit as a "production rollback".
// The filter is now positive and fail-closed:
//   · head_branch must be in --prod-branches (default main,master) — the branches deploy.yml maps
//     to `production`;
//   · event must be `push` — a push to main/master is production BY CONSTRUCTION in deploy.yml's
//     branch→env mapping, whereas a `workflow_dispatch` run on main may have selected `staging`
//     and carries no distinguishable signal in the runs API. Ambiguous ⇒ excluded, never guessed.
//   · the run must be OLDER than the run being rolled back FROM (by created_at when that run is
//     visible in the page, otherwise by run id) — a run that started AFTER the regression is not
//     a "prior good" target, it is a forward roll.
//   · --exclude-sha drops every run at the just-regressed commit, not merely the one triggering
//     run id: the same bad commit can have several successful deploy runs, and re-dispatching it
//     would ship the regression again.
//
// READ-ONLY: one `gh api` GET call, arguments passed as argv (never through a shell). It never
// dispatches a workflow, never touches production.
//
// Usage: node resolve-prior-good-sha.mjs <owner/repo> <workflow-file.yml> [exclude-run-id]
//          [--exclude-sha <sha>] [--prod-branches main,master]
// Exit: 0 = printed a SHA to stdout · 1 = no prior successful production run found (refuse to
//       guess) · 2 = usage/API error
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const positional = [];
let excludeSha = null;
let prodBranches = ["main", "master"];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--exclude-sha") { excludeSha = argv[++i] || null; }
  else if (argv[i] === "--prod-branches") { prodBranches = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean); }
  else positional.push(argv[i]);
}
const [repo, workflowFile, excludeRunId] = positional;
if (!repo || !workflowFile) {
  console.error("usage: resolve-prior-good-sha.mjs <owner/repo> <workflow-file.yml> [exclude-run-id] [--exclude-sha <sha>] [--prod-branches main,master]");
  process.exit(2);
}
if (!prodBranches.length) {
  console.error("--prod-branches must name at least one branch — refusing to consider every branch a production deploy");
  process.exit(2);
}

function gh(path) {
  const out = execFileSync("gh", ["api", path], {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
  });
  return JSON.parse(out);
}

try {
  const apiPath = `repos/${repo}/actions/workflows/${workflowFile}/runs?status=success&event=push&per_page=30`;
  const data = gh(apiPath);
  const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
  const excludeId = excludeRunId ? String(excludeRunId) : null;

  // Anchor: the run we are rolling back FROM. When it is on this page we can compare timestamps;
  // otherwise fall back to comparing numeric run ids (monotonically increasing per repo).
  const anchor = excludeId ? runs.find((r) => String(r.id) === excludeId) : null;
  const anchorTime = anchor && anchor.created_at ? Date.parse(anchor.created_at) : NaN;
  const anchorId = excludeId ? Number(excludeId) : NaN;

  const isOlderThanAnchor = (r) => {
    if (!excludeId) return true;
    if (Number.isFinite(anchorTime) && r.created_at) return Date.parse(r.created_at) < anchorTime;
    return Number.isFinite(anchorId) ? Number(r.id) < anchorId : true;
  };

  const prior = runs.find((r) =>
    String(r.id) !== excludeId &&
    // `event=push` is also asked of the API above; re-assert it locally so a future change to the
    // query string cannot silently widen the candidate set.
    r.event === "push" &&
    prodBranches.includes(r.head_branch) &&
    r.head_sha &&
    (!excludeSha || r.head_sha !== excludeSha) &&
    isOlderThanAnchor(r),
  );

  if (!prior) {
    console.error(`no prior successful PRODUCTION run of ${workflowFile} found in ${repo} (branches: ${prodBranches.join("/")}, event: push, excluding run ${excludeId}${excludeSha ? ` and sha ${excludeSha}` : ""}) — refusing to guess a rollback target`);
    process.exit(1);
  }
  process.stdout.write(prior.head_sha + "\n");
  process.exit(0);
} catch (err) {
  console.error(`gh api failed: ${String(err && err.message || err).slice(0, 300)}`);
  process.exit(2);
}
