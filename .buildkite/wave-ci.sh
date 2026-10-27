#!/usr/bin/env bash
# wave-ci shim (wave-ci#70). FIXED CONTENT: identical in every repo; copy it from
# wave-ci/repo-kit/.buildkite/wave-ci.sh and commit it with mode 100755. Do not edit per repo.
#
# Every step of a templated pipeline runs this one checked-in script with no arguments (the
# fpc-isolated agents run with no-command-eval). It:
#   1. reads the wave-ci pin from .buildkite/wave-ci.json (key "wave_ci") and refuses anything but
#      a full 40-hex commit sha (never a branch, tag or short sha),
#   2. INSIDE a Buildkite job (BUILDKITE=true or BUILDKITE_JOB_ID set) never fetches anything: it
#      uses only the checkout the golden image's ROOT helper placed for this pin and the image's
#      post-checkout hook exported as WAVE_CI_DIR / WAVE_CI_SHA (ci-smoke#9, wave-ci#81). It
#      re-verifies that checkout (a real directory, owned by root, nothing in it writable, HEAD ==
#      the pin, clean) and refuses otherwise. No WAVE_CI_DIR in a job is a refusal, never a fetch.
#   3. OUTSIDE a Buildkite job (a developer machine), uses WAVE_CI_DIR the same way when set, else
#      fetches exactly the pinned commit into a temp dir (WAVE_CI_SRC, else the mirror
#      /opt/wave/wave-ci.git, else GitHub; git only) and verifies HEAD,
#   4. runs wave-ci's step dispatcher, which runs the action named by WAVE_JOB_ACTION.
#
# WAVE_CI_SRC, WAVE_CI_TEST_SYSTEM_PATH and WAVE_CI_TEST_DIR_OWNER are local test overrides. They
# are ignored inside a Buildkite job, and a job cannot set them anyway: the guest agent refuses any
# job env name outside its allowlist (WAVE_JOB_*, NODE_ENV, ...). WAVE_CI_DIR / WAVE_CI_SHA come
# from the image-owned post-checkout hook and are verified here, not trusted.
set -euo pipefail
umask 077

in_job=0
if [[ "${BUILDKITE:-}" == true || -n "${BUILDKITE_JOB_ID:-}" ]]; then in_job=1; fi
if [[ $in_job == 1 && -z "${WAVE_CI_DIR:-}" ]]; then
  printf 'wave-ci.sh: refusing: WAVE_CI_DIR is not set; inside a Buildkite job wave-ci comes only from the image (post-checkout hook), never from a fetch\n' >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cfg="$root/.buildkite/wave-ci.json"
[[ -f "$cfg" ]] || { printf 'wave-ci.sh: .buildkite/wave-ci.json is missing\n' >&2; exit 2; }

# The pin is read with JSON.parse by the image's node (from `/`, under `env -i`, system PATH only),
# never by grep: a structured file is only ever read by a real parser.
sys_path=/usr/local/bin:/usr/bin:/bin
if [[ -n "${WAVE_CI_TEST_SYSTEM_PATH:-}" && $in_job == 0 ]]; then sys_path="$WAVE_CI_TEST_SYSTEM_PATH"; fi
# shellcheck disable=SC2016  # node code, not shell
pin="$(cd / && env -i PATH="$sys_path" node -e '
  const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (v === null || typeof v !== "object" || Array.isArray(v) || typeof v.wave_ci !== "string") process.exit(3);
  process.stdout.write(v.wave_ci);
