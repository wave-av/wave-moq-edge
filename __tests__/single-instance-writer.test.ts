import { describe, it, expect, vi } from 'vitest';
import { SingleInstanceWriter, DUP_PREFIX } from '../single-instance-writer';
import { InMemoryDedupIndex, type DedupIndex } from '../dedup-index';
import type { RecorderMeta } from '../recording-writer';

// ── Minimal R2 multipart + copy fakes (reuse the recording-writer.test.ts shape) ───────────────────
class FakeUpload {
  parts: Array<{ partNumber: number; size: number }> = [];
  totalBytes = 0;
  completed: Array<{ partNumber: number; etag: string }> | null = null;
  aborted = false;
  constructor(
    public key: string,
    public uploadId: string,
    private bucket: FakeBucket,
  ) {}
  async uploadPart(partNumber: number, data: Uint8Array) {
    this.parts.push({ partNumber, size: data.length });
    this.totalBytes += data.length;
    return { partNumber, etag: `etag-${partNumber}` };
  }
  async complete(parts: Array<{ partNumber: number; etag: string }>) {
    this.completed = parts;
    // The completed object is now readable in the bucket (so routeToDup's get() can read it back).
    this.bucket.store.set(this.key, new Uint8Array(this.totalBytes));
    return {} as R2Object;
  }
  async abort() {
    this.aborted = true;
  }
}
class FakeBucket {
  created: FakeUpload[] = [];
  /** records routed objects: { from, to } pairs from the dup re-point. */
  copies: Array<{ from: string; to: string }> = [];
  store = new Map<string, Uint8Array>();
  private seq = 0;
  async createMultipartUpload(key: string) {
    const u = new FakeUpload(key, `upload-${++this.seq}`, this);
    this.created.push(u);
    return u as unknown as R2MultipartUpload;
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    return new FakeUpload(key, uploadId, this) as unknown as R2MultipartUpload;
  }
  // SingleInstanceWriter re-points a duplicate by COPY (get→put) to a _dup/ key and leaves lifecycle TTL
  // to reclaim the original — an imperative delete is FORBIDDEN. We record each get→put-to-_dup as a copy.
  async get(key: string) {
    const body = this.store.get(key);
    if (!body) return null;
    return {
      _from: key,
      async arrayBuffer() {
        return body.buffer;
      },
    } as unknown as R2ObjectBody & { _from: string };
  }
  async put(key: string, body: ArrayBuffer | Uint8Array) {
    const u8 = body instanceof Uint8Array ? body : new Uint8Array(body);
    this.store.set(key, u8);
    if (key.startsWith(DUP_PREFIX)) this.copies.push({ from: key.slice(DUP_PREFIX.length), to: key });
    return {} as R2Object;
  }
}
const bucket = () => new FakeBucket() as unknown as R2Bucket & FakeBucket;

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BUCKET_NAME = 'wave-moq-recordings';

/** An fMP4-sniffable payload of n bytes whose tail varies with `seed` for distinct content. */
function fmp4(n: number, seed = 0): Uint8Array {
  const b = new Uint8Array(n);
  b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70], 0); // size + "ftyp"
  if (n > 8) b[n - 1] = seed & 0xff;
  return b;
}

async function record(
  b: R2Bucket & FakeBucket,
  idx: DedupIndex,
  org: string,
  sessionId: string,
  payload: Uint8Array,
) {
  const w = await SingleInstanceWriter.begin(b, idx, BUCKET_NAME, org, sessionId, payload);
  return w.finalize();
}

