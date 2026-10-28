# shellcheck shell=bash
# shellcheck disable=SC2034 # version pins are read by the scripts that source this file
# lib.sh: shared helpers for the wave-moq-edge Buildkite steps. SOURCED, never executed.
#
# Secret handling (deploy/verify steps only):
#   - CF_MOQ_EDGE_DEPLOY_TOKEN arrives ONLY from the host job-secrets broker (Doppler wave/bkjobs),
#     and only for the deploy-*/verify-* step keys of a main push build. Never from pipeline YAML.
#   - moq_token_init moves it into the non-exported _CF_TOKEN and unsets the exported name.
#   - The token is never printed and never placed in argv: curl reads the Authorization header from
#     stdin (--config -) written by the printf builtin; wrangler gets it as CLOUDFLARE_API_TOKEN in the
#     environment of that ONE process.
#   - WAVE_REGISTRY_READ_TOKEN (Verdaccio read, @wave-av/* packages) is handed to exactly one
#     `npm ci --ignore-scripts` process and dropped right after.
set -euo pipefail

MOQ_WRANGLER_VERSION="4.95.0"   # = package-lock.json node_modules/wrangler; honours preview_urls. Bump together.
MOQ_SMOL_TOML_VERSION="1.9.1"
MOQ_ESLINT_VERSION="9.39.4"     # = package-lock.json; bump together
MOQ_TSESLINT_VERSION="8.60.1"   # = package-lock.json; bump together
MOQ_REGISTRY_URL="https://registry.wave-ci.internal:8443/"
MOQ_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOQ_TMP="$(mktemp -d)"
trap 'rm -rf "$MOQ_TMP"; [ -L "$MOQ_REPO_ROOT/node_modules" ] && rm -f "$MOQ_REPO_ROOT/node_modules"; true' EXIT
_CF_TOKEN=""
_CF_ACC=""

moq_log() { printf '%s\n' "$*" >&2; }
moq_die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
moq_section() { printf -- '--- %s\n' "$*"; }

moq_worker() {
  case "$1" in
    staging) echo "moq-edge-staging" ;;
    production) echo "moq-edge-production" ;;
    *) moq_die "unknown env '$1'" ;;
  esac
}
moq_health_url() {
  case "$1" in
    staging) echo "https://moq.staging.wave.online/health" ;;
    production) echo "https://moq.wave.online/health" ;;
    *) moq_die "unknown env '$1'" ;;
  esac
}

# Public-npm-only tool install into a temp dir (no token, no lifecycle scripts, no lockfile of ours).
moq_public_tools() {
  local d="$MOQ_TMP/tools"
  mkdir -p "$d"
  printf '{"name":"bk-moq-tools","private":true}\n' > "$d/package.json"
  printf 'registry=https://registry.npmjs.org/\n' > "$d/.npmrc"
  ( cd "$d" && NPM_CONFIG_USERCONFIG="$d/.npmrc" NPM_CONFIG_GLOBALCONFIG=/dev/null \
      npm install --no-audit --no-fund --ignore-scripts --no-package-lock "$@" >&2 )
  echo "$d/node_modules"
}

# Trusted-build gate for deploy/verify steps (the broker enforces the same; this is the third fence).
moq_require_main_push() {
  [[ "${BUILDKITE_BRANCH:-}" == "main" ]] || moq_die "deploy steps run on branch main only"
  [[ "${BUILDKITE_PULL_REQUEST:-}" == "false" ]] || moq_die "deploy steps never run on a pull request build"
  [[ "${BUILDKITE_SOURCE:-}" == "webhook" ]] || moq_die "deploy steps run on a main push (source webhook) only"
  [[ -z "${BUILDKITE_TAG:-}" ]] || moq_die "deploy steps never run on a tag build"
  [[ "${BUILDKITE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || moq_die "BUILDKITE_COMMIT is not a full SHA"
  git -C "$MOQ_REPO_ROOT" fetch --quiet origin main
  git -C "$MOQ_REPO_ROOT" merge-base --is-ancestor "$BUILDKITE_COMMIT" origin/main \
    || moq_die "commit $BUILDKITE_COMMIT is not on origin/main; refusing a stale or foreign commit"
}

moq_token_init() {
  [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]] || moq_die "CLOUDFLARE_API_TOKEN is set in the job env; only CF_MOQ_EDGE_DEPLOY_TOKEN is accepted"
  [[ -n "${CF_MOQ_EDGE_DEPLOY_TOKEN:-}" ]] \
    || moq_die "CF_MOQ_EDGE_DEPLOY_TOKEN not provided. It must come from the host job-secrets broker (Doppler wave/bkjobs, main-only allowlist row), never from pipeline YAML."
  _CF_TOKEN="$CF_MOQ_EDGE_DEPLOY_TOKEN"
  unset CF_MOQ_EDGE_DEPLOY_TOKEN
}

# cf_api METHOD PATH [JSON_BODY_FILE] -> response body on stdout; non-2xx fails.
cf_api() {
  local method="$1" path="$2" body="${3:-}" out="$MOQ_TMP/cf.out" code
  local args=(-sS -o "$out" -w '%{http_code}' -X "$method" --config -)
  [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' --data-binary "@$body")
  code="$(printf 'header = "Authorization: Bearer %s"\n' "$_CF_TOKEN" \
    | curl "${args[@]}" "https://api.cloudflare.com/client/v4/$path")" || moq_die "cf_api $method $path: curl failed"
  [[ "$code" =~ ^2 ]] || { moq_log "cf_api $method $path -> HTTP $code"; return 1; }
  cat "$out"
}

# json_get EXPR: evaluate a JS expression over parsed stdin JSON (bound to `j`), print the result.
json_get() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=('"$1"');if(v===undefined||v===null)process.exit(3);process.stdout.write(String(v)+"\n")})'; }

