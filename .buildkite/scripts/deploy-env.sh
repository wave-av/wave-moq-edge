#!/usr/bin/env bash
# deploy-env.sh <staging|production>: called only by deploy-staging.sh / deploy-production.sh.
# 1. trusted-build gate (main push, commit on origin/main); 2. record the active version as
# build meta-data moq-prev-version-<env> (the rollback target); 3. npm ci (Verdaccio, token for that
# one process only); 4. wrangler deploy --env <env>. A failed deploy rolls back to the recorded version.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
ENV_NAME="${1:-}"
WORKER="$(moq_worker "$ENV_NAME")"
moq_require_main_push
moq_token_init
moq_account_init

moq_section "record active version of $WORKER"
prev="$(moq_active_version "$ENV_NAME")" || moq_die "cannot read a single 100% active version for $WORKER; refusing to deploy without a rollback target"
buildkite-agent meta-data set "moq-prev-version-$ENV_NAME" "$prev"
echo "previous active version ($ENV_NAME): $prev"
buildkite-agent annotate --style info --context "prev-$ENV_NAME" "$ENV_NAME rollback target: \`$prev\` (wrangler rollback $prev --env $ENV_NAME)" || true

moq_section "npm ci (bundle deps)"
moq_npm_ci_deploy

moq_section ":rocket: wrangler $MOQ_WRANGLER_VERSION deploy --env $ENV_NAME"
cd "$MOQ_REPO_ROOT"
if ! CLOUDFLARE_API_TOKEN="$_CF_TOKEN" CLOUDFLARE_ACCOUNT_ID="$_CF_ACC" \
     ./node_modules/.bin/wrangler deploy --env "$ENV_NAME" --var "GIT_SHA:$BUILDKITE_COMMIT" \
       --message "BK build ${BUILDKITE_BUILD_NUMBER:-?} ${BUILDKITE_COMMIT}"; then
  now="$(moq_active_version "$ENV_NAME" || true)"
  if [[ -n "$now" && "$now" != "$prev" ]]; then moq_rollback "$ENV_NAME"; fi
  moq_die "wrangler deploy --env $ENV_NAME failed"
fi
now="$(moq_active_version "$ENV_NAME")" || { moq_rollback "$ENV_NAME"; moq_die "no single active version after deploy"; }
[[ "$now" != "$prev" ]] || moq_die "deploy reported success but the active version is unchanged ($prev)"
buildkite-agent meta-data set "moq-new-version-$ENV_NAME" "$now"
echo "deployed $ENV_NAME: $prev -> $now"
