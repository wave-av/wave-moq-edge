#!/usr/bin/env bash
# WAVE public-repo content policy — the trade-secret / internal-leak gate.
#
# gitleaks catches FORMATTED secrets (API keys, tokens, private keys). This script
# catches the WAVE-specific things gitleaks does NOT: live billing identifiers,
# infra account IDs, hardcoded developer paths, private-repo names, and committed
# dotenv files. It is intentionally conservative (low false-positive) so it can be
# a BLOCKING merge gate on public repos.
#
# Scope: scans the working tree (the state being merged). Run AFTER checkout.
# Exits non-zero on any BLOCK violation. Allowlist a specific line with an inline
# `# guard:allow <reason>` comment, or exclude paths via a .guardignore (one glob
# per line) at the repo root.
#
# Usage: scripts/public-repo-guard/content-policy.sh [root]   (default root = .)
set -uo pipefail

ROOT="${1:-.}"
cd "$ROOT" || { echo "::error::content-policy: cannot cd to $ROOT"; exit 2; }
command -v rg >/dev/null 2>&1 || { echo "::error::content-policy: ripgrep (rg) required"; exit 2; }

VIOLATIONS=0

# Path globs exempt from scanning (vcs, vendored, build output, lockfiles, the
# gate's own pattern strings). Extend per-repo via .guardignore.
IGNORE=(
  -g '!**/.git/**'
  -g '!**/node_modules/**'
  -g '!**/dist/**' -g '!**/build/**' -g '!**/.next/**' -g '!**/target/**' -g '!**/vendor/**'
  -g '!**/*.lock' -g '!**/pnpm-lock.yaml' -g '!**/package-lock.json' -g '!**/Cargo.lock' -g '!**/go.sum'
  -g '!**/scripts/public-repo-guard/**'
  -g '!**/.gitleaks.toml'
)
if [[ -f .guardignore ]]; then
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    IGNORE+=( -g "!$line" )
  done < .guardignore
fi

# check <BLOCK|WARN> <name> <regex> <why>
# A non-empty regex is required; an accidental empty pattern would match every
# line, so we guard against it explicitly.
check() {
  local sev="$1" name="$2" re="$3" why="$4"
  [[ -z "$re" ]] && { echo "::error::content-policy: internal bug — empty regex for rule '$name'"; exit 2; }
  # --hidden + --no-ignore-vcs so the scan covers dotfiles/dotdirs (.github/**,
  # .npmrc, …) and committed-but-gitignored files — a public leak hides there too.
  # rg exit: 0=match, 1=no match, >=2=real error → FAIL CLOSED (never pass a gate
  # silently because the scanner errored).
  local raw rc
  raw="$(rg -nP --hidden --no-ignore-vcs "${IGNORE[@]}" -- "$re" . 2>/dev/null)"; rc=$?
  if (( rc >= 2 )); then
    echo "::error title=public-repo-guard ($name)::ripgrep failed (exit $rc) scanning rule '$name' — failing closed."; exit 2
  fi
  # Only the documented inline form `# guard:allow <reason>` suppresses a hit, and
  # the reason is mandatory (non-space after the marker) — a bare marker, or the
  # string appearing elsewhere on the line, must NOT bypass detection.
  local matches
  matches="$(printf '%s' "$raw" | grep -vE '#[[:space:]]*guard:allow[[:space:]]+[^[:space:]]' || true)"
  [[ -z "$matches" ]] && return 0
  local count; count="$(printf '%s\n' "$matches" | grep -c '' )"
  echo "::group::[$sev] $name — $why"
  # Print only file:line — NEVER the matched content. On a public repo the Actions
  # log is public, so echoing the detected value would re-leak the secret itself.
  printf '%s\n' "$matches" | sed -E 's/^([^:]+:[0-9]+):.*/\1: «match redacted — open this location to view»/'
  echo "::endgroup::"
  if [[ "$sev" == "BLOCK" ]]; then
    echo "::error title=public-repo-guard ($name)::$why — $count occurrence(s). Remove it, or annotate the line with '# guard:allow <reason>' if it is a verified-safe example."
    VIOLATIONS=$((VIOLATIONS+1))
  else
    echo "::warning title=public-repo-guard ($name)::$why — $count occurrence(s) (non-blocking; review)."
  fi
}

