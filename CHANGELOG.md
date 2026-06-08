# Changelog

All notable changes to wave-moq-edge are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
semantic versioning aligned with the IETF MoQ draft revision.

## [Unreleased]

### Added
- **Real MoQ wire codec + pub/sub fan-out relay** (was a routing scaffold). `src/moq-wire.ts` is a
  PURE, hermetically-tested draft-ietf-moq-transport-18 codec — leading-1-bits varint (§1.4.1),
  Track Namespace tuple (§1.4.2), control framing `Type(i)+Length(16)+payload` (§10), the
  relay-relevant control messages (SETUP/SUBSCRIBE/SUBSCRIBE_OK/PUBLISH_NAMESPACE/REQUEST_OK/
  REQUEST_ERROR), and the object model (§11). Constants read verbatim from the moq-wg GitHub source
  at the `draft-ietf-moq-transport-18` tag. `src/moq-relay.ts` is the transport-independent
  publisher→subscribers fan-out state machine, folding traffic into the R4 `wave.usage` meter.
  52 hermetic unit tests (`__tests__/moq-wire.test.ts`, `__tests__/moq-relay.test.ts`).
- **WebSocket transport binding** in the session Durable Object (`moq-session-do.ts`): publisher +
  subscribers connect over a WebSocket; each MoQ frame carries a 1-byte kind tag (control vs object)
  so the control/data split survives on one socket. CF Workers has no WebTransport *server* API yet;
  the codec/relay are unchanged when that lands (control→stream, object→datagram). capabilities.json
  status `relay-scaffold` → `relay-websocket-beta`, lifecycle `alpha` → `beta`.

### Changed
- Bump advertised IETF MoQ Transport draft 17 -> 18 (draft-ietf-moq-transport-18, dated
  2026-05-12, now the current WG draft). MOQ_DRAFT_VERSION=18, negotiation matrix
  draft-07..draft-18; floor stays draft-07. Updates the drift gate CURRENT_DRAFT_NUM=18
  and fixes a stale `draft-ietf-moq-transport-07` string in the landing subtitle.


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
- **Preferred MoQ draft bumped 17 → 18** (2026-05-30). IETF published
  draft-ietf-moq-transport-18; the negotiation matrix is now draft-07..draft-18,
  preferred=draft-18. Updated wrangler.toml (staging + production vars),
  scripts/check-moq-draft-version.sh (`CURRENT_DRAFT_NUM=18`), index.ts module
  docstring + landing subtitle (now reads `MOQ_DRAFT_VERSION` from env instead of
  hardcoding draft-07), moq-session-do.ts, README.md, CONTRIBUTING.md, SECURITY.md.
- README rewritten in WAVE writing-craft voice (specificity, parallel structure,
  concrete imagery)
- **Preferred MoQ draft bumped 07 → 17** (2026-05-11). All references in README,
  package.json description, wrangler.toml env vars, index.ts module docstring,
  moq-session-do.ts scaffold comments, SECURITY.md, CONTRIBUTING.md, and
  examples/quick-start.md updated. (Integer version IDs were later removed at
  draft-18, which switched to ALPN-only version negotiation — see above.)

### Pending
- **Native WebTransport/QUIC server binding.** The draft-18 codec + relay are
  transport-independent; the current binding is WebSocket (CF Workers exposes no
  WebTransport *server* API yet). When it lands: control→stream, object→datagram —
  no codec change.
- **Cross-relay interop with the public Cloudflare relays** (`draft-07`/`draft-14`
  at `*.cloudflare.mediaoverquic.com`; CF currently deploys draft-07). Needs the
  WebTransport binding above, a draft-18↔≤17 varint bridge (draft-18's leading-1-bits
  varint is not RFC-9000-compatible), and `UNSUBSCRIBE` handling.
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
