# Contributing to WAVE moq-edge

Thanks for your interest. moq-edge is a Cloudflare Worker that implements an IETF MoQ Transport relay for sub-second live media at the edge. It is built and operated by [WAVE Online](https://wave.online).

## What this repo is

A reference implementation of the MoQ Transport relay pattern (publish/subscribe at the edge, Durable Object as rendezvous, R2 for replay). The goal is interop testing against `draft-ietf-moq-transport-07` and giving the broader streaming community a runnable starting point.

**This repo is the canonical source of truth for WAVE MoQ edge.** It is no longer a mirror of an internal WAVE monorepo — all moq-edge changes land here directly via PR. This repo serves:

- Issues and PRs from WAVE engineers and outside contributors (land them here)
- Interop testing with other MoQ implementations
- Reference for engineers learning MoQ

## What we accept

- **Bug fixes** — incorrect protocol behavior, race conditions, security issues
- **Spec compliance fixes** — drifts from `draft-ietf-moq-transport-07`
- **Performance improvements** — measurable, with before/after metrics
- **Test coverage** — Vitest tests under `__tests__/` (currently quarantined as `__tests__.broken-2026-05-07` pending v2 wire protocol)
- **Documentation improvements** — clarifying the README, examples, troubleshooting
- **Interop test reports** — findings from running moq-edge against your client/server

## What we do not accept (or accept reluctantly)

- **Commercial licensing changes** — this is MIT, period
- **Drop-in replacements for the Cloudflare Workers runtime** — moq-edge is platform-specific; use it as a reference if porting to another runtime, but don't PR a node/deno/bun rewrite
- **Adding new features without spec backing** — WAVE-specific extensions belong in our private fork; this repo is for public spec interop
- **Adding non-MoQ protocols** — protocol adapters (WebRTC↔MoQ, SRT↔MoQ, etc.) are tracked in the WAVE Protocol Plane program, not this repo
- **Sweeping refactors that don't fix a specific issue** — small targeted PRs are easier to review

## Before opening a PR

1. **Open an issue first** for non-trivial changes. We're happy to discuss before you write code.
2. **Run the local checks:**
   ```bash
   pnpm install
   pnpm wrangler deploy --dry-run
   pnpm tsc --noEmit
   ```
3. **Match the code style.** TypeScript strict mode, single quotes, 2-space indent, no semicolons in places where the existing file omits them.
4. **Keep PRs focused.** One concern per PR. If you see two bugs, file two PRs.
5. **Sign off your commit** with `git commit -s`. We use the [DCO](https://developercertificate.org/) — no CLA.

## Code of conduct

Be respectful. Assume good faith. Disagreement on technical merits is welcome; personal attacks are not.

If you encounter behavior that violates this, email [conduct@wave.online](mailto:conduct@wave.online). All reports are confidential.

## Security

Do **not** open public issues for security findings. Email [security@wave.online](mailto:security@wave.online) with details. We will respond within 48 hours and coordinate disclosure on a 90-day timeline (or faster if the vulnerability is being actively exploited).

## License

By contributing, you agree your contribution will be released under the [MIT License](./LICENSE).

## Versioning

moq-edge follows semantic versioning. v0.x advertises preferred=draft-18 with a negotiation matrix accepting draft-07..draft-18 (CF historically supported a subset of draft-07, so we hold the floor for cross-platform interop). Major version bumps track significant breaking changes in newer drafts as they ship.

## Questions

- General: [hello@wave.online](mailto:hello@wave.online)
- Spec compliance: [moq@wave.online](mailto:moq@wave.online)
- Reference docs: [https://docs.wave.online/moq-edge](https://docs.wave.online/moq-edge)
