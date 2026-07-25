# moq-edge quick start

From a clean checkout to **moving video in a browser**, with a measured latency number on screen.

Two routes. Pick one:

- **[A. Watch the live relay](#a-watch-the-live-relay)** — you have a WAVE API key. Publish to
  `moq.wave.online` and watch it in a browser.
- **[B. Run the relay yourself](#b-run-the-relay-yourself)** — no key, no account, no deploy. One
  command boots the relay locally and runs the publish → subscribe round trip.

Route B needs nothing but Node 22. Start there if you just want to see it work.

## What's in `examples/`

| file                                                   | what it is                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [`browser-subscriber.html`](./browser-subscriber.html)  | zero-build single-file browser subscriber — canvas + live p50/p95 + objects/sec |
| [`server-publisher.ts`](./server-publisher.ts)          | zero-dependency Node 22 publisher (and the verification subscriber)              |
| [`interop-test.sh`](./interop-test.sh)                  | publish → subscribe round trip; prints PASS/FAIL and a measured p50              |
| [`moq-demo-frame.md`](./moq-demo-frame.md)              | the tiny examples-only payload envelope those three share                        |

## Transport: this is MoQ over WebSocket, not WebTransport

IETF MoQ Transport runs over WebTransport/QUIC. **Cloudflare Workers exposes no WebTransport
*server* API**, so this relay binds MoQ to a WebSocket (see the header of
[`src/moq-wire.ts`](../src/moq-wire.ts)). Control and data share one message-oriented socket, so every
frame carries a 1-byte kind tag — `0x00` control, `0x01` object. Strip that byte and the body is exact
`draft-ietf-moq-transport-18`. Everything above the transport — the varints, the control messages, the
object model — is the real wire format, and the tag drops away unchanged the day a WebTransport server
binding lands.

The browser example used to be called `webtransport.html`. It is now
[`browser-subscriber.html`](./browser-subscriber.html), because a name that promises WebTransport in
the one file a reader actually opens is a lie about the architecture.

## Prerequisites

- **Node 22+** — the examples use the built-in TypeScript stripper (`--experimental-strip-types`) and
  the global `WebSocket`, so there is nothing to install and nothing to build.
- A **Chromium-based browser** for the subscriber page. Firefox/Safari still render the raw test
  pattern; H.264 tracks need WebCodecs, and the page says so on screen when WebCodecs is missing.

---

## B. Run the relay yourself

```bash
git clone https://github.com/wave-av/wave-moq-edge
cd wave-moq-edge
npm install                      # only for `wrangler dev` — the examples themselves are zero-dep
./examples/interop-test.sh --local
```

That boots `wrangler dev`, publishes a generated test pattern, subscribes to it, and prints:

```
› starting a local relay: wrangler dev --port 8791
› local relay healthy: {"ok":true,"service":"moq-edge","timestamp":"2026-07-25T03:38:11.722Z"}
› relay     : ws://127.0.0.1:8791
› track     : demo/interop-1784950690
› duration  : 8s at 15 fps

─── moq-edge interop ────────────────────────────────────────
  subscribe_ok    true
  objects         147 (10 keyframes, 0 malformed envelopes)
  latency p50     4 ms
  latency p95     5 ms
  latency basis   publisher clock → subscriber clock (same host here, so no skew)
─────────────────────────────────────────────────────────────
PASS — publish → relay → subscribe round trip, 147 objects, p50 4 ms
```

A local `wrangler dev` runs with join enforcement **off** — that is the dev default in
`wrangler.toml`, not something the script turns off. Production is a different story; see route A.

### Now watch it

Leave a publisher running:

```bash
npx wrangler dev --port 8791 &                       # the relay
node --experimental-strip-types examples/server-publisher.ts publish \
  --relay ws://127.0.0.1:8791 --ns demo --track hello --seconds 120
```

and open the subscriber:

```bash
open "examples/browser-subscriber.html?relay=ws://127.0.0.1:8791&ns=demo&track=hello"
# or: python3 -m http.server -d examples 8080  →  http://localhost:8080/browser-subscriber.html
```

Click **Connect & subscribe**. You get moving colour bars with a sweeping band, and live
**latency p50 / p95 / objects-per-second / bitrate** under the canvas.

---

## A. Watch the live relay

`moq.wave.online` runs with `MOQ_JOIN_ENFORCE=enforce`: it accepts **only** a short-lived HMAC join
token minted by the WAVE gateway and bound to one namespace/track and scope. Dial it without one and
you get exactly this, immediately:

```console
$ curl -si https://moq.wave.online/v1/subscribe/demo/hello \
    -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='
HTTP/2 401
www-authenticate: Bearer realm="moq.wave.online", error="invalid_token", scheme="moq-join"

{"type":"https://httpstatuses.io/401","title":"Unauthorized","status":401,
 "detail":"join-token rejected: MOQJ_MISSING","code":"MOQJ_MISSING",
 "namespace":"demo","track":"hello"}
```

That is the design, not a misconfiguration: the gateway authorizes, the edge verifies, and the media
never travels through the gateway.

### 1. Publish

```bash
export WAVE_API_KEY=...        # read from the environment; never printed, never written to disk
node --experimental-strip-types examples/server-publisher.ts publish \
  --relay wss://moq.wave.online --ns "$YOUR_NAMESPACE" --track hello --seconds 120
```

The publisher mints its own join token (`POST /v1/moq/publish/:ns/:track` with
`Authorization: Bearer $WAVE_API_KEY`), then dials the relay directly with `?join=<token>`.
If you already hold a token, pass `--join <token>` (or set `WAVE_MOQ_JOIN`) and no key is needed.

| you see | it means |
| ------- | -------- |
| `401` / `403` from the mint | the key lacks `moq:write` (publish) or `moq:read` (subscribe) on that namespace |
| `402` from the mint         | the account has no MoQ entitlement |
| socket closes immediately   | the join token was rejected — expired, or bound to a different ns/track |

### 2. Subscribe in the browser

Mint a read token:

```bash
curl -H "authorization: Bearer $WAVE_API_KEY" \
  https://api.wave.online/v1/moq/subscribe/$YOUR_NAMESPACE/hello
```

Open [`browser-subscriber.html`](./browser-subscriber.html), set the relay to `wss://moq.wave.online`,
fill in the namespace and track, paste the token, and hit **Connect & subscribe**. The token stays in
the tab — nothing is stored and nothing is logged. Your API key never goes near the page.

### 3. Round-trip it from the CLI

```bash
WAVE_API_KEY=... ./examples/interop-test.sh --relay wss://moq.wave.online --ns "$YOUR_NAMESPACE"
```

---

## Publishing real video instead of the test pattern

The default source is a generated RGBA test pattern — no encoder, no dependencies, guaranteed to
move. To publish real H.264, hand the publisher an Annex-B elementary stream:

```bash
ffmpeg -i input.mp4 -c:v libx264 -tune zerolatency -g 30 -bsf:v h264_mp4toannexb -f h264 out.h264
node --experimental-strip-types examples/server-publisher.ts publish \
  --relay ws://127.0.0.1:8791 --ns demo --track hello --file out.h264
```

The browser page decodes those with **WebCodecs** (`VideoDecoder`, `avc1.42E01E`, in-band SPS/PPS). If
the browser has no WebCodecs, the page says so in a banner instead of showing a black canvas.

Payload framing for both modes is documented in [`moq-demo-frame.md`](./moq-demo-frame.md). It is an
examples-only convention so the browser can tell RGBA from H.264 and measure latency — **the relay
never looks at object payloads**, and a real deployment carries a real catalog and a real bitstream
instead.

## The HTTP surface

```bash
RELAY=https://moq.wave.online   # or http://127.0.0.1:8791

curl "$RELAY/health"                        # liveness + the MoQ draft version in force
curl "$RELAY/metrics"                       # Prometheus text: active tracks, build info
curl "$RELAY/v1/announce"                   # announced tracks (discovery)
curl "$RELAY/v1/catalog" | jq               # draft-ietf-moq-catalogformat-01 catalog
curl "$RELAY/v1/track/demo/hello"           # one track: subscriber count, region, last activity
```

Gateway-fronted callers reach the same handlers under the `/v1/moq/*` product prefix
(`https://api.wave.online/v1/moq/...`).

## Deploying your own instance

```bash
npx wrangler login
npx wrangler kv namespace create MOQ_TRACK_REGISTRY   # paste the id into wrangler.toml
npx wrangler r2 bucket create wave-moq-recordings     # only if you want the recording path
npx wrangler deploy --env staging
```

`wrangler.toml` documents every var and binding inline, including which ones are deliberately inert
until an operator provisions a secret. The Durable Object namespace and its migration are already
declared — nothing to create by hand.

## Where the code lives

These are worker internals, not examples — read them to understand the relay:

```
index.ts                # HTTP routing, auth gates, DO dispatch
src/moq-wire.ts         # draft-18 wire codec (pure: bytes in, structs out) + the WS envelope
src/moq-relay.ts        # per-track pub/sub fan-out state machine (pure, transport-agnostic)
moq-session-do.ts       # Durable Object: binds the relay to hibernatable WebSockets
src/moq-join-verify.ts  # join-token verification (gateway-authorized, edge-verified)
src/catalog.ts          # MSF catalog format
metrics-collector.ts    # Workers Analytics Engine emitter
__tests__/              # Vitest suite over the pure modules
```

## Common questions

**Why a Durable Object per track?** All publishers and subscribers for a track must meet in one
place. The DO is that rendezvous, and it uses the hibernation API so a long-lived session survives the
DO being evicted from memory.

**Why is the first second of latency high?** It isn't — that's the late-joiner cache. The relay keeps
the last `MOQ_CACHED_GROUPS` groups and replays them to a new subscriber so it can start decoding at a
group boundary. Those objects were captured before you subscribed, so both the browser page and the
interop script render them but exclude them from the latency stats and report them separately.

**How do I authenticate?** You don't do it yourself. The WAVE gateway authorizes the caller and mints
a scoped, short-lived join token; the relay verifies the HMAC and derives org and scope from the
signed claims, ignoring any client-supplied header. Media then flows direct to the edge.

**Is this production-ready?** The relay carries WAVE's live MoQ traffic and the draft-18 wire codec is
implemented and unit-tested. Pin a tag and read the changelog before bumping.

## Help

- Bugs: <https://github.com/wave-av/wave-moq-edge/issues>
- Spec compliance: <https://github.com/wave-av/wave-moq-edge/issues/new?template=spec-compliance.yml>
- Security: [security@wave.online](mailto:security@wave.online)