' "$cfg")" || { printf 'wave-ci.sh: refusing: .buildkite/wave-ci.json is not valid JSON with a string "wave_ci"\n' >&2; exit 2; }
if [[ ! "$pin" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'wave-ci.sh: refusing: wave_ci must be a full 40-hex wave-ci commit sha, not a branch, tag or short sha\n' >&2
  exit 2
fi

# git against a checkout this uid does not own: no system/global config, no hooks, no fsmonitor,
# no optional locks (nothing is written), and safe.directory for exactly that one directory.
ro_git() {
  local dir="$1"
  shift
  local t=()
  # test only: make git treat every repo as owned by another uid, as the image's root-owned dir is
  if [[ -n "${WAVE_CI_TEST_GIT_DIFFERENT_OWNER:-}" && $in_job == 0 ]]; then t=(GIT_TEST_ASSUME_DIFFERENT_OWNER=1); fi
  (cd / && env -i PATH="$sys_path" HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 LC_ALL=C ${t[@]+"${t[@]}"} \
    git -c "safe.directory=$dir" -c core.hooksPath=/dev/null -c core.fsmonitor=false -C "$dir" "$@")
}

refuse_dir() {
  printf 'wave-ci.sh: refusing WAVE_CI_DIR: %s\n' "$1" >&2
  exit 2
}

# WAVE_CI_DIR must be the image's read-only checkout of exactly this pin.
verify_wave_ci_dir() {
  local dir="$1" owner=0 real uid bad head
  if [[ -n "${WAVE_CI_TEST_DIR_OWNER:-}" && $in_job == 0 ]]; then owner="$WAVE_CI_TEST_DIR_OWNER"; fi
  [[ "$owner" =~ ^[0-9]{1,10}$ ]] || refuse_dir "bad owner uid"
  [[ "$dir" == /* ]] || refuse_dir "not an absolute path"
  [[ ! -L "$dir" && -d "$dir" ]] || refuse_dir "not a real directory"
  real="$(cd -P -- "$dir" 2>/dev/null && pwd -P)" || refuse_dir "cannot resolve it"
  [[ "$real" == "$dir" ]] || refuse_dir "a path component is a symlink"
  [[ "${WAVE_CI_SHA:-}" == "$pin" ]] || refuse_dir "WAVE_CI_SHA does not equal the wave_ci pin"
  uid="$(stat -c %u -- "$dir" 2>/dev/null || stat -f %u -- "$dir")"
  [[ "$uid" == "$owner" ]] || refuse_dir "not owned by uid $owner"
  [[ ! -w "$dir" ]] || refuse_dir "writable by this job"
  # every entry: owned by the same uid and no write bit for anyone (the root helper's chmod a-w)
  bad="$(find "$dir" \( ! -uid "$owner" -o \( ! -type l \( -perm -0200 -o -perm -0020 -o -perm -0002 \) \) \) -print -quit 2>/dev/null)" ||
    refuse_dir "cannot scan it"
  [[ -z "$bad" ]] || refuse_dir "an entry is writable or not owned by uid $owner"
  head="$(ro_git "$dir" rev-parse --verify HEAD 2>/dev/null)" || refuse_dir "not a git checkout"
  [[ "$head" == "$pin" ]] || refuse_dir "HEAD does not equal the wave_ci pin"
  [[ -z "$(ro_git "$dir" status --porcelain --ignored --untracked-files=all 2>/dev/null || printf 'error')" ]] ||
    refuse_dir "the checkout is not clean"
  [[ -f "$dir/bin/wave-ci-step.sh" && ! -L "$dir/bin/wave-ci-step.sh" ]] || refuse_dir "no bin/wave-ci-step.sh"
}

if [[ -n "${WAVE_CI_DIR:-}" ]]; then
  verify_wave_ci_dir "$WAVE_CI_DIR"
  rc=0
  bash "$WAVE_CI_DIR/bin/wave-ci-step.sh" "$root" || rc=$?
  exit "$rc"
fi

if [[ $in_job == 1 ]]; then exit 2; fi # unreachable (refused at the top); belt and braces

# ---- local use only (not a Buildkite job): fetch the pinned commit ----------------------------------
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
dest="$work/wave-ci"
git init -q "$dest"

export GIT_TERMINAL_PROMPT=0
sources=()
if [[ -n "${WAVE_CI_SRC:-}" ]]; then sources=("$WAVE_CI_SRC")
else
  [[ -d /opt/wave/wave-ci.git ]] && sources+=(/opt/wave/wave-ci.git)
  sources+=(https://github.com/wave-av/wave-ci.git)
fi
fetched=0
for src in "${sources[@]}"; do
  if git -C "$dest" fetch -q --no-tags --depth 1 "$src" "$pin" 2>/dev/null; then fetched=1; break; fi
done
if [[ $fetched != 1 ]]; then
  printf 'wave-ci.sh: could not fetch wave-ci %s from any source (%s)\n' "$pin" "${#sources[@]}" >&2
  exit 1
fi
git -C "$dest" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
head="$(git -C "$dest" rev-parse HEAD)"
if [[ "$head" != "$pin" ]]; then
  printf 'wave-ci.sh: refusing: fetched wave-ci HEAD does not equal the pin\n' >&2
  exit 1
fi

rc=0
bash "$dest/bin/wave-ci-step.sh" "$root" || rc=$?
exit "$rc"
