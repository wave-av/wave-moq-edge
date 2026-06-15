/// <reference types="@cloudflare/workers-types" />
/**
 * SessionRecorder — persist one MoQ publisher session's media to R2 as a single object via a
 * multipart upload, then hand back the key for gateway registration (register-recording.ts).
 *
 * FORMAT-AGNOSTIC by design (Jake, 2026-06-15: "be robust to whatever the publisher emits"). The relay
 * payload is opaque bytes (MoqObject.payload), so we just concatenate the publisher's object payloads in
 * arrival order. The container is *detected* from the first object's leading bytes (sniffContainer) only
 * to pick the right file extension + record what downstream can do with it — the bytes are always saved.
 *   • fmp4 (ftyp/styp/moof/…) → `.mp4`, directly clip-able by CF Media Transformations (MoQ WARP video).
 *   • h264 (Annex-B start code) → `.h264`, needs a downstream muxer to become a clip-able MP4.
 *   • raw (anything else) → `.bin`, bytes preserved for a future packaging step.
 *
 * R2 MULTIPART rule: every part except the last must be the SAME size, so we flush in exact PART_SIZE
 * (5 MiB) chunks and keep the remainder; the final part (on finalize) may be smaller. A session smaller
 * than one part uploads a single (last) part. A session with no bytes uploads nothing and aborts.
 *
 * HIBERNATION: the multipart upload (uploadId + completed parts) is durable server-side; we expose
 * toMeta()/resume() so the DO can persist that metadata and finish a recording after an eviction. Only
 * the un-flushed in-memory tail (<5 MiB) is at risk, and only across a mid-session eviction (which needs
 * an idle gap a live stream never has; a clean publish_end finalizes first).
 */

/** R2 multipart minimum part size. All parts but the last MUST equal this. */
export const PART_SIZE = 5 * 1024 * 1024;

export type Container = 'fmp4' | 'h264' | 'raw';

/** Persisted multipart state — JSON-serializable, stored in DO storage for hibernation resume. */
export interface RecorderMeta {
  /** The publisher session this upload belongs to — a wake must not resume a stale prior session's upload. */
  sessionId: string;
  key: string;
  uploadId: string;
  parts: R2UploadedPart[];
  nextPartNumber: number;
  totalBytes: number;
  container: Container;
}

/**
 * Choose the container from the first object's leading bytes. ISO-BMFF/fMP4/CMAF begins with a box whose
 * 4-char type (bytes 4..8) is one of ftyp/styp/moof/moov/sidx. Raw H.264/HEVC Annex-B begins with a
 * `00 00 01` or `00 00 00 01` start code. Everything else is treated as opaque raw bytes.
 */
export function sniffContainer(first: Uint8Array): Container {
  if (first.length >= 8) {
    const t = String.fromCharCode(first[4], first[5], first[6], first[7]);
    if (t === 'ftyp' || t === 'styp' || t === 'moof' || t === 'moov' || t === 'sidx') return 'fmp4';
  }
  if (first.length >= 3 && first[0] === 0 && first[1] === 0 && first[2] === 1) return 'h264';
  if (first.length >= 4 && first[0] === 0 && first[1] === 0 && first[2] === 0 && first[3] === 1) return 'h264';
  return 'raw';
}

/** File extension for a detected container. */
export function extFor(c: Container): string {
  return c === 'fmp4' ? 'mp4' : c === 'h264' ? 'h264' : 'bin';
}

/** Build the org-prefixed R2 key for a recording (MUST start with `${org}/` — the register boundary). */
export function recordingKey(org: string, sessionId: string, container: Container): string {
  return `${org}/recordings/${sessionId}/recording.${extFor(container)}`;
}

export class SessionRecorder {
  private bucket: R2Bucket;
  private upload: R2MultipartUpload | null = null;
  private buf: Uint8Array[] = []; // un-flushed chunk queue (sums to < PART_SIZE after each append)
  private bufLen = 0;
  private parts: R2UploadedPart[] = [];
  private nextPartNumber = 1;
  private totalBytes = 0;

