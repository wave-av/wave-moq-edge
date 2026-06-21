/// <reference types="@cloudflare/workers-types" />
/**
 * SingleInstanceWriter — the Slice B write-path wrapper around SessionRecorder.
 *
 * This is now a THIN FACADE over @wave-av/content-hash's `StreamingClaimWriter` (SB repin / task #56).
 * The claim-on-write decision (hash inline → claim canonical-ness → addRef + route the redundant dup into
 * `_dup/`, fail-safe on a D1/R2 error, skip-on-partial after a hibernation resume) lives in ONE tested
 * package implementation shared by every streaming FULL producer (MoQ here, realtime next). This file
 * keeps moq-session-do.ts's drop-in surface (static begin()/resume(), partCount/toMeta/safeAbort, a
 * `SingleInstanceResult` carrying `canonicalKey`) so the DO is unchanged — it just no longer vendors a
 * second copy of the must-never-false-collapse logic.
 *
 * The SessionRecorder is a structural `StreamingSink` (sessionId/bytes/append/finalize), so the claim
 * writer drives it directly. The facade additionally exposes the recorder's multipart-specific surface
 * (partCount/toMeta) that the DO persists for hibernation resume — those are recorder concerns the generic
 * StreamingSink does not model, so the facade delegates to the recorder for them.
 *
 * INVARIANTS (unchanged — now enforced by @wave-av/content-hash, design §4):
 *   • Fail-safe: if claim() throws (D1 down), KEEP the streamed object as-is — log loudly, no pointer, no
 *     dedup. Dedup is an optimization that must never endanger a customer byte.
 *   • Idempotent finalize: the underlying upload completes once; a retried finalize returns the cached
 *     result, never a second commit/double-count.
 *   • Per-org isolation: the index is keyed (org, hash), so identical bytes in two orgs stay two objects.
 *   • Skip-on-partial: a hibernation-resumed write hashes only post-wake bytes → it is marked
 *     hash-INCOMPLETE and finalize() KEEPS the object without claiming on a partial digest.
 */
import { SessionRecorder, type Container, type RecorderMeta } from './recording-writer';
import { StreamingClaimWriter, DUP_PREFIX, type ClaimDecision } from '@wave-av/content-hash';
import type { DedupIndex } from './dedup-index';

/** Transient prefix a duplicate's just-written object is re-pointed to; Slice A lifecycle TTL reclaims it. */
export { DUP_PREFIX };

/** Result of a finalized single-instance write. */
export interface SingleInstanceResult {
  /** The key a downstream consumer (register-recording) should use — the canonical object. */
  canonicalKey: string;
  /** The bucket the canonical object lives in (== this object's own bucket unless a cross-bucket dup). */
  canonicalBucket: string;
  /** The key of the object THIS operation streamed (== canonicalKey unless it was a routed duplicate). */
  key: string;
  /** Total bytes streamed. */
  bytes: number;
  /** Sniffed container of the streamed object. */
  container: Container;
  /** Lowercase hex SHA-256 of the streamed bytes; '' when dedup was skipped (a hibernation-resumed write). */
  contentHash: string;
  /** Whether this call created the canonical object (false for a duplicate or a fail-safe keep). */
  created: boolean;
}

export class SingleInstanceWriter {
  /** The underlying multipart recorder — owns the streamed object + the partCount/toMeta surface the DO persists. */
  private readonly recorder: SessionRecorder;
  /** The shared claim writer (hash inline + claimOrRoute at finalize) driving the recorder as its sink. */
  private readonly writer: StreamingClaimWriter;
  /**
   * True only when this instance hashed EVERY byte from the first object (a fresh begin()). A resume()
   * after a DO hibernation wake cannot recover the pre-wake hash → false, so finalize() KEEPS the object
   * but skips dedup, logging loudly (config-no-silent-noop) rather than silently dropping the optimization.
   */
  private readonly hashComplete: boolean;
  private readonly org: string;
  private finalized: SingleInstanceResult | null = null;

  private constructor(recorder: SessionRecorder, writer: StreamingClaimWriter, hashComplete: boolean, org: string) {
    this.recorder = recorder;
    this.writer = writer;
    this.hashComplete = hashComplete;
    this.org = org;
  }

