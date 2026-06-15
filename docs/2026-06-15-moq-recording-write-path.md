# MoQ recording write path — design (2026-06-15)

Lights the WAVE clip/replay chain at its **source**: make `wave-moq-edge` persist a publisher
session's media to R2 (org-prefixed) and register it with the gateway, so `iso_recordings` gets a row
and the clip engine can resolve → clip it.

## North-star
live publisher → object payloads streamed to R2 at `${org}/recordings/${sessionId}/recording.<ext>`
→ gateway `POST /v1/internal/recordings/register` → `iso_recordings` row (`status='ready'`) →
clip-engine resolve (presigned GET) → CF Media Transformations → `media.wave.online`. Org = isolation
boundary; gateway = org authority + registry.

## Constraint that shaped this (Jake, 2026-06-15)
"Don't pin to one format — be robust to whatever the publisher emits; do the right thing per
recording." The relay payload is **opaque** (`MoqObject.payload: Uint8Array`, no catalog/codec). So the
capture layer is **format-agnostic** (concatenate object payloads, always succeeds) and clip-ability is
detected per-recording by sniffing the first object's leading bytes.

## Components
1. **`recording-writer.ts`** (`SessionRecorder`) — one R2 **multipart** upload per publisher session.
   - `append(payload)`: accumulate; flush **exactly `PART_SIZE` (5 MiB)** parts (R2 rule: all parts but
     the last are equal-sized). Chunk-queue buffer → no quadratic copies on the hot path.
   - `finalize()`: flush the (<5 MiB) tail as the last part, `complete()`. Returns the r2_key + byte
     count, or `null` (and `abort()`s) when the session produced nothing — never a 0-byte recording.
   - `sniffContainer(first)`: `ftyp/styp/moof/moov/sidx` ⇒ `fmp4` (.mp4, directly clip-able — the MoQ
     WARP video convention); Annex-B start code ⇒ `h264` (.h264, needs a future muxer); else `raw`
     (.bin). The extension is the per-recording "right thing"; bytes are always safe.
   - **Hibernation:** multipart meta (`uploadId`, completed `parts`, `nextPartNumber`, `key`,
     `container`) is persisted to DO storage on each part flush; a wake `resume()`s and completes all
     flushed parts. The in-memory <5 MiB tail is lost only if the DO is evicted mid-session — which only
     happens after an idle gap (a live stream sends continuously), and a clean `publish_end` finalizes
     before any eviction. Documented v1 tradeoff.
2. **`register-recording.ts`** (`registerRecording`) — POSTs the gateway register envelope, bearer
   `WAVE_SERVICE_TOKEN`, fire-and-forget + fail-soft (bytes are already durable; register is retryable).
   `recordingId = sessionId` (a UUID) → idempotent by PK (a redelivered register no-ops via insert
   conflict, never a dup row). Pure `shouldRegister`/`buildRegisterBody` for unit tests, mirroring
   `usage-emit.ts`.
3. **`moq-session-do.ts`** integration — recorder created lazily on the **first** publisher object
   (so we can sniff), **only when** `publisherOrg && GATEWAY_BASE_URL && WAVE_SERVICE_TOKEN &&
   MOQ_RECORDINGS_BUCKET` are all present (else fully inert — zero behavior change). `object_received`
   → `append`; `publish_end` → `finalize` then `waitUntil(registerRecording)`.
4. **`moq-relay.ts`** — `object_received` event carries the decoded `payload` (avoids a hot-path
   double-decode in the DO). The relay still just returns data; persistence stays in the DO.
5. **`wrangler.toml`** — add `MOQ_RECORDINGS_BUCKET` var per env (the bucket *name*, which the binding
   doesn't expose) so register can name it; fix the dev binding drift (`wave-moq-recordings`).

## Honesty / safety gates (why deploying this changes nothing live)
- No `publisherOrg` (anonymous / not gateway-proxied) → no recorder (never fabricate an org).
- `WAVE_SERVICE_TOKEN` unset → inert (same gate as usage-emit; nothing recorded, no orphan R2 bytes).
- Recording append happens AFTER fan-out (never delays subscriber delivery); all R2/register failures
  are swallowed (a recording must never affect the live relay).

## Out of scope (operator / other repos — chain stays dark until these land)
- **gateway** worker config: `R2_ACCOUNT_ID`=acct `d674452f` + `R2_ACCESS_KEY_ID/SECRET`,
  `REGISTRY_BUCKETS ⊇ wave-moq-recordings-production`, `ISO_RECORDINGS_BUCKET` — required for *resolve*
  to presign the bytes this writes.
- **moq-edge** secret: `wrangler secret put WAVE_SERVICE_TOKEN --env production`.
- A real publisher that connects **through the gateway** carrying `x-wave-org` (today
  `MOQ_REQUIRE_AUTH=false`; direct traffic has no org → inert).
- Raw (`h264`/`raw`) recordings need a downstream muxer (E5 CF Containers) to become clip-able MP4;
  `fmp4` recordings are clip-able as-is.