describe('SingleInstanceWriter', () => {
  it('new content → keeps the streamed object as canonical, refcount 1, nothing routed', async () => {
    const b = bucket();
    const idx = new InMemoryDedupIndex();
    const res = await record(b, idx, ORG_A, 'sess-1', fmp4(1024, 1));

    expect(res).not.toBeNull();
    expect(res!.created).toBe(true);
    expect(res!.canonicalKey).toBe(`${ORG_A}/recordings/sess-1/recording.mp4`);
    expect(res!.key).toBe(res!.canonicalKey); // the streamed object IS canonical
    expect(b.created[0].completed).toHaveLength(1); // streamed normally
    expect(b.copies).toHaveLength(0); // no dup re-point
    const entry = await idx.lookup(ORG_A, res!.contentHash);
    expect(entry?.refcount).toBe(1);
  });

  it('byte-identical duplicate → routes the just-written object to _dup/, addRef, returns canonical key', async () => {
    const b = bucket();
    const idx = new InMemoryDedupIndex();
    const first = await record(b, idx, ORG_A, 'sess-1', fmp4(1024, 7));
    const dup = await record(b, idx, ORG_A, 'sess-2', fmp4(1024, 7)); // same bytes

    expect(dup!.created).toBe(false);
    expect(dup!.canonicalKey).toBe(first!.canonicalKey); // downstream uses the first object
    // the duplicate's own streamed object was re-pointed under _dup/ (no imperative delete)
    expect(b.copies).toHaveLength(1);
    expect(b.copies[0].from).toBe(`${ORG_A}/recordings/sess-2/recording.mp4`);
    expect(b.copies[0].to.startsWith(DUP_PREFIX)).toBe(true);
    const entry = await idx.lookup(ORG_A, first!.contentHash);
    expect(entry?.refcount).toBe(2); // first + the dup ref
  });

  it('fail-safe: claim() throws (D1 down) → keeps the streamed object, logs error, no pointer, no dedup', async () => {
    const b = bucket();
    const downIdx: DedupIndex = {
      claim: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
      addRef: vi.fn(),
      lookup: vi.fn(),
      release: vi.fn(),
      lookupRef: vi.fn(),
      refCountForHash: vi.fn(),
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await record(b, downIdx, ORG_A, 'sess-1', fmp4(1024, 3));

    expect(res).not.toBeNull();
    expect(res!.key).toBe(`${ORG_A}/recordings/sess-1/recording.mp4`); // byte kept as-is
    expect(res!.created).toBe(false); // could not claim canonical-ness
    expect(b.created[0].completed).toHaveLength(1); // object completed, never dropped
    expect(b.copies).toHaveLength(0); // no re-point
    expect(downIdx.addRef).not.toHaveBeenCalled(); // no pointer written
    expect(err).toHaveBeenCalled(); // logged loudly
    err.mockRestore();
  });

  it('idempotent finalize: a retried finalize is a no-op, not a double-count', async () => {
    const b = bucket();
    const idx = new InMemoryDedupIndex();
    const w = await SingleInstanceWriter.begin(b, idx, BUCKET_NAME, ORG_A, 'sess-1', fmp4(1024, 9));
    const a = await w.finalize();
    const again = await w.finalize(); // retried

    expect(a!.created).toBe(true);
    expect(again).toEqual(a); // identical result, no second commit
    expect(b.created[0].completed).toHaveLength(1); // completed exactly once
    expect((await idx.lookup(ORG_A, a!.contentHash))?.refcount).toBe(1); // not bumped
  });

  it('per-org isolation: two orgs with identical bytes → two canonical objects', async () => {
    const b = bucket();
    const idx = new InMemoryDedupIndex();
    const a = await record(b, idx, ORG_A, 'sess-1', fmp4(1024, 5));
    const c = await record(b, idx, ORG_B, 'sess-1', fmp4(1024, 5)); // same bytes, other org

    expect(a!.created).toBe(true);
    expect(c!.created).toBe(true); // NOT deduped across orgs
    expect(c!.canonicalKey).toBe(`${ORG_B}/recordings/sess-1/recording.mp4`);
    expect(b.copies).toHaveLength(0); // neither was a within-org dup
  });

  it('broadcastId keying: distinct sessions, identical bytes → one canonical, refcount 2, pointer keyed by broadcastId', async () => {
    // The cross-broadcast "edge canonical + pointer" path (B4): two broadcastIds, ONE retained object.
    const b = bucket();
    const idx = new InMemoryDedupIndex();
    const first = await record(b, idx, ORG_A, 'broadcast-1', fmp4(2048, 42));
    const dup = await record(b, idx, ORG_A, 'broadcast-2', fmp4(2048, 42)); // different broadcastId, same bytes

    expect(first!.created).toBe(true);
    expect(dup!.created).toBe(false);
    expect(dup!.canonicalKey).toBe(first!.canonicalKey); // broadcast-2 resolves to broadcast-1's object
    expect(await idx.lookupRef(ORG_A, 'broadcast-2')).toBe(first!.contentHash); // pointer keyed by broadcastId
    expect((await idx.lookup(ORG_A, first!.contentHash))?.refcount).toBe(2);
  });

  it('hibernation-resume → keeps the object, NO dedup claim (a partial hash must not pollute the index)', async () => {
    const b = bucket();
    const idx = new InMemoryDedupIndex();
    const claimSpy = vi.spyOn(idx, 'claim');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A recorder that flushed one durable part before a mid-session eviction; its hash state is unrecoverable.
    const meta: RecorderMeta = {
      sessionId: 'sess-resumed',
      key: `${ORG_A}/recordings/sess-resumed/recording.mp4`,
      uploadId: 'upload-resumed',
      parts: [{ partNumber: 1, etag: 'etag-1' } as R2UploadedPart],
      nextPartNumber: 2,
      totalBytes: 5 * 1024 * 1024,
      container: 'fmp4',
    };
    const w = SingleInstanceWriter.resume(b, idx, BUCKET_NAME, ORG_A, meta);
    const res = await w.finalize();

    expect(res).not.toBeNull();
    expect(res!.created).toBe(false); // could not claim on a partial hash
    expect(res!.contentHash).toBe(''); // no content hash available post-wake
    expect(res!.canonicalKey).toBe(meta.key); // object kept at its own key — never dropped
    expect(claimSpy).not.toHaveBeenCalled(); // dedup SKIPPED — index untouched
    expect(b.copies).toHaveLength(0);
    expect(warn).toHaveBeenCalled(); // logged loudly (config-no-silent-noop)
    warn.mockRestore();
  });

  it('DO drop-in surface: sessionId / partCount / bytes / toMeta delegate to the recorder', async () => {
    const b = bucket();
    const idx = new InMemoryDedupIndex();
    const w = await SingleInstanceWriter.begin(b, idx, BUCKET_NAME, ORG_A, 'sess-meta', fmp4(1024, 13));
    expect(w.sessionId).toBe('sess-meta');
    expect(w.partCount).toBe(0); // <5MiB buffered, no part flushed yet
    expect(w.bytes).toBe(1024);
    const meta = w.toMeta();
    expect(meta).not.toBeNull();
    expect(meta!.sessionId).toBe('sess-meta');
    expect(meta!.key).toBe(`${ORG_A}/recordings/sess-meta/recording.mp4`);
  });
});