# The narrow token is scoped to ONE account; resolve it rather than keep the id in the public tree.
moq_account_init() {
  _CF_ACC="$(cf_api GET 'accounts?per_page=5' | json_get 'j.result.length===1 ? j.result[0].id : null')" \
    || moq_die "deploy token must see exactly one Cloudflare account"
}

# Active version id of an env's worker (requires a single version at 100%).
moq_active_version() {
  local w; w="$(moq_worker "$1")"
  cf_api GET "accounts/$_CF_ACC/workers/scripts/$w/deployments" \
    | json_get '(()=>{const d=j.result.deployments[0];return d&&d.versions.length===1&&d.versions[0].percentage===100?d.versions[0].version_id:null})()'
}

# Roll an env back to the version recorded by its deploy step (meta-data moq-prev-version-<env>).
# Note: workers_dev/preview_urls are script-level settings, not part of a version, so a version
# rollback keeps them OFF. That is intended (WAVE-30114..30117).
moq_rollback() {
  local env="$1" w prev body now
  w="$(moq_worker "$env")"
  prev="$(buildkite-agent meta-data get "moq-prev-version-$env" 2>/dev/null || true)"
  [[ "$prev" =~ ^[0-9a-f-]{36}$ ]] || moq_die "ROLLBACK IMPOSSIBLE for $env: no recorded previous version. Roll back by hand (see .buildkite/README.md)."
  moq_section ":leftwards_arrow_with_hook: rolling $env ($w) back to $prev"
  body="$MOQ_TMP/rollback.json"
  printf '{"strategy":"percentage","versions":[{"percentage":100,"version_id":"%s"}],"annotations":{"workers/message":"BK rollback build %s"}}\n' \
    "$prev" "${BUILDKITE_BUILD_NUMBER:-?}" > "$body"
  cf_api POST "accounts/$_CF_ACC/workers/scripts/$w/deployments" "$body" >/dev/null \
    || moq_die "ROLLBACK FAILED for $env: redeploy $prev by hand: wrangler rollback $prev --env $env"
  now="$(moq_active_version "$env" || true)"
  [[ "$now" == "$prev" ]] || moq_die "ROLLBACK UNCONFIRMED for $env: active=$now expected=$prev"
  buildkite-agent annotate --style error --context "rollback-$env" "Rolled $env back to $prev (build ${BUILDKITE_BUILD_NUMBER:-?})" || true
  moq_log "rollback of $env to $prev confirmed"
}

# Deterministic install for the deploy bundle. @wave-av/* resolve from Verdaccio; the lockfile's
# GitHub Packages URLs are rewritten in the job checkout to the Verdaccio tarball path. Integrity
# hashes are untouched, so a tarball that differs from the locked one fails the install.
moq_npm_ci_deploy() {
  [[ -n "${WAVE_REGISTRY_READ_TOKEN:-}" ]] || moq_die "WAVE_REGISTRY_READ_TOKEN not provided by the broker (needed for @wave-av/* packages)"
  local tok="$WAVE_REGISTRY_READ_TOKEN"; unset WAVE_REGISTRY_READ_TOKEN
  local npmrc="$MOQ_TMP/npmrc"
  # shellcheck disable=SC2016 # literal ${WAVE_REGISTRY_READ_TOKEN}: npm expands it at request time
  printf '%s\n' "@wave-av:registry=$MOQ_REGISTRY_URL" \
    '//registry.wave-ci.internal:8443/:_authToken=${WAVE_REGISTRY_READ_TOKEN}' > "$npmrc"
  chmod 600 "$npmrc"
  ( cd "$MOQ_REPO_ROOT" && node -e '
      const fs=require("fs");const p="package-lock.json";const l=JSON.parse(fs.readFileSync(p,"utf8"));
      const re=/^https:\/\/npm\.pkg\.github\.com\/download\/@wave-av\/([^/]+)\/([^/]+)\/[0-9a-f]+$/;
      for(const [k,v] of Object.entries(l.packages||{})){const m=v.resolved&&v.resolved.match(re);
        if(m)v.resolved=process.argv[1]+"@wave-av/"+m[1]+"/-/"+m[1]+"-"+m[2]+".tgz";}
      fs.writeFileSync(p,JSON.stringify(l,null,2)+"\n");' "$MOQ_REGISTRY_URL" )
  ( cd "$MOQ_REPO_ROOT" && WAVE_REGISTRY_READ_TOKEN="$tok" NPM_CONFIG_USERCONFIG="$npmrc" NPM_CONFIG_GLOBALCONFIG=/dev/null \
      npm ci --ignore-scripts --no-audit --no-fund )
  tok=""; rm -f "$npmrc"
  ( cd "$MOQ_REPO_ROOT" && npm rebuild )
  local v; v="$(node -p 'require(process.argv[1]).version' "$MOQ_REPO_ROOT/node_modules/wrangler/package.json")"
  [[ "$v" == "$MOQ_WRANGLER_VERSION" ]] || moq_die "wrangler $v installed, expected pinned $MOQ_WRANGLER_VERSION"
}
