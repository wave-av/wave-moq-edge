# #144 — Per-publisher microVM isolation + MOQT↔C2PA provenance (honest spike)

**Status: DARK / default-OFF spike.** Nothing here changes the live relay until an operator flips
`MOQ_MICROVM_ISOLATION=true`. This document separates what is **PROVEN** (with a receipt) from what is
**SCAFFOLD/design**, per the grounded architecture in wave-outreach PR #25.

## The grounded framing (do not overclaim)

- The public **"TinyMoQ" 12 MB / 35 ms** claims are **not publicly verifiable**. A 35 ms relay hop
  would require a **unikernel**; **libkrun microVMs are ~150–200 ms** cold. We do **not** claim TinyMoQ
  parity — we build to the *pattern* (per-publisher isolation) and **measure OURS honestly**.
- The genuinely **differentiated** space is the **C2PA ↔ MOQT provenance binding**:
  `draft-ietf-moq-c4m` (catalog/provenance carriage) + **CTA-5007-B CAT** (Common Access Token) +
  **C2PA v2.3** (manifest/assertion model). That is what this spike stands up in code.

## What already exists in this repo (build-on, not duplicate)

- Per-track **Durable Object** isolation (V8-isolate separation) — `moq-session-do.ts`.
- **Container-binding isolation pattern** with an honest 501 when unbound — `src/moq-sfu-fanout.ts`
  (`MOQ_SFU_FANOUT` / `ContainerBinding`). #144 mirrors this discipline exactly.
- **Bearer-token auth + scope + tenant isolation** — `src/wave-auth.ts` (`wave-token-v1`, `moq:read/write`,
  namespace→org ownership). #64 shipped the TS→MoQ ingest (`src/moq-ingest.ts`).

## The isolation model (#144)

Each **publisher** maps to a deterministic **isolation cell** (`src/publisher-isolation.ts`):

```
(org, namespace, track) → IsolationCell { cellId, substrate, host, clientMediaSafe }
```

- `cellId` is **org-scoped** (`cell:<org>:<ns>:<track>`) so two orgs sharing a track name never collide.
- `substrate ∈ { 'cloud-microvm', 'local-dev' }`. **`cloud-microvm` is the LAW-#130-safe default**;
  `local-dev` must be explicitly asked for and is **internal-dev-only**.
- The spawn is a `MicroVmBinding`-shaped interface (same discipline as `MOQ_SFU_FANOUT`). **No such
  binding exists today** → the hook returns a typed **`MOQ_MICROVM_ISOLATION_NOT_ACTIVATED`** 501. No
  transport is ever fabricated.

### LAW #130 — enforced in code, not just prose

> client/untrusted media = **CLOUD microVM ONLY**; NEVER the owned local rig.

`rejectsLocalForClient(cell, isClientMedia=true)` **fail-closes (403)** when client media is routed to
any non-`cloud-microvm` substrate. The publish hook always treats publisher media as
`isClientMedia=true`. A `local-dev` proof is allowed **only** as internal-dev (`isClientMedia=false`) and
is labelled as such. **No client-media path is wired to the local rig anywhere in this spike.**

## The MOQT ↔ C2PA provenance binding (the differentiation)

`src/provenance.ts`:

1. **`verifyProvenanceToken(token, secret)`** — FAIL-CLOSED **HMAC-SHA256** verify of
   `wave-prov-v1.<b64url(payload)>.<b64url(sig)>` via `crypto.subtle.verify` (constant-time platform
   primitive — no hand-rolled MAC compare). Bad/expired/malformed → `{valid:false}`, never throws into
   the publish path. Secret via `wrangler secret put WAVE_PROVENANCE_SECRET`.
2. **`buildProvenanceAttestation(claim, sample)`** — on a verified claim, emits a **C2PA-v2.3-shaped**
   assertion binding the **MOQT track** (namespace/track) to the producer + a **SHA-256 content digest**,
   referencing `draft-ietf-moq-c4m`, `CTA-5007-B`, `c2pa-v2.3`.

The hook (`src/publish-provenance-hook.ts`) composes both and is wired into `handlePublish` **behind the
flag** — on success it echoes `x-wave-provenance` / `x-wave-provenance-cell` / `-substrate` response
headers; on a bad token or LAW-#130 violation it fail-closes 403. **Off → pure no-op.**

### Honest scope boundary

- The attestation is a **design-accurate SHAPE**, marked `_maturity: 'shape-not-cose-signed'`. It is
  **NOT** a real COSE-signed C2PA manifest with an X.509 provenance credential yet.
- The `wave-prov-v1` HMAC token is a lightweight **provenance-session** token — distinct from the
  gateway-federated `wave-token-v1` **entitlement** bearer. Auth gates ACCESS; provenance BINDS ORIGIN.

## PROVEN vs SCAFFOLD

| Piece | State | Receipt |
|---|---|---|
| HMAC provenance verify (roundtrip + fail-closed: wrong secret, missing, tampered, expired) | **PROVEN** | `vitest run __tests__/provenance.test.ts` — 6 tests pass |
| C2PA-shaped attestation binds track→producer→sha256 digest | **PROVEN** | same suite |
| LAW-#130 guard rejects client→local-dev; allows cloud + internal-dev | **PROVEN** | `vitest run __tests__/publisher-isolation.test.ts` — 5 tests pass |
| Default-OFF no-op / honest 501 when unbound | **PROVEN** | isolation test + hook logic |
| verify+stamp latency (pure crypto.subtle) | **MEASURED** | `[#144 MEASURE] … = 0.057 ms/op (host clock)` — **NOT a relay hop** |
| Real microVM per-publisher relay cell (spawn + subscribe + fan-out) | **SCAFFOLD** | no binding; typed 501; no rust/moq-rs toolchain present |
| Real MoQ relay hop latency | **NOT PROVEN** | requires the microVM substrate below |
| COSE-signed C2PA manifest | **SCAFFOLD** | shape only (`_maturity: shape-not-cose-signed`) |

## MEASURE plan — real target numbers (to prove it for real)

The only latency proven here is the **pure verify+stamp** (~0.06 ms/op). The relay-hop numbers below are
**targets to be measured**, not claims:

1. **microVM cold-spawn** — target **≤150–200 ms** (libkrun-class); a unikernel path would target the
   ~35 ms TinyMoQ regime. Measure: spawn N cells, record P50/P95 to first-accept.
2. **Warm relay hop** (publisher object → subscriber deliver, through an isolated cell) — target
   **sub-100 ms P95** intra-region. Measure: timestamped object in, timestamped object out.
3. **Provenance overhead on the hot path** — target **<1 ms added P95** (proven ~0.06 ms in isolation).
4. **Per-publisher isolation blast-radius** — kill/OOM one cell, assert zero impact on peer publishers.

**To prove the relay hop for real (exact next step):** provision a **cloud** microVM substrate (CF
Containers or Kernel microVM — **never the local rig** for client media), stand up **moq-rs / moq-lite**
inside one per-publisher cell, bind `MOQ_MICROVM`, flip `MOQ_MICROVM_ISOLATION=true` +
`MOQ_MICROVM_SUBSTRATE=cloud-microvm`, and record the four numbers above with timestamped objects. A
LOCAL dev proof is permitted for the transport plumbing only, labelled **internal-dev-only**, and must
NOT carry client media (LAW #130).