  readonly key: string;
  readonly container: Container;
  readonly sessionId: string;

  private constructor(bucket: R2Bucket, key: string, container: Container, sessionId: string) {
    this.bucket = bucket;
    this.key = key;
    this.container = container;
    this.sessionId = sessionId;
  }

  /**
   * Begin a recording. The container is sniffed from the first object so the key carries the right
   * extension; the multipart upload is created here and that first object is appended.
   */
  static async begin(bucket: R2Bucket, org: string, sessionId: string, first: Uint8Array): Promise<SessionRecorder> {
    const container = sniffContainer(first);
    const key = recordingKey(org, sessionId, container);
    const rec = new SessionRecorder(bucket, key, container, sessionId);
    rec.upload = await bucket.createMultipartUpload(key);
    await rec.append(first);
    return rec;
  }

  /** Resume a recording after a DO hibernation wake from persisted metadata. */
  static resume(bucket: R2Bucket, meta: RecorderMeta): SessionRecorder {
    const rec = new SessionRecorder(bucket, meta.key, meta.container, meta.sessionId);
    rec.upload = bucket.resumeMultipartUpload(meta.key, meta.uploadId);
    rec.parts = meta.parts;
    rec.nextPartNumber = meta.nextPartNumber;
    rec.totalBytes = meta.totalBytes;
    return rec;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** Number of parts already uploaded — the DO persists meta only when this changes (not per object). */
  get partCount(): number {
    return this.parts.length;
  }

  /** Append one object payload, flushing whole PART_SIZE parts as they fill. */
  async append(payload: Uint8Array): Promise<void> {
    if (!this.upload || payload.length === 0) return;
    this.buf.push(payload);
    this.bufLen += payload.length;
    this.totalBytes += payload.length;
    while (this.bufLen >= PART_SIZE) {
      const part = this.takeExact(PART_SIZE);
      const uploaded = await this.upload.uploadPart(this.nextPartNumber, part);
      this.parts.push(uploaded);
      this.nextPartNumber += 1;
    }
  }

  /**
   * Finish the recording: flush the remaining tail as the last part and complete the upload. Returns the
   * key + total bytes, or null (after abort) when nothing was recorded — never a 0-byte object.
   */
  async finalize(): Promise<{ key: string; bytes: number; container: Container } | null> {
    if (!this.upload) return null;
    if (this.parts.length === 0 && this.bufLen === 0) {
      await this.safeAbort();
      return null;
    }
    if (this.bufLen > 0) {
      const tail = this.takeExact(this.bufLen);
      const uploaded = await this.upload.uploadPart(this.nextPartNumber, tail);
      this.parts.push(uploaded);
      this.nextPartNumber += 1;
    }
    await this.upload.complete(this.parts);
    this.upload = null;
    return { key: this.key, bytes: this.totalBytes, container: this.container };
  }

  /** Abort the multipart upload (best-effort) — used when a session recorded nothing. */
  async safeAbort(): Promise<void> {
    try {
      await this.upload?.abort();
    } catch {
      /* best-effort */
    }
    this.upload = null;
  }

  /** Snapshot for DO storage so a hibernation wake can resume(). Null until the upload exists. */
  toMeta(): RecorderMeta | null {
    if (!this.upload) return null;
    return {
      sessionId: this.sessionId,
      key: this.key,
      uploadId: this.upload.uploadId,
      parts: this.parts,
      nextPartNumber: this.nextPartNumber,
      totalBytes: this.totalBytes,
      container: this.container,
    };
  }

  /** Pull exactly `n` bytes off the front of the chunk queue into one contiguous array. */
  private takeExact(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.buf[0];
      const need = n - off;
      if (head.length <= need) {
        out.set(head, off);
        off += head.length;
        this.buf.shift();
      } else {
        out.set(head.subarray(0, need), off);
        off += need;
        this.buf[0] = head.subarray(need);
      }
    }
    this.bufLen -= n;
    return out;
  }
}
