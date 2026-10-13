#!/usr/bin/env bash
# Buildkite step foundation-gate: replaces GitHub Actions foundation-gate.yml `gate`, which calls the
# inlined _checks.yml jobs `checks` (secret scan, file-size), `skill-validate` and `verify-routes`.
# The gates are the verbatim `run:` bodies under .buildkite/gates/ (see lib/common.sh for the contract).
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
bk_require_buildkite
bk_require_tools git grep awk

bk_gate 'checks: secret scan (fail-closed, allowlist-aware)' checks.checks.02-secret-scan-fail-closed-allowlist-aware.gate
bk_gate 'checks: file-size gate (max 800 lines)' checks.checks.03-file-size-gate.gate

# skill-validate: GH set up Python 3.12 and ran `pip install pyyaml`. The image bakes PyYAML into
# every mise Python; a job-local venv (PyPI egress) is the fallback when this one lacks it.
if bk_use_python 3.12; then
  if ! python3 -c 'import yaml' >/dev/null 2>&1; then
    _venv=""
    bk_mktemp_dir _venv
    if python3 -m venv "$_venv/v" && "$_venv/v/bin/python3" -m pip install --quiet --disable-pip-version-check pyyaml; then
      PATH="$_venv/v/bin:$PATH"
      export PATH
    else
      bk_gate_fail 'skill-validate: install pyyaml into a job-local venv'
    fi
  fi
  bk_gate 'skill-validate: skill frontmatter gate' checks.skill-validate.04-skill-frontmatter-gate.gate
else
  bk_gate_fail 'skill-validate: python3 not available'
fi

bk_gate 'verify-routes: URL convention gate' checks.verify-routes.02-url-convention-gate.gate
bk_gates_summary
