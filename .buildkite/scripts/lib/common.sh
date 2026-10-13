#!/usr/bin/env bash
# Shared helpers for .buildkite/scripts/*.sh. SOURCED by every step script, never run directly.
#
# Same shape as the wave-foundation Buildkite port's lib/common.sh (verbatim gates + a summary), cut
# down to what this repo's running steps use. No running step here holds a credential.
#
# Contract every step script inherits from here:
#   - `set -euo pipefail`, and never `set -x` (xtrace would print expanded values into the build log).
#   - Never print an environment variable's VALUE. Errors name the variable, never its contents.
#   - BUILDKITE_BRANCH / BUILDKITE_MESSAGE are untrusted data: never eval'd, never interpolated into a
#     command string.
#   - Temp dirs are job-local and removed on exit.
#   - Gates are the VERBATIM `run:` bodies of the GitHub Actions steps they replace (.buildkite/gates/),
#     each run as `bash -e <file>` (the GH default shell). A failing gate never stops the other gates of
#     the step: every gate runs, then bk_gates_summary prints one verdict line per gate and fails the
#     step if any blocking gate failed.
set -euo pipefail

BK_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export BK_REPO_ROOT
cd "$BK_REPO_ROOT"

# Least privilege: no step of this public repo declares a secret, and no gate calls buildkite-agent, so
# nothing credential-shaped belongs in the environment. Drop every exported name that looks like one
# (the agent's own job token included) before any gate runs. Names only; values are never read.
while IFS= read -r _bk_name; do
  case "$_bk_name" in
    *TOKEN* | *SECRET* | *PASSWORD* | *PRIVATE_KEY* | *API_KEY* | *_PAT | *ACCOUNT_ID* | *AUTH*) unset "$_bk_name" ;;
  esac
done < <(compgen -e)
unset _bk_name

_bk_cleanup_paths=()
_bk_failed=()
_bk_passed=()
_bk_advisory=()
_bk_skipped=()
_bk_last_rc=0

bk_cleanup_on_exit() {
  local p
  for p in "${_bk_cleanup_paths[@]+"${_bk_cleanup_paths[@]}"}"; do
    rm -rf -- "$p"
  done
}
trap bk_cleanup_on_exit EXIT

bk_section() { printf -- '--- %s\n' "$*"; }
bk_err() { printf 'error: %s\n' "$*" >&2; }
bk_warn() { printf 'warning: %s\n' "$*" >&2; }

# bk_mktemp_dir <var>: job-local temp dir, removed on exit, path stored in <var>.
bk_mktemp_dir() {
  local __dir
  __dir="$(mktemp -d "${TMPDIR:-/tmp}/bk.XXXXXX")"
  _bk_cleanup_paths+=("$__dir")
  printf -v "$1" '%s' "$__dir"
}

# The gates may write into the checkout; refuse to run on a developer machine.
bk_require_buildkite() {
  if [[ "${BUILDKITE:-}" != "true" ]]; then
    bk_err "these steps run only inside a Buildkite job (BUILDKITE=true); refusing to modify this checkout"
    exit 1
  fi
}

# bk_require_tools <tool>...: every tool must already be on PATH (the guest installs nothing ad hoc).
bk_require_tools() {
  local tool missing=0
  for tool in "$@"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      bk_err "required tool '$tool' is not on PATH (CI image prerequisite, see .buildkite/README.md)"
      missing=1
    fi
  done
  return "$missing"
}

# bk_use_python <major.minor>: put that Python first on PATH (what actions/setup-python gave the GH
# job), resolved through the image's mise. Falls back to the default python3 with a warning.
bk_use_python() {
  local want="$1" dir=""
  if command -v mise >/dev/null 2>&1; then
    dir="$(cd / && mise where "python@${want}" 2>/dev/null || true)"
  fi
  if [[ -n "$dir" && -x "$dir/bin/python3" ]]; then
    PATH="$dir/bin:$PATH"
    export PATH
  else
    bk_warn "python ${want} not found through mise; using the default python3"
  fi
  bk_require_tools python3 || return 1
  printf 'python: %s\n' "$(python3 --version 2>&1)"
}

# bk_gate_flags <file>: `-e` by default, `-eo pipefail` when the GH step set `shell: bash`.
bk_gate_flags() {
  if grep -qx '# gh-shell: bash' "$1"; then printf -- '-eo pipefail'; else printf -- '-e'; fi
}

# bk_gate_header <file> <key>: values of the `# <key>: ` lines in the gate's LEADING comment block.
bk_gate_header() {
  awk -v k="# $2: " '!/^#/ { exit } index($0, k) == 1 { print substr($0, length(k) + 1) }' "$1"
}

