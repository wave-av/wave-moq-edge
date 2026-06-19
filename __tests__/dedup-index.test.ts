import { describe, it, expect } from 'vitest';
import { InMemoryDedupIndex } from '../dedup-index';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const KEY = `${ORG_A}/recordings/sess-1/recording.mp4`;
const BUCKET = 'wave-moq-recordings';

describe('InMemoryDedupIndex', () => {
  it('claim-new → created with refcount 1 and echoes the supplied canonical key/bucket', async () => {
    const idx = new InMemoryDedupIndex();
    const c = await idx.claim(ORG_A, HASH, KEY, BUCKET, 1024);
    expect(c).toEqual({ created: true, canonicalKey: KEY, bucket: BUCKET, refcount: 1 });
  });

  it('claim-existing → not created, returns the original canonical key and an unchanged refcount', async () => {
    const idx = new InMemoryDedupIndex();
    await idx.claim(ORG_A, HASH, KEY, BUCKET, 1024);
    // a second writer claims the SAME content under a different staging key
    const dupKey = `${ORG_A}/recordings/sess-2/recording.mp4`;
    const c = await idx.claim(ORG_A, HASH, dupKey, BUCKET, 1024);
    expect(c.created).toBe(false);
    expect(c.canonicalKey).toBe(KEY); // the first object stays canonical
    expect(c.refcount).toBe(1); // claim does NOT bump refcount; addRef does
  });

  it('addRef increments refcount and records a (org, ref_key)→hash pointer', async () => {
    const idx = new InMemoryDedupIndex();
    await idx.claim(ORG_A, HASH, KEY, BUCKET, 1024);
    const after = await idx.addRef(ORG_A, 'sess-2', HASH);
    expect(after.refcount).toBe(2);
    const looked = await idx.lookup(ORG_A, HASH);
    expect(looked?.refcount).toBe(2);
  });

  it('lookup returns the canonical entry or null when absent', async () => {
    const idx = new InMemoryDedupIndex();
    expect(await idx.lookup(ORG_A, HASH)).toBeNull();
    await idx.claim(ORG_A, HASH, KEY, BUCKET, 1024);
    expect(await idx.lookup(ORG_A, HASH)).toMatchObject({ canonicalKey: KEY, bucket: BUCKET, refcount: 1 });
  });

  it('release decrements refcount and only reaches 0 after the last ref drops', async () => {
    const idx = new InMemoryDedupIndex();
    await idx.claim(ORG_A, HASH, KEY, BUCKET, 1024);
    await idx.addRef(ORG_A, 'sess-2', HASH); // refcount 2
    const r1 = await idx.release(ORG_A, HASH);
    expect(r1.refcount).toBe(1);
    const r2 = await idx.release(ORG_A, HASH);
    expect(r2.refcount).toBe(0); // contract Phase-3 deletion obeys; Slice B never calls this
  });

  it('is idempotent — a retried claim for the same content is a no-op, never a double-count', async () => {
    const idx = new InMemoryDedupIndex();
    const first = await idx.claim(ORG_A, HASH, KEY, BUCKET, 1024);
    const retry = await idx.claim(ORG_A, HASH, KEY, BUCKET, 1024);
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect((await idx.lookup(ORG_A, HASH))?.refcount).toBe(1);
  });

  it('per-org isolation — identical bytes in two orgs are two independent canonical entries', async () => {
    const idx = new InMemoryDedupIndex();
    const a = await idx.claim(ORG_A, HASH, KEY, BUCKET, 1024);
    const bKey = `${ORG_B}/recordings/sess-1/recording.mp4`;
    const b = await idx.claim(ORG_B, HASH, bKey, BUCKET, 1024);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true); // NOT deduped across orgs
    expect(b.canonicalKey).toBe(bKey);
    expect(await idx.lookup(ORG_B, HASH)).toMatchObject({ canonicalKey: bKey });
  });
});
