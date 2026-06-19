/**
 * StreamingHasher — incremental SHA-256 over streamed media chunks (Slice B single-instance write-path).
 *
 * WHY incremental: `crypto.subtle.digest` is one-shot (no streaming `update`) in Workers, but a recording
 * is streamed object-by-object and the content hash is only knowable at finalize(). We hash *while*
 * streaming so the digest is ready the instant the last byte lands — no second read of R2, no buffering
 * beyond the hash state (O(bytes) CPU, O(1) memory). Backed by `@noble/hashes/sha256` (audited,
 * dependency-free, deterministic) — never hand-roll SHA-256.
 */
import { sha256 } from '@noble/hashes/sha256';

export class StreamingHasher {
  private readonly h = sha256.create();

  /** Feed one chunk into the running digest. Empty chunks are a no-op (no effect on the result). */
  update(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.h.update(chunk);
  }

  /** Finalize and return the lowercase hex SHA-256. Call once at finalize(); the instance is then spent. */
  digest(): string {
    const out = this.h.digest();
    let hex = '';
    for (let i = 0; i < out.length; i++) hex += out[i].toString(16).padStart(2, '0');
    return hex;
  }
}