# bk_gate_workdir <file> <var>: the repo root, or the GH `working-directory` the header records. It
# must be a relative path to an existing directory inside the checkout; anything else refuses the gate.
bk_gate_workdir() {
  local __wd __dir __root
  __wd="$(bk_gate_header "$1" gh-working-directory)"
  __root="$(cd "$BK_REPO_ROOT" && pwd -P)"
  if [[ -z "$__wd" ]]; then
    printf -v "$2" '%s' "$__root"
    return 0
  fi
  if [[ "$__wd" == /* || "/$__wd/" == */../* || "$__wd" == *$'\n'* || ! -d "$__root/$__wd" ]]; then
    return 1
  fi
  __dir="$(cd "$__root/$__wd" && pwd -P)" || return 1
  [[ "$__dir/" == "$__root/"* ]] || return 1
  printf -v "$2" '%s' "$__dir"
}

# bk_gate <label> <gate file> [advisory]: run one verbatim gate in its GH working directory with the
# step's literal GH `env:` (`# gh-env: NAME=value` header lines). Never aborts the step; records the
# verdict (and sets _bk_last_rc) for bk_gates_summary.
bk_gate() {
  local label="$1" file="$2" mode="${3:-blocking}" rc=0 path dir kv
  local -a envs=()
  path="$BK_REPO_ROOT/.buildkite/gates/$file"
  if [[ ! -f "$path" ]]; then
    bk_err "gate file .buildkite/gates/$file is missing"
    _bk_failed+=("$label (gate file missing)")
    _bk_last_rc=1
    return 0
  fi
  if ! bk_gate_workdir "$path" dir; then
    bk_err "gate file .buildkite/gates/$file: gh-working-directory is not a directory inside the checkout"
    _bk_failed+=("$label (bad working directory)")
    _bk_last_rc=1
    return 0
  fi
  while IFS= read -r kv; do
    if [[ ! "$kv" =~ ^[A-Z_][A-Z0-9_]*= ]]; then
      bk_err "gate file .buildkite/gates/$file: a gh-env header line is not NAME=value"
      _bk_failed+=("$label (bad gh-env header)")
      _bk_last_rc=1
      return 0
    fi
    envs+=("$kv")
  done < <(bk_gate_header "$path" gh-env)
  bk_section "$label"
  # shellcheck disable=SC2046 # the flags are fixed words, split on purpose
  (cd "$dir" && env ${envs[@]+"${envs[@]}"} bash $(bk_gate_flags "$path") "$path") || rc=$?
  _bk_last_rc="$rc"
  bk_record_gate "$label" "$rc" "$mode"
}

bk_record_gate() {
  local label="$1" rc="$2" mode="$3"
  if [[ "$rc" -eq 0 ]]; then
    _bk_passed+=("$label")
  elif [[ "$mode" == "advisory" ]]; then
    _bk_advisory+=("$label (exit $rc)")
    printf '^^^ +++\n'
    bk_warn "$label failed but is advisory on GitHub (continue-on-error); not failing the step"
  else
    _bk_failed+=("$label (exit $rc)")
    printf '^^^ +++\n'
    bk_err "$label FAILED (exit $rc)"
  fi
}

# bk_gate_fail <label>: record a blocking failure for a setup command that is not a gate file.
bk_gate_fail() { _bk_failed+=("$1"); printf '^^^ +++\n'; bk_err "$1 FAILED"; }

bk_skip() { _bk_skipped+=("$1"); bk_warn "skipped: $1"; }

bk_gates_summary() {
  local g
  bk_section "gate summary"
  for g in "${_bk_passed[@]+"${_bk_passed[@]}"}"; do printf '  pass      %s\n' "$g"; done
  for g in "${_bk_advisory[@]+"${_bk_advisory[@]}"}"; do printf '  advisory  %s\n' "$g"; done
  for g in "${_bk_skipped[@]+"${_bk_skipped[@]}"}"; do printf '  skipped   %s\n' "$g"; done
  for g in "${_bk_failed[@]+"${_bk_failed[@]}"}"; do printf '  FAIL      %s\n' "$g"; done
  if [[ "${#_bk_failed[@]}" -gt 0 ]]; then
    printf '^^^ +++\n'
    bk_err "${#_bk_failed[@]} blocking gate(s) failed"
    exit 1
  fi
  printf 'all blocking gates passed (%s pass, %s advisory, %s skipped)\n' "${#_bk_passed[@]}" "${#_bk_advisory[@]}" "${#_bk_skipped[@]}"
}
