#!/usr/bin/env bash
# wrangler config check (runs on PR builds, no credential):
#   1. staging + production set workers_dev = false and preview_urls = false and have a zone route
#      (WAVE-30114..30117: the edge is reachable only through the WAF-fronted zone route);
#   2. `wrangler deploy --dry-run --no-bundle` parses and validates each env with the pinned wrangler.
#      --no-bundle because the private @wave-av/* packages are not available to PR builds; the real
#      bundle is built by the deploy step.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
nm="$(moq_public_tools "wrangler@$MOQ_WRANGLER_VERSION" "smol-toml@$MOQ_SMOL_TOML_VERSION")"
moq_section "assert workers_dev/preview_urls off + route set (staging, production)"
NODE_PATH="$nm" node "$MOQ_REPO_ROOT/.buildkite/scripts/assert-config.mjs" "$MOQ_REPO_ROOT/wrangler.toml" "$nm/smol-toml/dist/index.js"
for env in staging production; do
  moq_section ":cloudflare: wrangler $MOQ_WRANGLER_VERSION deploy --dry-run --no-bundle --env $env"
  ( cd "$MOQ_REPO_ROOT" && "$nm/.bin/wrangler" deploy --dry-run --no-bundle --env "$env" --outdir "$MOQ_TMP/out-$env" )
done
