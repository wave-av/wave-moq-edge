# WAVE moq-edge

Cloudflare Worker implementing IETF [draft-07 MoQ Transport](https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-07) for sub-second live media at the edge.

## Status

| Environment | URL | State |
|-------------|-----|-------|
| Staging | `https://moq-edge-staging.wave.online` | Deployed 2026-05-07 |
| Production | `https://moq-edge.wave.online` | Pending deploy |

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/publish/:namespace/:track` | Register a publisher; returns WebTransport URL |
| `GET` | `/v1/subscribe/:namespace/:track` | Subscribe (count incremented in DO state) |
| `GET` | `/v1/track/:namespace/:track` | Track metadata + DO state |
| `GET` | `/v1/announce` | List up to 100 announced tracks (KV-backed, 24h TTL) |
| `GET` | `/health` | Liveness probe — `{ok, service, environment, moq_draft, timestamp}` |
| `GET` | `/metrics` | Prometheus-format metrics (active tracks gauge + build info) |

## Architecture

```
   Customer encoder (WebTransport client)
                |
                | HTTP/3 + draft-07
                v
        moq-edge Worker
                |
                | DO routing by namespace/track
                v
        MoqSessionDO (one per <ns>/<track>)
                |
        ┌───────┼───────┐
        v       v       v
   Sub 1   Sub 2   Sub N (multiplexed QUIC)
```

## Constraints (this scaffold)

- Per-track DO instance — sticky routing means publisher + subscribers always meet at same DO
- Namespace + track names: lowercase alphanumeric + dash, 1-64 chars (Zod-validated)
- Max 16 MiB per object (`MAX_OBJECT_SIZE_BYTES` env var)
- 10K subscribers/track in production, 1K in staging
- KV registry has 24h TTL per track (publisher must refresh on long sessions)

## Deploy

```bash
pnpm install                   # from monorepo root
pnpm --filter @wave-av/moq-edge deploy:staging
pnpm --filter @wave-av/moq-edge deploy:production
```

## Smoke test

```bash
curl -X POST https://moq-edge-staging.wave.online/v1/publish/test/hello
# {"ok":true,"publish_session":"<uuid>","webtransport_url":"wss://..."}

curl https://moq-edge-staging.wave.online/v1/subscribe/test/hello
# {"ok":true,"subscriber_count":1,"publisher_active":true}

curl https://moq-edge-staging.wave.online/v1/track/test/hello | jq
# Full session state
```

## Roadmap

- **Week 1** (this commit): scaffold + deploy + smoke-tested
- **Week 2**: real MoQ draft-07 wire protocol (WebTransport QUIC streams)
- **Week 3**: WebRTC/SRT/HLS-LL → MoQ protocol adapters
- **Week 4**: public demo (`moq-demo.wave.online`) + Cloudflare partnership comms

See [`docs/integration-research/moq-wave-strategy-2026-05-07.md`](../../docs/integration-research/moq-wave-strategy-2026-05-07.md) for full strategic doc.

## License

Apache-2.0 — to be added with `wave-av/wave-moq-edge` open-source extraction in week 2.

## Why this exists

Cloudflare shipped MoQ in early 2026. The docs are sparse (2 pages). There's no public reference Worker, no published TypeScript SDK, no "add MoQ to your existing platform" guide. WAVE has the existing infrastructure, the 8-protocol-streaming chops, and the half-built scaffold to fill all four gaps. Becoming the reference implementation is the play.
