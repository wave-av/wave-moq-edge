# moq-edge quick start

Three minutes from clone to your first track flowing through the relay.

## 1. Clone + install

```bash
git clone https://github.com/wave-av/wave-moq-edge
cd wave-moq-edge
pnpm install
```

## 2. Authenticate Wrangler

```bash
pnpm wrangler login
```

## 3. Provision the Cloudflare resources

```bash
# Durable Object namespace
pnpm wrangler d1 create moq-edge-do  # for state if needed

# KV namespace for track registry
pnpm wrangler kv:namespace create MOQ_TRACK_REGISTRY

# R2 bucket for replay
pnpm wrangler r2 bucket create moq-recordings
```

Edit `wrangler.toml` to paste the IDs Wrangler returned.

## 4. Deploy

```bash
pnpm wrangler deploy --env staging
# → https://moq-edge-staging.<your-account>.workers.dev
```

## 5. Publish your first track

```bash
NAMESPACE="demo"
TRACK="hello"
RELAY="https://moq-edge-staging.<your-account>.workers.dev"

curl -X POST "$RELAY/v1/publish/$NAMESPACE/$TRACK" \
  -H 'authorization: Bearer <token>' \
  --data-binary '@frame.bin'
```

## 6. Subscribe (one-shot HTTP — for full WebTransport see `examples/webtransport.html`)

```bash
curl "$RELAY/v1/track/$NAMESPACE/$TRACK"
# {"namespace":"demo","track":"hello","subscriber_count":0,"region":"BOS"}
```

## 7. Inspect the catalog

```bash
curl "$RELAY/v1/catalog" | jq
# Returns draft-ietf-moq-catalog-01 listing of all active tracks
```

## What's next

- `examples/webtransport.html` — browser publisher + subscriber with WebTransport
- `examples/server-publisher.ts` — Node.js server-side publisher (e.g., FFmpeg → MoQ)
- `examples/interop-test.sh` — runs against any moq-edge instance, reports compliance

## Where things live

```
index.ts                    # HTTP routing, request validation, MoQ control flow
moq-session-do.ts           # Durable Object: per-track session state + fan-out
metrics-collector.ts        # Workers Analytics Engine emitter
__tests__/                  # Vitest suite (currently quarantined pending v2 wire impl)
```

## Common questions

**Why a Durable Object per track?** WebTransport sessions are sticky to a single Worker.
The DO acts as the rendezvous so all subscribers reach the same place regardless of
which Worker they hit.

**How do I authenticate publishers?** moq-edge accepts a Bearer token on `/v1/publish/`.
Validate the token in your own auth layer before forwarding the request — this repo
intentionally does not ship an auth service.

**Where does the wire protocol implementation live?** Currently a scaffold. The full
`draft-07` wire protocol implementation tracks against `__tests__/` once those are
restored. Until then, treat this as a publish/subscribe HTTP API with WebTransport
upgrade semantics.

**Is this production-ready?** moq-edge powers WAVE's internal traffic. The public API
shape is stable; the wire-level implementation completes in v1.x. Production users
should pin to a specific tag and read the changelog before bumping.

## Help

- Bugs: <https://github.com/wave-av/wave-moq-edge/issues>
- Spec compliance: <https://github.com/wave-av/wave-moq-edge/issues/new?template=spec-compliance.yml>
- Security: [security@wave.online](mailto:security@wave.online)
- Real-time: ([planned] #wave-moq Discord)
