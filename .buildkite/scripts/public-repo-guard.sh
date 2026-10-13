#!/usr/bin/env bash
# Buildkite step public-repo-guard: replaces GitHub Actions public-repo-guard.yml `guard` (published-tree
# scan). The `body-guard` job (PR, issue and comment text) is parked; see .buildkite/README.md.
# The gates are the verbatim `run:` bodies under .buildkite/gates/ (see lib/common.sh for the contract).
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
bk_require_buildkite

# GH downloads gitleaks 8.30.1 (pinned + sha256-checked) and apt-installs ripgrep with sudo. The guest
# has no sudo and installs nothing ad hoc: both come from the CI image, at the same gitleaks version.
GITLEAKS_WANT="8.30.1"
if bk_require_tools gitleaks rg; then
  gl_version="$(gitleaks version 2>/dev/null | tr -d 'v[:space:]')"
  if [[ "$gl_version" != "$GITLEAKS_WANT" ]]; then
    bk_gate_fail "gitleaks ${GITLEAKS_WANT} required (the version GH pins); the image has '${gl_version}'"
  fi
  # content-policy.sh runs `rg -P`, so rg must be built with PCRE2.
  if ! rg --pcre2-version >/dev/null 2>&1; then
    bk_gate_fail 'ripgrep on PATH is built without PCRE2 (content-policy.sh runs rg -P)'
  fi
  bk_gate 'gitleaks (secret scan, published tree)' public-repo-guard.guard.03-gitleaks-secret-scan-published-tree.gate
  bk_warn 'GUARD_PRIVATE_REPOS is not set on Buildkite: the content policy runs without its private-name rule (see .buildkite/README.md)'
  bk_gate 'content policy (internal-leak gate)' public-repo-guard.guard.05-content-policy.gate
  bk_gate 'body policy self-test (fixtures)' public-repo-guard.guard.06-body-policy-self-test-fixtures.gate
else
  bk_gate_fail 'public-repo-guard tools (gitleaks, rg) missing from the image'
fi
bk_gates_summary
