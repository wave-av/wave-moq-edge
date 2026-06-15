import { describe, it, expect } from 'vitest';
import {
  SessionRecorder,
  sniffContainer,
  extFor,
  recordingKey,
  PART_SIZE,
} from '../recording-writer';

// ── Minimal R2 multipart fakes (record the calls the recorder makes) ───────────────────────────────
class FakeUpload {
  parts: Array<{ partNumber: number; size: number }> = [];
  completed: Array<{ partNumber: number; etag: string }> | null = null;
  aborted = false;
  constructor(
    public key: string,
    public uploadId: string,
  ) {}
  async uploadPart(partNumber: number, data: Uint8Array) {
    this.parts.push({ partNumber, size: data.length });
    return { partNumber, etag: `etag-${partNumber}` };
  }
  async complete(parts: Array<{ partNumber: number; etag: string }>) {
    this.completed = parts;
    return {} as R2Object;
  }
  async abort() {
    this.aborted = true;
  }
}
class FakeBucket {
  created: FakeUpload[] = [];
  resumed: FakeUpload[] = [];
  private seq = 0;
  async createMultipartUpload(key: string) {
    const u = new FakeUpload(key, `upload-${++this.seq}`);
    this.created.push(u);
    return u as unknown as R2MultipartUpload;
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    const u = new FakeUpload(key, uploadId);
    this.resumed.push(u);
    return u as unknown as R2MultipartUpload;
  }
}
const bucket = () => new FakeBucket() as unknown as R2Bucket & FakeBucket;
const ORG = '11111111-1111-1111-1111-111111111111';
const mb = (n: number) => new Uint8Array(n * 1024 * 1024);
/** A buffer whose first 8 bytes spell an fMP4 box type so sniffContainer returns 'fmp4'. */
function fmp4(n: number): Uint8Array {
  const b = new Uint8Array(n);
  b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70], 0); // size + "ftyp"
  return b;
}

describe('sniffContainer / extFor / recordingKey', () => {
  it('detects fMP4/CMAF box types', () => {
    for (const t of ['ftyp', 'styp', 'moof', 'moov', 'sidx']) {
      const b = new Uint8Array(8);
      b.set([...t].map((c) => c.charCodeAt(0)), 4);
      expect(sniffContainer(b)).toBe('fmp4');
    }
  });
  it('detects raw H.264 Annex-B start codes (3- and 4-byte)', () => {
    expect(sniffContainer(new Uint8Array([0, 0, 1, 0x67]))).toBe('h264');
    expect(sniffContainer(new Uint8Array([0, 0, 0, 1, 0x67]))).toBe('h264');
  });
  it('falls back to raw for anything else', () => {
    expect(sniffContainer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe('raw');
  });
  it('extFor + recordingKey are org-prefixed with the right extension', () => {
    expect(extFor('fmp4')).toBe('mp4');
    expect(extFor('h264')).toBe('h264');
    expect(extFor('raw')).toBe('bin');
    expect(recordingKey(ORG, 'sess-1', 'fmp4')).toBe(`${ORG}/recordings/sess-1/recording.mp4`);
  });
});

describe('SessionRecorder — multipart capture', () => {
  it('a small (< one part) session uploads a single last part and completes', async () => {
    const b = bucket();
    const rec = await SessionRecorder.begin(b, ORG, 'sess-1', fmp4(1024));
    const done = await rec.finalize();
    expect(done).not.toBeNull();
    expect(done!.key).toBe(`${ORG}/recordings/sess-1/recording.mp4`);
    expect(done!.bytes).toBe(1024);
    const up = b.created[0];
    expect(up.parts).toEqual([{ partNumber: 1, size: 1024 }]); // one (last) part, may be < PART_SIZE
    expect(up.completed).toHaveLength(1);
  });

  it('flushes EXACT PART_SIZE parts as bytes accumulate, with a smaller final part', async () => {
    const b = bucket();
    const rec = await SessionRecorder.begin(b, ORG, 'sess-1', fmp4(1 * 1024 * 1024));
    for (let i = 0; i < 11; i++) await rec.append(mb(1)); // total = 12 MiB
    const done = await rec.finalize();
    const up = b.created[0];
    const sizes = up.parts.map((p) => p.size);
    expect(sizes).toEqual([PART_SIZE, PART_SIZE, 2 * 1024 * 1024]); // 5 + 5 + 2 MiB
    expect(done!.bytes).toBe(12 * 1024 * 1024);
    expect(up.completed).toHaveLength(3);
    expect(up.completed!.map((p) => p.partNumber)).toEqual([1, 2, 3]);
  });

  it('a session that recorded nothing aborts and returns null (no 0-byte object)', async () => {
    const b = bucket();
    // begin with empty payload → no bytes buffered, no part on finalize
    const rec = await SessionRecorder.begin(b, ORG, 'sess-1', new Uint8Array(0));
    const done = await rec.finalize();
    expect(done).toBeNull();
    expect(b.created[0].aborted).toBe(true);
    expect(b.created[0].completed).toBeNull();
  });

  it('toMeta → resume completes a recording across a (simulated) hibernation wake', async () => {
    const b = bucket();
    const rec = await SessionRecorder.begin(b, ORG, 'sess-1', fmp4(1024));
    await rec.append(mb(6)); // crosses one PART_SIZE boundary → 1 flushed part persisted
    const meta = rec.toMeta()!;
    expect(meta.sessionId).toBe('sess-1');
    expect(meta.parts).toHaveLength(1);
    expect(meta.uploadId).toBe(b.created[0].uploadId);

    // …DO evicted; a new instance resumes from meta and finalizes.
    const resumed = SessionRecorder.resume(b, meta);
    await resumed.append(mb(1));
    const done = await resumed.finalize();
    const up = b.resumed[0];
    expect(up.completed).toHaveLength(2); // persisted part 1 + the new tail part
    expect(done!.key).toBe(meta.key);
  });
});
