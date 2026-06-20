# Slice B — Single-Instance Write-Path Activation (SB-P2)

_Date: 2026-06-20 · Companion to `2026-06-15-moq-recording-write-path.md` · Tasks: SB-P2.1–P2.6_

## North Star (this node)
**A live MoQ recording `finalize()` on `moq.wave.online` writes THROUGH `SingleInstanceWriter` — hashed on
write, deduped per-org via the ONE canonical D1 index in `wave-storage-meter`, with raw/dup routed to
transient prefixes — and is proven live by a D1 row + an R2 listing.** Until the operator flips it on, the
write path is byte-for-byte the prior `SessionRecorder` behavior (zero change on deploy).

## What activates, and how it stays inert until named

The writer (`single-instance-writer.ts`) and the dedup index were built + deployed (inert) earlier. P2 wires
the writer into the live DO finalize path **behind a gate**:

```
dedupEnabled(session) = recordingEnabled(session)         // billing org + gateway + token + bucket name
                        && env.MOQ_DEDUP === '1'           // explicit operator flip (SB-P2.6)
                        && Boolean(env.WAVE_STORAGE_METER)  // the cross-worker dedup binding is present
```

- **Binding present ≠ active.** The `wrangler.toml` service binding (`WAVE_STORAGE_METER` → entrypoint
  `DedupRpc`) can ship and deploy with **no behavior change** — it is never invoked while `MOQ_DEDUP` is unset.
- **`MOQ_DEDUP` is the single, explicit, reversible switch** (config-no-silent-noop: a real flag, not a silent
  default). Flip it off → the DO uses the plain `SessionRecorder` again on the next session.

## Cross-worker dedup (B3) — SB-P2.1

moq-edge holds **no D1**. The one canonical per-org dedup index lives in `wave-storage-meter`. A Cloudflare
service binding exposes it as RPC:

- `wave-storage-meter/src/dedup-rpc.ts` — `class DedupRpc extends WorkerEntrypoint` exposes the six
  `DedupIndex` methods (`claim/addRef/release/lookup/lookupRef/refCountForHash`), each a thin delegation to
  the D1-backed `makeDedupIndex(this.env.DB)`. Re-exported from `worker.ts` so CF resolves the entrypoint.
- `wave-moq-edge/remote-dedup-index.ts` — `makeRemoteDedupIndex(svc)` adapts the binding into the local
  `DedupIndex` the writer already calls. Pure pass-through; the method shapes mirror
  `@wave-av/content-hash`'s `DedupIndex` exactly, so the writer is unaware it crosses a worker boundary.

## Writer in the live finalize path (B3) — SB-P2.2

`moq-session-do.ts` now holds `recorder: SessionRecorder | SingleInstanceWriter`. On the first publisher
object, `recordPayload` begins a `SingleInstanceWriter` (dedup on) or a `SessionRecorder` (dedup off);
`finalizeAndRegister` registers `done.canonicalKey ?? done.key` so a deduped write registers the **canonical**
object. Keying: **broadcastId = sessionId** (the per-publisher UUID); the writer records its dedup pointer
under that id, so two broadcasts of identical bytes collapse to one canonical object with `refcount=2`.

### Hibernation-resume → keep, never mis-dedup (the load-bearing correctness call)

The DO may be evicted mid-recording. The R2 multipart upload is durable + resumable (`RecorderMeta`), but the
**incremental SHA-256 hash state is not persisted**. A `SingleInstanceWriter.resume()` is therefore marked
`hashComplete = false`: at `finalize()` it **completes + keeps the object** but **skips the dedup claim**
entirely (a partial digest must never claim canonical-ness or pollute the index). The object is never dropped
— dedup is an optimization, not a data-integrity guarantee. This edge needs a mid-session eviction, which a
live stream's continuous flow avoids (see `recording-writer.ts` §HIBERNATION).

## Edge-canonical + pool-pointer (B4) — SB-P2.3

There is **no pool mover in moq-edge today** (verified: zero `pool` references). B4 is realized at the index
contract: the edge writes the canonical object (`claim`); any *pool-side* reference is recorded as an
`addRef(org, poolPath, hash)` **pointer** — `refcount` rises, the canonical stays the **edge** object, and no
second copy is written. A future pool mover uses this same cross-worker RPC. Proven by
`__tests__/remote-dedup-index.test.ts` ("B4 contract").

Note on dual-protocol: today the recording path is **MoQ only** (one DO per track, one recording per
broadcastId). A future SRT path would converge on one writer per broadcastId via the same seam; there is no
second protocol to wire now (no SRT recorder exists), so no dual-protocol code is added.

## SB-P2.6 — the Jake-named prod crossing (held)

Merging the activation PR auto-deploys `moq.wave.online` (`deploy.yml` on push to `main`), so it is a
named-floor crossing. Order:

1. Deploy `wave-storage-meter` **first** (publishes the `DedupRpc` entrypoint).
2. **Apply migration 0003 to the prod D1** — `wrangler d1 migrations apply wave-storage-meter --remote`
   (db `wave-storage-meter`, id `5aa2c246-…`). `deploy.yml` does NOT run migrations; this is a required,
   explicit step. Verify after: `PRAGMA foreign_key_list(dedup_ref)` shows the cascade FK. Without it,
   `release()` (P5) would orphan `dedup_ref` rows. The dedup index `DB` is already bound in `wrangler.jsonc`.
3. Deploy `wave-moq-edge` (the `WAVE_STORAGE_METER` binding now resolves).
4. Flip `MOQ_DEDUP="1"` (`wrangler` var) to activate.
5. **Prove live:** a real `finalize()` ⇒ a `dedup_index` D1 row; a byte-identical re-record ⇒ `refcount=2`,
   a `_dup/` object, and a pointer keyed by the second broadcastId (D1 row + R2 listing receipt). This live
   receipt is the ONLY coverage of the `moq-session-do.ts` dedup seam (the DO is not unit-tested) — treat it
   as a HARD gate, not "should work".

Until step 4, everything is inert and bills $0.

### ⚠ Open decision before activation — SB-P2.7 (duplicate-original reclaim)

`SingleInstanceWriter.routeToDup` copies the duplicate's just-written object to `_dup/` but does **not**
reclaim the original at its retained key, and the `_dup/`-scoped TTL cannot reach a non-`_dup/` key. So a
re-record leaves two retained objects until the reconcile-ENFORCE sweep (P5.2) collapses the dup — the
"exactly one canonical object" steady state is **not** met by the writer alone. This is a Jake decision
(touches the North Star "zero destructive deletes"): **A** drop the redundant `_dup/` copy and let
reconcile-enforce reclaim the original, or **B** copy-to-`_dup/` then delete the original (a write-path
"move" of a just-written redundant dup). Resolve + fold in the `addRef`-before-`routeToDup` ordering fix
before step 4.