  /**
   * Begin a single-instance recording. Mirrors SessionRecorder.begin(): the container is sniffed from
   * `first`, the multipart upload is created, and `first` is appended — the claim writer additionally folds
   * `first` into the running hash WITHOUT re-appending it (begin() already streamed it into the recorder).
   * `bucketName` is the canonical bucket the object lives in (for the DedupIndex row).
   */
  static async begin(
    bucket: R2Bucket,
    index: DedupIndex,
    bucketName: string,
    org: string,
    sessionId: string,
    first: Uint8Array,
  ): Promise<SingleInstanceWriter> {
    const recorder = await SessionRecorder.begin(bucket, org, sessionId, first);
    const writer = new StreamingClaimWriter(recorder, index, bucket, bucketName, org, /* hashComplete */ true);
    // The first object was streamed into the recorder by begin(); fold it into the running hash too
    // (without re-appending — fold MUST precede any append() per the claim writer's order guard).
    writer.foldInitialChunk(first);
    return new SingleInstanceWriter(recorder, writer, /* hashComplete */ true, org);
  }

  /**
   * Resume a recording after a DO hibernation wake (mirrors SessionRecorder.resume). The multipart upload
   * is durable + resumable, but the incremental hash state is NOT persisted, so the claim writer is marked
   * hash-INCOMPLETE (hashComplete=false) → finalize() KEEPS the object without deduping (a partial digest
   * must never claim canonical-ness or pollute the index). Rare: resuming mid-recording needs a mid-session
   * eviction, which a live stream's continuous flow avoids (recording-writer §HIBERNATION).
   */
  static resume(
    bucket: R2Bucket,
    index: DedupIndex,
    bucketName: string,
    org: string,
    meta: RecorderMeta,
  ): SingleInstanceWriter {
    const recorder = SessionRecorder.resume(bucket, meta);
    const writer = new StreamingClaimWriter(recorder, index, bucket, bucketName, org, /* hashComplete */ false);
    return new SingleInstanceWriter(recorder, writer, /* hashComplete */ false, org);
  }

  /** The publisher session id this recording belongs to (the broadcastId) — drop-in for SessionRecorder. */
  get sessionId(): string {
    return this.recorder.sessionId;
  }

  /** Parts already uploaded — the DO persists meta only when this changes (drop-in for SessionRecorder). */
  get partCount(): number {
    return this.recorder.partCount;
  }

  /** Total bytes streamed so far. */
  get bytes(): number {
    return this.recorder.bytes;
  }

  /** Snapshot the underlying multipart upload for DO storage so a hibernation wake can resume(). */
  toMeta(): RecorderMeta | null {
    return this.recorder.toMeta();
  }

  /** Abort the underlying multipart upload (best-effort) — used when a session recorded nothing. */
  safeAbort(): Promise<void> {
    return this.recorder.safeAbort();
  }

  /** Append one object payload — streamed to R2 (multipart) and fed to the running hash, no buffering. */
  async append(payload: Uint8Array): Promise<void> {
    await this.writer.append(payload);
  }

  /**
   * Finalize: complete the streamed object, compute the digest, then claim canonical-ness via the shared
   * claim writer. Returns null iff the recorder recorded nothing (no object, no claim). Idempotent — a
   * retried call returns the cached result, never a second commit/double-count. The published
   * `ClaimDecision` (which now also carries `canonicalBucket`) is mapped to `SingleInstanceResult` so the
   * DO's `done.canonicalKey ?? done.key` register path is unchanged.
   */
  async finalize(): Promise<SingleInstanceResult | null> {
    if (this.finalized) return this.finalized; // idempotent: no second commit, no double-count
    const decision = await this.writer.finalize();
    if (!decision) return null; // nothing recorded — never a 0-byte object, nothing to index
    if (!this.hashComplete) {
      // Hibernation-resumed write: the hash missed pre-wake bytes, so the shared claim writer skipped dedup
      // and kept the object (decision.contentHash === ''). Log loudly (config-no-silent-noop) — the object is
      // never dropped; dedup is an optimization, not a data-integrity guarantee (design §4).
      console.warn('SingleInstanceWriter: finalize after hibernation-resume — keeping object un-deduped (partial hash)', { key: decision.key, org: this.org });
    }
    const result = toResult(decision, this.recorder.container);
    this.finalized = result;
    return result;
  }
}

/**
 * Map the package's `ClaimDecision` onto the local `SingleInstanceResult`. The decision's `container` is a
 * generic string carried through from the sink; the recorder's sniffed `Container` is the authoritative,
 * typed value (and always matches), so use it for the strongly-typed result field.
 */
function toResult(decision: ClaimDecision, container: Container): SingleInstanceResult {
  return {
    canonicalKey: decision.canonicalKey,
    canonicalBucket: decision.canonicalBucket,
    key: decision.key,
    bytes: decision.bytes,
    container,
    contentHash: decision.contentHash,
    created: decision.created,
  };
}
