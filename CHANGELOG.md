# Changelog

All notable changes to wave-moq-edge are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
semantic versioning aligned with the IETF MoQ draft revision.

## [Unreleased]

### Changed (Track C Phase-A — canonical-flip)
- **This repo is now the canonical source of truth for MoQ edge**, no longer a
  read-only auto-mirror of `wave-surfer-connect/workers/moq-edge`. PRs land here.
  Removed `.SYNC_META`; the WSC→mirror sync coupling is retired (WSC `workers/moq-edge`
  is being deleted per the Protocol Plane spec §4). Added `.foundation-version` pin.
- **Compiles standalone now.** Vendored the previously-missing `../shared/wave-public-html`
  dependency into `src/shared/wave-public-html.ts` (the import the auto-mirror never
  carried), added `tsconfig.json`, and pinned real dependency versions in place of the
  `catalog:` workspace references that only resolved inside the WSC monorepo.
- **wrangler.toml**: real `account_id` (wave-av); KV/R2 bindings documented with clearly
  labelled `TODO(Phase-B)` placeholders. No top-level live route (dry-run only).

### Added
- Public OSS scaffolding: LICENSE, CONTRIBUTING.md, SECURITY.md, CODEOWNERS,
  GitHub Actions CI, Dependabot, issue + PR templates, brand-voice README
- Branded HTML landing page at `GET /` using the WAVE public-HTML template
- `examples/quick-start.md` for first-time deploy walkthrough
- **MoQ draft-version negotiation matrix**: advertised draft range now
  draft-07..draft-17, preferred=draft-17 (latest IETF working draft as of
  2026-05-11, expires 2026-09-03). Replaces the previous draft-07-only stance.

### Changed
- README rewritten in WAVE writing-craft voice (specificity, parallel structure,
  concrete imagery)
- **Preferred MoQ draft bumped 07 → 17** (2026-05-11). All references in README,
  package.json description, wrangler.toml env vars, index.ts module docstring,
  moq-session-do.ts scaffold comments, SECURITY.md, CONTRIBUTING.md, and
  examples/quick-start.md updated. Wire IDs (0xff000007..0xff000011) match
  draft-17 §6.2 version-string encoding.

### Pending
- Real wire-protocol implementation targeting draft-17 (currently scaffold; tests
  quarantined in `__tests__.broken-2026-05-07/` pending v2). The draft-17 message
  framing (OBJECT_DATAGRAM, SUBSCRIBE, FETCH, GROUP_HEADER) is what 0.2.x will
  ship; the version-negotiation layer is in place now.
- Protocol adapters: WebRTC↔MoQ, SRT↔MoQ, HLS-LL↔MoQ
- Live demo at moq-demo.wave.online (Phase 1 landing shipped 2026-05-08)

## [0.1.0] - 2026-05-07

### Added
- Initial scaffold of moq-edge Cloudflare Worker with Durable Object pattern
- HTTP API: `/v1/publish/`, `/v1/subscribe/`, `/v1/track/`, `/v1/announce`,
  `/v1/catalog`, `/health`, `/metrics`
- IETF `draft-ietf-moq-catalog-01` listing endpoint (first public CF MoQ catalog)
- Tier-aware MoQ routing in transport-router
- Zod-validated namespace/track names
- KV-backed track registry with 24h TTL
- R2-backed recording (24h hot retention)

[Unreleased]: https://github.com/wave-av/wave-moq-edge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/wave-av/wave-moq-edge/releases/tag/v0.1.0
