#!/usr/bin/env bash
# check-moq-draft-version.sh — drift guard for IETF MoQ Transport draft version
#
# Source of truth: wrangler.toml [env.production.vars] MOQ_DRAFT_VERSION
#
# Failure modes blocked:
# 1. wrangler.toml drifts below the documented IETF current (CURRENT_DRAFT_NUM below).
# 2. Any file outside the allowlist references draft-00..draft-06 in a way that
#    looks like an advertised/preferred version (allowlist preserves the
#    negotiation matrix that legitimately mentions draft-07 as the floor).
#
# Run:
#   bash scripts/check-moq-draft-version.sh           # advisory
#   bash scripts/check-moq-draft-version.sh --ci      # CI mode (exit 1 on drift)

set -euo pipefail
CI_MODE=0
if [[ "${1:-}" == "--ci" ]]; then CI_MODE=1; fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

CURRENT_DRAFT_NUM=18  # IETF current draft (draft-ietf-moq-transport-18, dated 2026-05-12)

WRANGLER="wrangler.toml"
if [[ ! -f "$WRANGLER" ]]; then
  echo "FAIL: source-of-truth missing: $WRANGLER"
  [[ "$CI_MODE" -eq 1 ]] && exit 1
  exit 0
fi

DECLARED=$(grep -E '^MOQ_DRAFT_VERSION' "$WRANGLER" | grep -oE '"[0-9]+"' | head -1 | tr -d '"')
if [[ -z "$DECLARED" ]]; then
  echo "FAIL: could not parse MOQ_DRAFT_VERSION from $WRANGLER"
  [[ "$CI_MODE" -eq 1 ]] && exit 1
  exit 0
fi

if [[ "$DECLARED" -lt "$CURRENT_DRAFT_NUM" ]]; then
  echo "FAIL: wrangler.toml MOQ_DRAFT_VERSION=$DECLARED, expected >= $CURRENT_DRAFT_NUM"
  echo "  Update wrangler.toml + index.ts + README.md and re-run."
  echo "  Verify latest at https://datatracker.ietf.org/doc/draft-ietf-moq-transport/"
  [[ "$CI_MODE" -eq 1 ]] && exit 1
  exit 0
fi

# Allowlist: legitimate negotiation refs to draft-07 stay, plus this script + research notes
ALLOWLIST_REGEX='draft-07 \.\. draft-18|draft-07,draft-08|"draft-07"|7,8,9|MOQ_DRAFT_SUPPORTED|check-moq-draft-version\.sh|CHANGELOG|negotiation range'

VIOLATIONS=$(grep -rEn 'draft-ietf-moq-transport-0[0-6]|draft-0[0-6][^0-9]' \
  --include='*.md' --include='*.ts' --include='*.toml' --include='*.json' \
  . 2>/dev/null \
  | grep -vE "$ALLOWLIST_REGEX" \
  | grep -v node_modules \
  | grep -v '\.git/' || true)

if [[ -n "$VIOLATIONS" ]]; then
  echo "FAIL: stale MoQ draft refs (draft-00..draft-06) found outside negotiation array:"
  echo "$VIOLATIONS"
  [[ "$CI_MODE" -eq 1 ]] && exit 1
  exit 0
fi

echo "OK: MoQ Transport draft drift check passed (preferred=draft-$DECLARED, IETF current=draft-$CURRENT_DRAFT_NUM)"
exit 0
