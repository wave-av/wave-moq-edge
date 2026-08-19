# moq-client — a non-Worker MoQ interop client

A standalone MoQ client that runs **outside** the Workers runtime. It exists because Cloudflare
Workers has no QUIC/WebTransport **client** API, so this relay cannot initiate a MoQ session against
an external peer from its own runtime — which blocked every third-party interop measurement.

It does two separable jobs:

| Command | What it answers |
| --- | --- |
| `probe-alpn` | Which MoQ ALPNs does a peer **accept or refuse**, over native QUIC? |
| `subscribe` / `publish` | Does a MoQ session actually work — objects, ordering, p50/p95? |

Those are two different questions and this tool keeps them apart on purpose (see
[ALPN vs. SETUP](#alpn-is-not-the-same-question-as-setup) below).

---

## The measurement

Run on **2026-07-24** from a residential/office egress. Reproduce with
`npm run moq-client -- probe-alpn`.

Each ALPN is offered **in isolation**, so the verdict is unambiguous. `h3` is a control: it proves
the peer is a live QUIC server and that the prober works, so that a refusal is a fact about the peer
rather than a bug in us.

### `interop-relay.cloudflare.mediaoverquic.com:443` — public MoQ interop relay

| ALPN offered | Result | Evidence |
| --- | --- | --- |
| `h3` *(control)* | **accepted** | ServerHello, no alert |
| `moqt-16` | **accepted** | ServerHello, no alert |
| `moqt-20`, `moqt-19`, `moqt-18`, `moqt-17`, `moqt-15`, `moqt-14`, `moqt-13`, `moqt-12`, `moqt-11`, `moqt-10`, `moqt-09`, `moqt-08`, `moqt-07`, `moqt-06`, `moq-00` | **refused** | `CONNECTION_CLOSE 0x178` = CRYPTO_ERROR + TLS alert 120 `no_application_protocol`, reason `"peer doesn't support any known protocol"` |

**`moqt-16` is the only MoQ ALPN this relay accepts** — one of sixteen tested. The refusals are not
inferred from a timeout; each is an explicit `no_application_protocol` alert carrying the peer's own
reason string.

### `moq.dev:443`

`h3` accepted; **every** `moqt-*` and `moq-00` refused with alert 120. It is a web origin, not a
relay. Listed so the negative is on the record rather than being retried by the next person.

### Controls — `cloudflare.com:443`, `www.google.com:443`

`h3` accepted; every `moqt-*` refused with alert 120. These are definitively not MoQ relays, and
they produce exactly the same refusal signature as a real relay refusing a version it does not
serve. That equivalence is what makes the interop relay's `moqt-16` **acceptance** meaningful.

### What this resolves, and what it does not

- **Resolved:** the prediction that `moqt-18` "fails outright against any current peer" is **half
  right for the wrong reason**. It fails against this relay — but so does `moqt-19`, and so does
  everything except `moqt-16`. The peer is not ahead of us or behind us on a moving edge; it is
  pinned to one draft.
- **Actionable:** this relay advertises `MOQ_DRAFT_SUPPORTED = "18,17,16,15,…,7"`, which **includes
  16**. There is therefore a real ALPN overlap, and interop against this peer is reachable today at
  draft-16 — not blocked, just not at 18 or 19.
- **Not resolved:** whether a MoQ *session* completes over that `moqt-16` ALPN. Acceptance is a TLS
  fact, not a session receipt. Getting that receipt needs a full QUIC/MoQ data plane at draft-16 —
  see [Limits](#limits).
- **Out-of-band observation:** the relay's **TCP** 443 certificate expired `2026-05-13`
  (`notAfter=May 13 17:59:53 2026 GMT`, CN matches the host). That is the TCP listener, not the QUIC
  one — the QUIC handshake above reached ServerHello — but it is worth knowing before anyone blames
  their own client. No certificate verification was disabled anywhere in this tool to obtain any
  result above.

## Session receipt — WAVE's own relay

```
$ node --experimental-transform-types tools/moq-client/cli.ts \
    publish wss://moq.staging.wave.online/v1/publish/interop/probe \
    --ns=interop --track=probe --count=30 --interval=150 --bytes=64

publisher   outcome ok · published 30 object(s) · monotonic=true outOfOrder=0 missing=0
            latency p50=0.186ms p95=0.356ms n=30      (client-side send cost)

$ node --experimental-transform-types tools/moq-client/cli.ts \
    subscribe wss://moq.staging.wave.online/v1/subscribe/interop/probe \
    --ns=interop --track=probe --duration=15000 --max-objects=30

subscriber  outcome ok · received 30 object(s) · monotonic=true outOfOrder=0 missing=0
            latency p50=33ms p95=126ms min=26ms max=260ms n=30   (publisher -> relay -> subscriber)
```

All 30 objects arrived, in order, with no gaps. The subscriber's figures are true end-to-end
latency: each payload carries the publisher's send timestamp, and objects without one are counted
but contribute no latency sample, so the percentile can never quietly report clock skew as latency.
Percentiles are nearest-rank, so every number printed is a sample that was actually measured.

---

## Usage

```bash
npm run moq-client -- probe-alpn                       # every built-in target
npm run moq-client -- probe-alpn cf-interop --json
npm run moq-client -- probe-alpn relay.example:4433 --alpn=moqt-19,moqt-18
npm run moq-client -- subscribe wss://host/v1/subscribe/ns/track --ns=ns --track=track
npm run moq-client -- publish  wss://host/v1/publish/ns/track --ns=ns --track=track --count=30
```

### MCP (agent surface)

The MCP server exposes `publish_subgroup`, `subscribe`, `status`, and `publish_health` as stdio
JSON-RPC tools for agent consumption — see `mcp.ts`. Run with `--self-test` for a smoke check.

Auth: set `MOQ_JOIN_TOKEN` in the environment. It is appended as `?join=…` because the relay reads
that query parameter (browser WebSocket clients cannot set headers), and **every URL this tool
prints is redacted first**. No credential is ever written to stdout, and none is stored in the repo.

Every failure mode is a first-class result with the same output shape as a success — connection
refused, ALPN mismatch, auth rejected, track not found. A failed interop attempt is a receipt, not
an error to swallow.

## Runtime — Node, and why

| Option | Verdict |
| --- | --- |
| **Node + hand-rolled QUIC Initial** | **Chosen.** |
| Node `node:quic` | Not available. Not compiled into any Node on this machine, including v26. |
| Node WebTransport addon | ALPN is hard-coded `h3` — structurally cannot answer the ALPN question. |
| Rust + `quinn` | No Rust toolchain present; and it would fork the wire codec. |

The deciding factor is the codec. `src/moq-wire.ts` is the draft-18 codec this relay actually runs,
and it is imported **unmodified** — not ported, not copied. A client carrying its own second copy of
the codec would prove only that the copy agrees with itself. `src/moq-wire.ts` was not changed.

For the ALPN half, a full QUIC stack turns out to be unnecessary. ALPN is settled in the first
flight, and the QUIC **Initial** packet space is protected by keys derived from a public, spec-fixed
salt and the client-chosen connection ID (RFC 9001 §5.2). So `node:crypto` + `node:dgram` is enough
to send a real ClientHello and decrypt the real reply. The key schedule is verified against the
**RFC 9001 Appendix A published test vectors** in the unit tests — not against itself.

### ALPN is not the same question as SETUP

Over **raw QUIC**, the MoQ draft version *is* the ALPN (`moqt-NN`). Over **WebTransport**, ALPN is
always `h3` and the draft version is negotiated inside the MoQ SETUP message instead. Conflating the
two is how "we tested interop" turns into a claim that was never measured. `probe-alpn` speaks raw
QUIC and reports ALPN; `subscribe`/`publish` run a session and report SETUP-level facts. Neither
one pretends to answer the other's question.

## Limits — stated, not worked around

- **We read refusals exactly; we infer acceptances.** A refusal is an explicit alert-120 frame in the
  Initial space. An acceptance is "ServerHello came back and no alert did" — because the *negotiated*
  ALPN travels in EncryptedExtensions, in the Handshake space, which needs the full TLS key schedule
  we do not implement. Offering one ALPN at a time is what makes that inference airtight: with a
  single-element offer, nothing else could have been selected. The joint multi-ALPN probe therefore
  reports accept/refuse as a **set** and deliberately refuses to name a winner it cannot read.
- **No `moqt-16` session.** The imported codec is draft-18. Completing a session against the interop
  relay needs a draft-16 data plane over raw QUIC, which this tool does not have.
- **Node version.** `src/moq-wire.ts` uses a TypeScript parameter property, which Node's *strip-only*
  mode rejects. Run on **Node 22.23–24.x**, which have `--experimental-transform-types`; Node 26
  removed that flag. Unit tests are unaffected (vitest transforms TypeScript itself).
- **WebTransport transport is optional.** It loads lazily from `@fails-components/webtransport`; if
  absent, the error names the exact install command. Build, type-check and tests never require it.

## Layout

```
tools/moq-client/
  cli.ts                 probe-alpn / subscribe / publish; token redaction
  mcp.ts                 MCP surface: stdio JSON-RPC 2.0 (publish_subgroup, subscribe, status, publish_health)
  src/quic-crypto.ts     RFC 9001 §5 packet protection, HKDF, QUIC varints
  src/tls-hello.ts       TLS 1.3 ClientHello + ALPN extension; server-flight classification
  src/quic-alpn.ts       the prober: frame parsing, accept/refuse verdicts
  src/transport.ts       WebSocket (WAVE relay) and lazy WebTransport bindings
  src/session.ts         SETUP/SUBSCRIBE/PUBLISH over any transport; ordering + percentiles
  src/targets.ts         interop targets and the ALPN candidate set
  __tests__/             40 tests, incl. the RFC 9001 Appendix A vectors
```

```bash
npm run test:client        # 40 tests
npm run typecheck:client   # node-typed project, separate from the Worker's tsconfig
```
