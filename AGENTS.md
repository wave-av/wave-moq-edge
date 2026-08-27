# AGENTS.md — wave-av/wave-moq-edge

Agent contract for this repo. Inherits the org default (<https://github.com/wave-av/.github/blob/main/AGENTS.md>) and the [repo-governance standard](https://github.com/wave-av/wave-foundation/blob/master/frameworks/repo-governance/governance-matrix.md).

## Build and test

See `README.md` for setup. Run the repo's lint / typecheck / test before opening a PR, and fix what you broke.

## Rules

- Branch and open a PR; never push to the default branch. All required gates must pass before merge.
- No secrets in commits — secret-scan is a required gate and will block.
- Conventional Commit titles; update `CHANGELOG.md` (`Unreleased`) for user-facing changes.
- Match the existing code conventions; keep files focused (~200-500 lines).

## Security

Report vulnerabilities via the [Security Policy](https://github.com/wave-av/.github/blob/main/SECURITY.md) (security@wave.online) — never in a public issue.


# Platform Context

You are working inside the WAVE platform (wave-av org, 157 repos). Before acting:

1. **The registry is the SSOT.** Query it via `@wave-av/registry-sdk` or the REST API at `https://goqtrxgdmaqojmixradj.supabase.co/rest/v1/<table>`. Tables: models, tools, vendors, products (25+ with data planes), deliverables, tests, prose, usage_logs.
2. **Five physics laws gate everything** in CI: gauge-invariance (no raw slug), frame-independence (scores inherited), conservation-of-declaration (four renderings), entropy-monotonicity (nothing unregistered), token-budget-conservation.
3. **The full fleet map** lives at `governance/plans/session-deliverable-registry/PLATFORM-MAP.md` in claude-workstation (157 repos by kind: core/spoke/ssot/tool/sdk).
4. **The 24-axis model taxonomy** lives at `wave-foundation/frameworks/model-routing/champions.json` (calibrated_at 2026-08-24).
5. **The inference pool** runs on our rigs at `http://100.92.89.55:8800/v1` (internal, $0). Frontier fallback via openrouter/anthropic. The rail field on models tracks internal vs customer.
6. **The voice laws**: no em-dashes, every word earns its place, short words over long, active voice, receipt over adjective. Enforced by voice-gate.mjs.
7. **The test-matrix**: every shipped artifact carries unit/integration/smoke/e2e/probe receipts in the tests table. No test, no ship.
