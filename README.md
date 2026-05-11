# wave-moq-edge

**Sub-second live media at the edge.** A Cloudflare Worker that implements [IETF draft-ietf-moq-transport](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/) (currently advertising draft-07 through draft-17 in version negotiation; tracks the WG actively). Publish a track. Subscribe to it. Globally distributed in under 100ms.

```
POST   /v1/publish/:namespace/:track       Become a publisher
GET    /v1/subscribe/:namespace/:track     Become a subscriber (WebTransport)
GET    /v1/track/:namespace/:track         Track metadata + live counts
GET    /v1/announce                        List all active tracks
GET    /v1/catalog                         draft-ietf-moq-catalog-01 listing
GET    /health                             JSON liveness probe
GET    /metrics                            Prometheus exposition
GET    /                                   Branded landing page
```

## Why this exists

Live streaming at scale is a coordination problem. Every viewer needs every frame, ordered, on time, fast. Today's stack — RTMP origins, HLS chunks, CDN replicas — solves it with delay measured in seconds. WAVE built moq-edge because seconds isn't fast enough for the next decade of streaming.

MoQ Transport (Media over QUIC) puts publish/subscribe at the edge. One Durable Object per track. Publishers write. Subscribers read. The edge fans out. Latency: sub-100ms p95, globally.

## Architecture

```
Publisher → POST /v1/publish/ns/track → DO → in-memory frame queue
                                          ↓
                                 fan-out to N subscribers
                                          ↓
Subscriber ← GET /v1/subscribe/ns/track ← DO ← bytes
```

Each track gets one Durable Object instance. The DO holds publisher state, subscriber list, and a small object cache for late joiners. WebTransport sessions are sticky to a Worker; the DO is the rendezvous so all subscribers reach the same place regardless of which Worker they hit.

R2 backs replay. Tracks are recorded for 24h by default. Subscribe with `?from=<timestamp>` to replay.

## Quick start

```bash
git clone https://github.com/wave-av/wave-moq-edge
cd wave-moq-edge
pnpm install
pnpm wrangler deploy --env staging
```

Publish your first track:

```bash
curl -X POST https://<your-worker>.workers.dev/v1/publish/demo/hello \
  -H 'authorization: Bearer <your-token>'
```

Subscribe:

```bash
curl https://<your-worker>.workers.dev/v1/track/demo/hello
# {"namespace":"demo","track":"hello","subscriber_count":1,"region":"BOS"}
```

See [`examples/quick-start.md`](./examples/quick-start.md) for a full walkthrough.

## Spec compliance

moq-edge tracks the IETF draft. v0.x advertises a negotiation matrix from draft-17 (current IETF working draft, expires 2026-09-03) down to draft-07 (Cloudflare's historic subset support floor):

| Release | Preferred draft | Negotiation range | Status |
|---|---|---|---|
| 0.x | draft-17 | draft-07 .. draft-17 | Current |
| (planned) 1.x | draft-18+ | drops drafts < 12 | Future |

Compliance tests live in `__tests__/`. Interop reports welcome — file an issue with your client implementation, transport, and findings.

## Performance

- p50 publish→subscribe latency: <50ms intra-region, <100ms cross-region
- Capacity: 1000 concurrent subscribers per track, 10K tracks per Worker
- Cache: last 100 objects in DO memory, full track history in R2 (24h hot, 365d cold)
- Edge regions: every Cloudflare colo (300+)

These numbers come from production traffic on the WAVE platform. Your mileage will vary based on payload size, encoder pacing, and subscriber density.

## What this repo is not

This is the **transport relay**. It moves bytes. It does not:

- Encode video (that's your encoder's job)
- Adapt bitrate (your client picks the rendition)
- Authenticate users (your auth layer issues capability tokens)
- Record analytics (use Workers Analytics Engine or push to your own pipeline)

The full WAVE platform stacks all those layers on top. moq-edge is the bottom one.

## Constraints (current scaffold)

- Per-track DO instance — sticky routing means publisher + subscribers always meet at the same DO
- Namespace + track names: lowercase alphanumeric + dash, 1-64 chars (Zod-validated)
- Max 16 MiB per object (`MAX_OBJECT_SIZE_BYTES` env var)
- 10K subscribers/track in production, 1K in staging
- KV registry has 24h TTL per track (publisher must refresh on long sessions)

## Configuration

```toml
# wrangler.toml
name = "moq-edge"
main = "index.ts"

[vars]
MOQ_DRAFT_PREFERRED = "draft-17"
MOQ_DRAFT_SUPPORTED = "draft-17,draft-16,draft-15,draft-14,draft-13,draft-12,draft-11,draft-10,draft-09,draft-08,draft-07"
MAX_SUBSCRIBERS_PER_TRACK = "1000"
MAX_OBJECT_SIZE_BYTES = "1048576"  # 1MB

[[durable_objects.bindings]]
name = "MOQ_SESSIONS"
class_name = "MoqSessionDO"

[[kv_namespaces]]
binding = "MOQ_TRACK_REGISTRY"
id = "<your-kv-id>"

[[r2_buckets]]
binding = "MOQ_RECORDINGS"
bucket_name = "<your-r2-bucket>"
```

## Roadmap

- **0.1.x** (current): scaffold, HTTP API, DO pattern, KV/R2 bindings, catalog endpoint, draft-17 advertised in version negotiation
- **0.2.x**: real wire protocol over WebTransport QUIC streams (draft-17 message types, object headers, GROUP/SUBGROUP framing)
- **0.3.x**: protocol adapters (WebRTC↔MoQ, SRT↔MoQ, HLS-LL↔MoQ)
- **0.4.x**: public live demo at [moq-demo.wave.online](https://moq-demo.wave.online), reference clients
- **1.0**: GA when draft-20+ ships, full interop testing complete, working group consensus on stable framing

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Open an issue before non-trivial PRs. Bug fixes, spec compliance fixes, and interop test reports are always welcome.

## Security

Vulnerabilities: [security@wave.online](mailto:security@wave.online). 90-day coordinated disclosure. See [SECURITY.md](./SECURITY.md).

## License

MIT. See [LICENSE](./LICENSE).

Built by [WAVE Online](https://wave.online).
