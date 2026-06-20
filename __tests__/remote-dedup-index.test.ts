import { describe, it, expect, vi } from 'vitest';
import { InMemoryDedupIndex } from '../dedup-index';
import { makeRemoteDedupIndex, type DedupService } from '../remote-dedup-index';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HASH = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const KEY = `${ORG}/recordings/s1/recording.mp4`;
const BUCKET = 'wave-moq-recordings';

// A fake "service binding": wave-storage-meter's DedupRpc backed by a local InMemoryDedupIndex, standing
// in for the real cross-worker D1 index. InMemoryDedupIndex implements all six methods, so it structurally
// satisfies DedupService — exactly the shape the binding's RPC stub presents to moq-edge.
function fakeService(): DedupService {
  return new InMemoryDedupIndex();
}

describe('makeRemoteDedupIndex — faithful pass-through to the DedupRpc service binding (SB-P2.1)', () => {
  it('forwards claim/addRef/lookup with the refcount-correct idempotent semantics', async () => {
    const idx = makeRemoteDedupIndex(fakeService());
    const first = await idx.claim(ORG, HASH, KEY, BUCKET, 1024);
    expect(first.created).toBe(true);
    expect(first.canonicalKey).toBe(KEY);
    expect(first.refcount).toBe(1);

    // A second claim of the same content is idempotent — created false, claim NEVER bumps refcount.
    const again = await idx.claim(ORG, HASH, `${ORG}/recordings/s2/recording.mp4`, BUCKET, 1024);
    expect(again.created).toBe(false);
    expect(again.canonicalKey).toBe(KEY);
    expect(await idx.refCountForHash(ORG, HASH)).toBe(1);

    // addRef owns the increment + writes the pointer.
    const ref = await idx.addRef(ORG, 's2', HASH);
    expect(ref.added).toBe(true);
    expect(ref.refcount).toBe(2);
    expect(await idx.lookupRef(ORG, 's2')).toBe(HASH);
    expect((await idx.lookup(ORG, HASH))?.refcount).toBe(2);
  });

  it('forwards release (decrement + physical-removal signal at refcount 0)', async () => {
    const idx = makeRemoteDedupIndex(fakeService());
    await idx.claim(ORG, HASH, KEY, BUCKET, 10);
    await idx.addRef(ORG, 's2', HASH); // refcount 2
    const r1 = await idx.release(ORG, HASH);
    expect(r1.removed).toBe(false);
    expect(r1.refcount).toBe(1);
    const r2 = await idx.release(ORG, HASH);
    expect(r2.removed).toBe(true); // reached 0 → canonical row removed (lib performs NO R2 delete)
    expect(await idx.lookup(ORG, HASH)).toBeNull();
  });

  it('every adapter method delegates to the underlying service (call-through proof)', async () => {
    const svc = fakeService();
    const spies = {
      claim: vi.spyOn(svc, 'claim'),
      addRef: vi.spyOn(svc, 'addRef'),
      release: vi.spyOn(svc, 'release'),
      lookup: vi.spyOn(svc, 'lookup'),
      lookupRef: vi.spyOn(svc, 'lookupRef'),
      refCountForHash: vi.spyOn(svc, 'refCountForHash'),
    };
    const idx = makeRemoteDedupIndex(svc);
    await idx.claim(ORG, HASH, KEY, BUCKET, 1);
    await idx.addRef(ORG, 's2', HASH);
    await idx.lookup(ORG, HASH);
    await idx.lookupRef(ORG, 's2');
    await idx.refCountForHash(ORG, HASH);
    await idx.release(ORG, HASH);
    for (const [name, spy] of Object.entries(spies)) {
      expect(spy, name).toHaveBeenCalledTimes(1);
    }
  });

  it('B4 contract: a pool-side reference is a POINTER to the edge-canonical object, never a second copy', async () => {
    // The edge writes the canonical object (claim). A pool reference (keyed by a pool path) is recorded as
    // an addRef pointer — refcount rises, but exactly ONE canonical object/key exists, and it stays the
    // EDGE object. This is the cross-worker shape a future pool mover uses via this same RPC binding.
    const idx = makeRemoteDedupIndex(fakeService());
    const edgeKey = `${ORG}/recordings/b1/recording.mp4`;
    const claim = await idx.claim(ORG, HASH, edgeKey, BUCKET, 4096);
    expect(claim.created).toBe(true);

    const poolPath = `pool/${ORG}/b1.mp4`;
    const ref = await idx.addRef(ORG, poolPath, HASH);
    expect(ref.added).toBe(true);
    expect(ref.refcount).toBe(2);
    expect(await idx.lookupRef(ORG, poolPath)).toBe(HASH); // pool path resolves to the same content hash
    expect((await idx.lookup(ORG, HASH))?.canonicalKey).toBe(edgeKey); // canonical stays the EDGE object
  });
});
