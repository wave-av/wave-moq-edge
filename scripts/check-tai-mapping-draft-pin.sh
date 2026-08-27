#!/usr/bin/env bash
# check-tai-mapping-draft-pin.sh — drift guard for the E1-TAI-BRIDGE Object Properties semantics pin.
#
# Distinct from scripts/check-moq-draft-version.sh, which guards the relay's NEGOTIATED ALPN
# (moqt-18). This script guards the revision whose Object Properties TEXT (§2.5 forwarding/caching
# semantics) src/st2110-timing-properties.ts and src/tai-group-mapping.ts are written against. See
# src/PIN-DECISION.md for the full "why 19, while the relay still speaks 18" reasoning.
#
# Prints PINNED and LIVE-KNOWN as two SEPARATE values on purpose (E1-TAI-BRIDGE P1 done-check: "the
# drift check runs and prints the pinned revision and the live revision as separate values, so
# agreement and disagreement are both visible"). Both are honest hand-maintained constants, not a
# network fetch — this build runs under a no-external-contact rule (see src/PIN-DECISION.md's "the
# honest gap" note). Run with --ci to fail the build on disagreement.
#
# Run:
#   bash scripts/check-tai-mapping-draft-pin.sh          # advisory
#   bash scripts/check-tai-mapping-draft-pin.sh --ci      # CI mode (exit 1 on drift)

set -euo pipefail
CI_MODE=0
if [[ "${1:-}" == "--ci" ]]; then CI_MODE=1; fi

# The revision this mapping's Object Properties behavioral claims are grounded in. Decided
# 2026-08-21 — see src/PIN-DECISION.md.
PINNED_DRAFT=19

# The revision believed to be IETF-current, last manually checked 2026-08-22 (per the epic's
# grounding note, governance/plans/volumetric-delivery-proof/E1-TAI-BRIDGE.md). NOT re-fetched by
# this script (no-external-contact build phase) — update this constant + the date below the next
# time someone checks https://datatracker.ietf.org/doc/draft-ietf-moq-transport/ with network access.
LIVE_KNOWN_DRAFT=19
LIVE_KNOWN_CHECKED_ON="2026-08-22"

echo "pinned  = draft-ietf-moq-transport-${PINNED_DRAFT} (src/PIN-DECISION.md)"
echo "live    = draft-ietf-moq-transport-${LIVE_KNOWN_DRAFT} (manually checked ${LIVE_KNOWN_CHECKED_ON}; not network-verified this run)"

if [[ "$PINNED_DRAFT" -ne "$LIVE_KNOWN_DRAFT" ]]; then
  echo "DRIFT: pinned ($PINNED_DRAFT) != live-known ($LIVE_KNOWN_DRAFT). Re-read src/PIN-DECISION.md, decide whether to re-pin, and update both this script and the doc."
  [[ "$CI_MODE" -eq 1 ]] && exit 1
  exit 0
fi

echo "OK: TAI mapping draft pin agrees with the last manually-checked live revision."
exit 0
