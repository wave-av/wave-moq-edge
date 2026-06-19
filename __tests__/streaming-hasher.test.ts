import { describe, it, expect } from 'vitest';
import { StreamingHasher } from '../streaming-hasher';

// Known SHA-256 vectors (hex), independent of chunking.
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('StreamingHasher', () => {
  it('digests the empty input to the known SHA-256 vector', () => {
    const h = new StreamingHasher();
    expect(h.digest()).toBe(SHA256_EMPTY);
  });

  it('digests "abc" to the known SHA-256 vector', () => {
    const h = new StreamingHasher();
    h.update(bytes('abc'));
    expect(h.digest()).toBe(SHA256_ABC);
  });

  it('is invariant to chunk boundaries — same digest regardless of split', () => {
    const whole = new StreamingHasher();
    whole.update(bytes('abcdefghijklmnopqrstuvwxyz'));

    const split = new StreamingHasher();
    split.update(bytes('abc'));
    split.update(bytes('defghij'));
    split.update(bytes('klmnopqrstuvwxyz'));

    expect(split.digest()).toBe(whole.digest());
  });

  it('ignores empty chunks (no effect on the digest)', () => {
    const a = new StreamingHasher();
    a.update(bytes('abc'));

    const b = new StreamingHasher();
    b.update(new Uint8Array(0));
    b.update(bytes('abc'));
    b.update(new Uint8Array(0));

    const bDigest = b.digest();
    expect(bDigest).toBe(a.digest());
    expect(bDigest).toBe(SHA256_ABC);
  });
});
