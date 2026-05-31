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
