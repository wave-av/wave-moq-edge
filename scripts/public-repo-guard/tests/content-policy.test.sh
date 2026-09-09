#!/usr/bin/env bash
# Regression: the content scanner must not false-BLOCK on a git worktree's `.git` pointer file,
# and must not have widened its exclusion in the process (#494).
#
# `.git` is a DIRECTORY in a clone and a FILE in a worktree, and the file holds an absolute
# operator path (`gitdir: /Users/<operator>/...`). The pre-fix glob `!**/.git/**` matched only the
# directory form, so every worktree run — the mandated local workflow — blocked on abs-user-path.
#
# The precision half matters as much as the fix: the exclusion is ANCHORED to the scan root and
# conditional on git agreeing the path is metadata, so it cannot become a smuggling route for a
# file that merely happens to be named `.git`.
set -uo pipefail

GUARD_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok   $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }

# An invented operator path. Never a real one, and never a real partner term: a leak fixture must
# not itself be a leak.
FIXTURE_PATH='/Users/someoperator/notes/private.txt'  # enforce-ignore (fixture)

sandbox() { # sandbox -> fresh dir with the guard available, cwd set
  rm -rf "$TMP/repo"; mkdir -p "$TMP/repo/scripts"
  cp -R "$GUARD_SRC" "$TMP/repo/scripts/public-repo-guard"
  cd "$TMP/repo" || exit 1
  git init -q . && git config user.email t@t && git config user.name t
}
run_guard() { bash scripts/public-repo-guard/content-policy.sh >/dev/null 2>&1; echo $?; }

echo "== the false positive (#494) =="
sandbox
printf 'gitdir: %s/.git/worktrees/lane\n' "$(dirname "$FIXTURE_PATH")" > .git_pointer_fixture
# Replace the real .git dir with the worktree FILE form, which is what a `git worktree` produces.
rm -rf .git && mv .git_pointer_fixture .git
[ "$(run_guard)" = "0" ] \
  && ok "worktree .git pointer file does not trigger a BLOCK" \
  || bad "worktree .git pointer file still BLOCKs"

echo "== precision: the exclusion must not have widened =="
sandbox
mkdir -p sub && printf 'const p = "%s";\n' "$FIXTURE_PATH" > sub/.git
[ "$(run_guard)" = "1" ] \
  && ok "a nested path named .git is still scanned (exclusion is anchored to the root)" \
  || bad "a nested .git was excluded — the glob is not anchored"

sandbox
printf 'const p = "%s";\n' "$FIXTURE_PATH" > leak.ts
[ "$(run_guard)" = "1" ] \
  && ok "an ordinary operator-path leak still BLOCKs" \
  || bad "the scanner stopped catching a real leak"

sandbox
printf 'export const ok = 1;\n' > clean.ts
[ "$(run_guard)" = "0" ] \
  && ok "a clean tree passes" \
  || bad "a clean tree was blocked"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
