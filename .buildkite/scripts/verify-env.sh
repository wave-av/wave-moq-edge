#!/usr/bin/env bash
# verify-env.sh <staging|production>: called only by verify-staging.sh / verify-production.sh.
# Proves, after the deploy step of THIS build:
#   - the active version is the one this build deployed (meta-data moq-new-version-<env>)
#   - CF subdomain API for the script: enabled=false, previews_enabled=false
#   - https://<worker>.<account-subdomain>.workers.dev/health does NOT return 200
#   - the zone health endpoint returns 200
# Any failure rolls the env back to moq-prev-version-<env> and fails the step.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
ENV_NAME="${1:-}"
WORKER="$(moq_worker "$ENV_NAME")"
HEALTH="$(moq_health_url "$ENV_NAME")"
moq_require_main_push
moq_token_init
moq_account_init

fail() { moq_log "VERIFY FAILED ($ENV_NAME): $*"; moq_rollback "$ENV_NAME"; moq_die "verify $ENV_NAME failed: $*"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" || echo 000; }

want="$(buildkite-agent meta-data get "moq-new-version-$ENV_NAME" 2>/dev/null || true)"
now="$(moq_active_version "$ENV_NAME" || true)"
[[ -n "$want" && "$now" == "$want" ]] || fail "active version '$now' is not this build's deploy '$want'"
echo "active version: $now"

moq_section "CF subdomain settings for $WORKER"
sub_json="$(cf_api GET "accounts/$_CF_ACC/workers/scripts/$WORKER/subdomain")" || fail "subdomain API unreadable"
enabled="$(printf '%s' "$sub_json" | json_get 'j.result.enabled')" || fail "subdomain.enabled missing"
previews="$(printf '%s' "$sub_json" | json_get 'j.result.previews_enabled')" || fail "subdomain.previews_enabled missing"
echo "enabled=$enabled previews_enabled=$previews"
[[ "$enabled" == "false" && "$previews" == "false" ]] || fail "workers.dev or preview URLs still enabled"

acct_sub="$(cf_api GET "accounts/$_CF_ACC/workers/subdomain" | json_get 'j.result.subdomain')" || fail "account workers.dev subdomain unreadable"
WD="https://$WORKER.$acct_sub.workers.dev/health"

moq_section "probe $WD (must not be 200) and $HEALTH (must be 200)"
ok=0
for i in 1 2 3 4 5 6; do
  wd_code="$(http_code "$WD")"; zone_code="$(http_code "$HEALTH")"
  echo "try $i: workers.dev=$wd_code zone=$zone_code"
  if [[ "$wd_code" != "200" && "$zone_code" == "200" ]]; then ok=1; break; fi
  sleep 10
done
[[ "$ok" == "1" ]] || fail "workers.dev=$wd_code (want not 200), $HEALTH=$zone_code (want 200)"
buildkite-agent annotate --style success --context "verify-$ENV_NAME" \
  "$ENV_NAME verified: version \`$now\`, subdomain enabled=false previews_enabled=false, workers.dev /health $wd_code, $HEALTH 200" || true
