#!/usr/bin/env bash
# rollback-to-prior-good.sh — the GAM guard's rollback executor.
#
# Extracted from the inline `rollback-command:` string in gam-post-deploy-guard.yml so the three
# non-obvious safety properties below are readable, reviewable and unit-testable instead of being
# a folded YAML one-liner.
#
# 1. THE DISPATCH REF MUST BE A BRANCH, NOT A SHA. GitHub's workflow-dispatch API documents `ref`
#    as "a branch or tag name"; handing it a commit SHA is rejected (422 "No ref found"), so the
#    original `gh workflow run --ref "$PRIOR_SHA"` would have failed every time it mattered. The
#    dispatch therefore targets the PRODUCTION BRANCH and carries the rollback target in deploy.yml's
#    `sha` input, which that workflow checks out and stamps as GIT_SHA.
#
# 2. IDEMPOTENCY / NO REDISPATCH LOOP. Every completed deploy.yml run re-triggers this guard via
#    `workflow_run`. If the guard dispatched unconditionally, a persistently-unreachable canary (or
#    a prior-good SHA that is itself broken) would dispatch → complete → guard → dispatch … with no
#    cap. So: if the prior-good SHA is ALREADY the SHA production reports live, there is nothing to
#    roll back to and the dispatch is skipped.
#
# 3. IT ALSO CATCHES "NOTHING WAS EVER SHIPPED". When deploy.yml fails BEFORE `wrangler deploy`
#    (npm ci, the reachability guard, a missing token), production keeps serving the previous
#    bundle. The canary looks for the new SHA, misses it, and reports `regressed` — but a rollback
#    would be a no-op deploy of what is already live. The same live-SHA comparison in (2) turns
#    that into an explicit, logged skip rather than a superfluous production deploy.
#
# Usage: rollback-to-prior-good.sh <owner/repo> <workflow-file> <exclude-run-id> <failed-sha>
#                                  <production-branch> <health-url>
set -euo pipefail

REPO="${1:?owner/repo required}"
WORKFLOW="${2:?workflow file required}"
EXCLUDE_RUN_ID="${3-}"
FAILED_SHA="${4-}"
PROD_BRANCH="${5:?production branch required}"
HEALTH_URL="${6:?health url required}"

ACTION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RESOLVER_ARGS=("$REPO" "$WORKFLOW" "$EXCLUDE_RUN_ID")
if [ -n "$FAILED_SHA" ]; then RESOLVER_ARGS+=(--exclude-sha "$FAILED_SHA"); fi
RESOLVER_ARGS+=(--prod-branches "$PROD_BRANCH")

PRIOR_SHA="$(node "${ACTION_DIR}/resolve-prior-good-sha.mjs" "${RESOLVER_ARGS[@]}")"
PRIOR_SHA="$(printf '%s' "$PRIOR_SHA" | tr -d '[:space:]')"
if [ -z "$PRIOR_SHA" ]; then
  echo "::error::resolver produced no prior-good SHA — refusing to dispatch a rollback with no target"
  exit 1
fi

# Best-effort read of what production currently reports. A failure here is NOT fatal: an
# unreachable /health is exactly the regression we may be rolling back from, and an empty
# LIVE_SHA simply means the comparison below cannot short-circuit the dispatch.
LIVE_SHA="$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(d).sha||""))}catch{process.stdout.write("")}})' \
  || true)"
LIVE_SHA="$(printf '%s' "$LIVE_SHA" | tr -d '[:space:]')"

if [ -n "$LIVE_SHA" ] && [ "$LIVE_SHA" = "$PRIOR_SHA" ]; then
  echo "prior-good sha ${PRIOR_SHA} is ALREADY the sha production reports live — nothing to roll back to; skipping dispatch (idempotent, and this is also the 'deploy failed before it shipped anything' case)."
  exit 0
fi

echo "rolling back to ${PRIOR_SHA} (production currently reports '${LIVE_SHA:-unknown}') via ${WORKFLOW} on ${PROD_BRANCH}"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$PROD_BRANCH" -f env=production -f sha="$PRIOR_SHA"