# --- Financial / billing identifiers -----------------------------------------
check BLOCK stripe-account   'acct_[A-Za-z0-9]{16,}'                              'Live Stripe account ID — financial infra, never publish'
check BLOCK stripe-live-key  '(sk|rk)_live_[A-Za-z0-9]{16,}'                      'Live Stripe secret/restricted key'
check WARN  stripe-object    '(cus|sub|price|prod)_[A-Za-z0-9]{14,}'             'Stripe object ID — verify it is an EXAMPLE, not a real account object'

# --- Infrastructure identifiers ----------------------------------------------
check BLOCK cf-account-id    'account_id\s*[:=]\s*["'"'"']?[0-9a-f]{32}'          'Hardcoded Cloudflare account_id — source it from $CLOUDFLARE_ACCOUNT_ID'

# --- Developer / private-repo leakage ----------------------------------------
check BLOCK abs-user-path    '/(Users|home)/(?!runner/)[a-z][a-z0-9._-]+/'        'Hardcoded developer absolute path — use $HOME or a CLI argument'

# Private WAVE repo/product names that must never appear in a public tree. The
# names are NOT hardcoded here (this file is itself public) — they are supplied
# at run time via GUARD_PRIVATE_REPOS (CI injects it from an org-level Actions
# variable), comma- or space-separated. Unset locally → this check is skipped.
if [[ -n "${GUARD_PRIVATE_REPOS:-}" ]]; then
  IFS=', ' read -r -a _PRIV <<< "$GUARD_PRIVATE_REPOS"
  for _name in "${_PRIV[@]}"; do
    [[ -z "$_name" ]] && continue
    # Regex-escape the name so metacharacters in a repo name (., -, etc.) match
    # literally rather than changing the pattern's meaning.
    _esc="$(printf '%s' "$_name" | sed -E 's/[][(){}.^$*+?|\\]/\\&/g')"
    check BLOCK private-repo "\\b${_esc}\\b" 'Reference to a private WAVE repo/product (configured via GUARD_PRIVATE_REPOS) — keep out of public'
  done
fi

# --- Credential formats gitleaks may miss in-context -------------------------
check BLOCK anthropic-key    'sk-ant-(api|admin)[0-9]{2}-[A-Za-z0-9_-]{20,}'      'Real Anthropic API/admin key'
check BLOCK github-pat       'github_pat_[A-Za-z0-9_]{30,}'                       'GitHub fine-grained PAT'
check BLOCK supabase-pat     'sbp_[a-f0-9]{40}'                                   'Supabase personal access token'
check BLOCK aws-akid         'AKIA[0-9A-Z]{16}'                                   'AWS access key ID'
check BLOCK private-key      '-----BEGIN [A-Z ]*PRIVATE KEY-----'                 'Embedded private key material'

# --- Committed dotenv (real env, not templates) ------------------------------
# List candidate files with the SAME ignore filtering as check() so .guardignore
# and the standard excludes apply to this BLOCK rule too. Match `.env` plus any
# `.env.*` variant (development, test, …), then drop template forms. Include-globs
# come first; the IGNORE excludes come last (last match wins, so a .env under e.g.
# node_modules stays excluded). --hidden because these are dotfiles; --no-ignore-vcs
# so a committed-but-gitignored .env is still caught; fail CLOSED on rg error.
_envraw="$(rg --files --hidden --no-ignore-vcs -g '.env' -g '.env.*' "${IGNORE[@]}" 2>/dev/null)"; _envrc=$?
if (( _envrc >= 2 )); then
  echo "::error title=public-repo-guard (committed-dotenv)::ripgrep failed (exit $_envrc) — failing closed."; exit 2
fi
ENVHITS="$(printf '%s\n' "$_envraw" | grep -vE '\.(example|sample|template|dist)$' | grep -vE '^$' || true)"
if [[ -n "$ENVHITS" ]]; then
  echo "::group::[BLOCK] committed-dotenv — real .env files must not be committed"
  printf '%s\n' "$ENVHITS"
  echo "::endgroup::"
  echo "::error title=public-repo-guard (committed-dotenv)::Committed .env file(s). Commit only .env.example/.sample/.template."
  VIOLATIONS=$((VIOLATIONS+1))
fi

if (( VIOLATIONS > 0 )); then
  echo "::error::public-repo-guard: $VIOLATIONS blocking content-policy violation(s) — see annotations above."
  exit 1
fi
echo "public-repo-guard: content policy OK"
