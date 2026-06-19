/// <reference types="@cloudflare/workers-types" />
/**
 * SingleInstanceWriter — the Slice B write-path wrapper around SessionRecorder.
 *
 * Streams a publisher session to one R2 object EXACTLY as SessionRecorder does, while hashing the bytes
 * inline (StreamingHasher). At finalize() it computes the digest and asks the per-org DedupIndex to
 * `claim()` canonical-ness for that content (design §3.3):
 *   • created → the just-streamed object IS the canonical object; refcount 1, nothing else to do.
 *   • not created (byte-identical content already retained for this org) → record an addRef pointer and
 *     re-point THIS operation's just-written object to a transient `_dup/` prefix (R2 copy, NO imperative
 *     delete — Slice A lifecycle TTL reclaims it); downstream uses the existing canonicalKey.
 *
 * INVARIANTS (design §4):
 *   • Fail-safe: if claim() throws (D1 down), KEEP the streamed object as-is — log loudly, no pointer, no
 *     dedup. Dedup is an optimization that must never endanger a customer byte.
 *   • Idempotent finalize: the underlying upload completes once; a retried finalize returns the cached
 *     result, never a second commit/double-count.
 *   • Per-org isolation: the index is keyed (org, hash), so identical bytes in two orgs stay two objects.
 *
 * The only object ever physically moved is the rare byte-identical duplicate THIS call just wrote, and
 * even that is a copy to a short-TTL prefix, never a delete. Customer-retained data is untouched.
 */
import { SessionRecorder, type Container } from './recording-writer';
import { StreamingHasher } from './streaming-hasher';
import type { DedupIndex } from './dedup-index';

/** Transient prefix a duplicate's just-written object is re-pointed to; Slice A lifecycle TTL reclaims it. */
export const DUP_PREFIX = '_dup/';

/** Result of a finalized single-instance write. */
export interface SingleInstanceResult {
  /** The key a downstream consumer (register-recording) should use — the canonical object. */
  canonicalKey: string;
  /** The key of the object THIS operation streamed (== canonicalKey unless it was a routed duplicate). */
  key: string;
  /** Total bytes streamed. */
  bytes: number;
  /** Sniffed container of the streamed object. */
  container: Container;
  /** Lowercase hex SHA-256 of the streamed bytes. */
  contentHash: string;
  /** Whether this call created the canonical object (false for a duplicate or a fail-safe keep). */
  created: boolean;
}

export class SingleInstanceWriter {
  private readonly recorder: SessionRecorder;
  private readonly hasher = new StreamingHasher();
  private readonly index: DedupIndex;
  private readonly bucketName: string;
  private readonly bucket: R2Bucket;
  private readonly org: string;
  private finalized: SingleInstanceResult | null = null;

  private constructor(
    bucket: R2Bucket,
    recorder: SessionRecorder,
    index: DedupIndex,
    bucketName: string,
    org: string,
    first: Uint8Array,
  ) {
    this.bucket = bucket;
    this.recorder = recorder;
    this.index = index;
    this.bucketName = bucketName;
    this.org = org;
    // The first object was already streamed into the recorder by begin(); hash it here too.
    this.hasher.update(first);
  }

  /**
   * Begin a single-instance recording. Mirrors SessionRecorder.begin(): the container is sniffed from
   * `first`, the multipart upload is created, and `first` is appended — we additionally hash it.
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
    return new SingleInstanceWriter(bucket, recorder, index, bucketName, org, first);
  }

  /** Append one object payload — streamed to R2 (multipart) and fed to the running hash, no buffering. */
  async append(payload: Uint8Array): Promise<void> {
    await this.recorder.append(payload);
    this.hasher.update(payload);
  }

  /**
   * Finalize: complete the streamed object, compute the digest, then claim canonical-ness. Returns null
   * iff the recorder recorded nothing (no object, no claim). Idempotent — a retried call is a no-op.
   */
  async finalize(): Promise<SingleInstanceResult | null> {
    if (this.finalized) return this.finalized; // idempotent: no second commit, no double-count

    const done = await this.recorder.finalize();
    if (!done) return null; // nothing recorded — never a 0-byte object, nothing to index

    const contentHash = this.hasher.digest();

    let result: SingleInstanceResult;
    try {
      const claim = await this.index.claim(this.org, contentHash, done.key, this.bucketName, done.bytes);
      if (claim.created) {
        // First instance for this org — the streamed object IS canonical. Nothing else to do.
        result = { canonicalKey: done.key, key: done.key, bytes: done.bytes, container: done.container, contentHash, created: true };
      } else {
        // Byte-identical duplicate already retained → record a pointer and re-point THIS object to _dup/.
        await this.index.addRef(this.org, this.recorder.sessionId, contentHash);
        await this.routeToDup(done.key);
        result = { canonicalKey: claim.canonicalKey, key: done.key, bytes: done.bytes, container: done.container, contentHash, created: false };
      }
    } catch (err) {
      // Fail-safe (design §4): D1 unavailable → KEEP the streamed object as-is, log loudly, no pointer,
      // no dedup. Never drop/corrupt customer media to satisfy dedup.
      console.error('SingleInstanceWriter: dedup claim failed; keeping object un-deduped', { key: done.key, org: this.org }, err);
      result = { canonicalKey: done.key, key: done.key, bytes: done.bytes, container: done.container, contentHash, created: false };
    }

    this.finalized = result;
    return result;
  }

  /**
   * Re-point a duplicate's just-written object to the transient `_dup/` prefix. R2 has no rename, so this
   * is a copy (get→put); the original key is left for Slice A lifecycle TTL to reclaim — NO imperative
   * delete (design §3.3). Best-effort: a copy failure must not endanger the canonical object or the byte.
   */
  private async routeToDup(key: string): Promise<void> {
    const dupKey = `${DUP_PREFIX}${key}`;
    try {
      const obj = await this.bucket.get(key);
      if (!obj) {
        console.error('SingleInstanceWriter: routeToDup could not read object to re-point; left in place for TTL', { key });
        return;
      }
      await this.bucket.put(dupKey, await obj.arrayBuffer());
    } catch (err) {
      // The duplicate object stays at its original key; lifecycle TTL still reclaims it. Log, don't throw.
      console.error('SingleInstanceWriter: routeToDup failed; left in place for TTL', { key }, err);
    }
  }
}
