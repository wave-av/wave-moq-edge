#!/usr/bin/env bash
# eslint with public npm devDependencies only (the private @wave-av/* runtime deps are not needed to lint).
# No token, no lifecycle scripts. Runs on PR builds.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
[ -e "$MOQ_REPO_ROOT/node_modules" ] && moq_die "node_modules already present; refusing to replace it"
nm="$(moq_public_tools "eslint@$MOQ_ESLINT_VERSION" "@eslint/js@$MOQ_ESLINT_VERSION" "typescript-eslint@$MOQ_TSESLINT_VERSION")"
ln -s "$nm" "$MOQ_REPO_ROOT/node_modules"
moq_section ":eslint: eslint . --max-warnings 0"
cd "$MOQ_REPO_ROOT" && ./node_modules/.bin/eslint . --max-warnings 0
