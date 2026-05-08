# Changelog

All notable changes to wave-moq-edge are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
semantic versioning aligned with the IETF MoQ draft revision.

## [Unreleased]

### Added
- Public OSS scaffolding: LICENSE, CONTRIBUTING.md, SECURITY.md, CODEOWNERS,
  GitHub Actions CI, Dependabot, issue + PR templates, brand-voice README
- Branded HTML landing page at `GET /` using the WAVE public-HTML template
- Auto-mirror workflow from wave-av/wave-surfer-connect (private source) to
  wave-av/wave-moq-edge (public mirror) on every staging/main push to
  workers/moq-edge/
- `examples/quick-start.md` for first-time deploy walkthrough

### Changed
- README rewritten in WAVE writing-craft voice (specificity, parallel structure,
  concrete imagery)

### Pending
- Real `draft-07` wire-protocol implementation (currently scaffold; tests
  quarantined in `__tests__.broken-2026-05-07/` pending v2)
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
