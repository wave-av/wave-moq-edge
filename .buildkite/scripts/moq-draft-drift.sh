#!/usr/bin/env bash
# Buildkite step moq-draft-drift: replaces GitHub Actions moq-draft-drift.yml `drift` (PR, push to main,
# and the weekly Monday 06:00 UTC leg, which is the `moq-draft-drift-weekly` schedule in wave-ci.json).
# The gate is the verbatim `run:` body under .buildkite/gates/ (see lib/common.sh for the contract).
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
bk_require_buildkite
bk_require_tools git grep
bk_gate 'MoQ Transport draft version drift' moq-draft-drift.drift.02-run-drift-check.gate
bk_gates_summary
