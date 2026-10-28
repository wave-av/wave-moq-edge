#!/usr/bin/env bash
# guard-gitleaks — GHA parity with public-repo-guard.yml steps "Install gitleaks
# (pinned + checksum-verified)" + "gitleaks (secret scan — published tree)".
#
# Version pin + SHA-256 copied from the GHA workflow; bump the two together.
# One deliberate change: GHA `sudo install`s to /usr/local/bin. FPC guests must
# not assume sudo, so the verified binary runs from a temp dir instead — same
# scan, smaller footprint.
#
# Fork trust (WAVE-27332): on PR builds NOTHING executes from the PR checkout
# except as scan source. main() first re-execs the base-branch-tip copy of
# THIS script (a fork that rewrites the guard just re-installs the trusted
# copy), then scans the PR worktree with the base-tip canonical
# .gitleaks.toml. Base tip without a config scans with gitleaks built-in
# default rules (teeth guaranteed, zero trust in PR content) plus a loud
# warning. Unresolvable base, missing base script, or missing base-branch
# name all fail closed (exit 2). Main builds run directly with the worktree
# config (HEAD is trusted there). GITLEAKS_BIN, when set, skips the download
# (test seam; CI never sets it).
set -euo pipefail

GITLEAKS_VERSION="8.30.1"
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
SCRIPT_REL_PATH=".buildkite/scripts/guard-gitleaks.sh"

is_pr_build() {
  [[ "${BUILDKITE_PULL_REQUEST:-false}" != "false" && -n "${BUILDKITE_PULL_REQUEST:-}" ]]
}

base_ref() {
  local branch="${BUILDKITE_PULL_REQUEST_BASE_BRANCH:-}"
  if [[ -z "$branch" ]]; then
    echo "guard-gitleaks: PR build without BUILDKITE_PULL_REQUEST_BASE_BRANCH — failing closed" >&2
    return 2
  fi
  echo "origin/${branch}"
}

# trust_self: replace this PR-controlled script with the base-tip copy and
# re-exec it. Caller must already be cd'd into the git repo. Never returns.
# The trusted handoff travels on ARGV (--trusted-work), never the
# environment: pipeline env is PR-influenced, so a GUARD_TRUSTED/GUARD_WORK
# pair from env would let a caller skip trust AND steer the rm -rf trap.
trust_self() {
  local base
  base="$(base_ref)" || exit 2
  git rev-parse --verify --quiet "$base" >/dev/null 2>&1 \
    || { echo "guard-gitleaks: cannot resolve $base — failing closed" >&2; exit 2; }
  git cat-file -e "${base}:${SCRIPT_REL_PATH}" 2>/dev/null \
    || { echo "guard-gitleaks: base $base has no guard script — failing closed" >&2; exit 2; }
  git show "${base}:${SCRIPT_REL_PATH}" > "$WORK/trusted-guard-gitleaks.sh" \
    || { echo "guard-gitleaks: cannot extract trusted guard script — failing closed" >&2; exit 2; }
  # ${1+"$@"}: "$@" under set -u on old bash (macOS 3.2) errors with no args.
  exec bash "$WORK/trusted-guard-gitleaks.sh" --trusted-work "$WORK" ${1+"$@"}
}

# resolve_config: print the config path, or DEFAULTS for built-in rules.
# Uses $WORK (caller sets it). Never prints a PR-controlled path on PR builds.
resolve_config() {
  if ! is_pr_build; then
    echo ".gitleaks.toml"
    return 0
  fi
  local base
  base="$(base_ref)" || return 2
  git rev-parse --verify --quiet "$base" >/dev/null 2>&1 \
    || { echo "guard-gitleaks: cannot resolve $base — failing closed" >&2; return 2; }
  if git cat-file -e "${base}:.gitleaks.toml" 2>/dev/null; then
    git show "${base}:.gitleaks.toml" > "$WORK/base.gitleaks.toml"
    echo "$WORK/base.gitleaks.toml"
  else
    echo "guard-gitleaks: WARNING no .gitleaks.toml at $base — scanning with gitleaks built-in default rules" >&2
    echo "DEFAULTS"
  fi
}

main() {
  # Trusted re-exec arrives as `--trusted-work DIR` on argv (see trust_self).
  # Anything else-shaped (including GUARD_* impostors in env, which are
  # ignored entirely) takes the normal path below.
  local trusted=0
  if [[ "${1:-}" == "--trusted-work" && -n "${2:-}" ]]; then
    # Re-exec'd: cwd is already the repo root (preserved across exec);
    # BASH_SOURCE now points into $WORK so it must NOT re-cd.
    WORK="$2"
    if [[ ! -d "$WORK" || ! -f "$WORK/trusted-guard-gitleaks.sh" ]]; then
      echo "guard-gitleaks: bad --trusted-work dir — failing closed" >&2
      exit 2
    fi
    trusted=1
    shift 2
  else
    if [[ "${1:-}" == "--trusted-work" ]]; then
      echo "guard-gitleaks: --trusted-work needs a directory — failing closed" >&2
      exit 2
    fi
    cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
    WORK="$(mktemp -d)"
  fi
  trap 'rm -rf "$WORK"' EXIT
  if [[ "$trusted" != "1" ]] && is_pr_build; then
    trust_self ${1+"$@"}
  fi
  local bin
  if [[ -n "${GITLEAKS_BIN:-}" ]]; then
    bin="$GITLEAKS_BIN"
  else
    cd "$WORK"
    curl -fsSL --proto '=https' --tlsv1.2 -o gitleaks.tar.gz \
      "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
    echo "${GITLEAKS_SHA256}  gitleaks.tar.gz" | sha256sum -c -
    tar -xzf gitleaks.tar.gz gitleaks
    ./gitleaks version
    cd - >/dev/null
    bin="$WORK/gitleaks"
  fi
  local config
  config="$(resolve_config)" || exit 2
  if [[ "$config" == "DEFAULTS" ]]; then
    "$bin" detect --no-git --source . --redact --no-banner --exit-code 1
  else
    "$bin" detect --no-git --source . --config "$config" --redact --no-banner --exit-code 1
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main ${1+"$@"}
fi
