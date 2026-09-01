/**
 * MoQ Transport byte cursor primitives — the growable big-endian `Writer` and `Reader` over a
 * `Uint8Array`, plus the draft-18 §1.4.1 varint codec they implement. Split out of `moq-wire.ts`
 * (#212 file-size follow-up, epic #212) once the wire-codec module crossed the repo's file-size
 * advisory; re-exported from `moq-wire.ts` (`export * from './moq-wire-primitives.ts'`) so every
 * existing `from './moq-wire'` import (and every sibling `moq-wire-*.ts` module's own
 * `from './moq-wire.ts'` import) keeps working unchanged — this file is additive plumbing, not a
 * behavior change; the byte-level codec logic is moved verbatim, untouched.
 *
 * PURE: no I/O, no platform calls. Every other wire-codec module (`moq-wire.ts` and its
 * `moq-wire-*.ts` siblings) builds on these two classes — this is the lowest-level layer of the
 * codec, hence its own module rather than folded into any one message family's file.
 */

// ── byte cursor primitives ─────────────────────────────────────────────────────────────────────

/** Growable big-endian byte writer. */
export class Writer {
  private buf: number[] = [];
  bytes(): Uint8Array {
    return new Uint8Array(this.buf);
  }
  u8(v: number): this {
    this.buf.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    this.buf.push((v >> 8) & 0xff, v & 0xff);
    return this;
  }
  raw(b: Uint8Array): this {
    for (const x of b) this.buf.push(x);
    return this;
  }
  /** draft-18 §1.4.1 leading-1-bits varint. Accepts number or bigint; range [0, 2^64). */
  varint(value: number | bigint): this {
    const v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    if (v < 0n) throw new RangeError('varint must be non-negative');
    // Smallest size N whose capacity (7N bits for N≤8, 64 for N=9) holds v.
    let n = 9;
    for (let k = 1; k <= 8; k++) {
      if (v < 1n << BigInt(7 * k)) {
        n = k;
        break;
      }
    }
    if (n === 9 && v >= 1n << 64n) throw new RangeError('varint exceeds 2^64-1');
    const out = new Uint8Array(n);
    // Big-endian value into the N-byte field; top N bits of byte0 reserved for the prefix.
    let tmp = v;
    for (let i = n - 1; i >= 0; i--) {
      out[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }
    if (n <= 8) out[0] |= (0xff << (9 - n)) & 0xff; // (n-1) leading ones + terminating zero
    else out[0] = 0xff; // n === 9: all-ones first byte signals the 9-byte form
    return this.raw(out);
  }
  /** Length-prefixed byte string: varint(len) + bytes. */
  bytesLP(b: Uint8Array): this {
    return this.varint(b.length).raw(b);
  }
  /** UTF-8 string as a length-prefixed byte string. */
  strLP(s: string): this {
    return this.bytesLP(new TextEncoder().encode(s));
  }
  /** Track Namespace tuple (§1.4.2): count(i) + N length-prefixed fields. */
  tuple(fields: string[]): this {
    this.varint(fields.length);
    for (const f of fields) this.strLP(f);
    return this;
  }
}

/** Big-endian byte reader over a Uint8Array. */
export class Reader {
  private pos = 0;
  constructor(private readonly b: Uint8Array) {}
  get offset(): number {
    return this.pos;
  }
  get remaining(): number {
    return this.b.length - this.pos;
  }
  u8(): number {
    if (this.pos >= this.b.length) throw new RangeError('read past end (u8)');
    return this.b[this.pos++];
  }
  u16(): number {
    const hi = this.u8();
    const lo = this.u8();
    return (hi << 8) | lo;
  }
  raw(len: number): Uint8Array {
    if (this.pos + len > this.b.length) throw new RangeError('read past end (raw)');
    const out = this.b.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  /** draft-18 §1.4.1 leading-1-bits varint → bigint. */
  varint(): bigint {
    const b0 = this.u8();
    // Count leading 1 bits in b0.
    let lead = 0;
    let probe = b0;
    while (lead < 8 && probe & 0x80) {
      lead++;
      probe = (probe << 1) & 0xff;
    }
    if (lead === 8) {
      // 9-byte form: b0 is all prefix; value is the next 8 bytes big-endian.
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.u8());
      return v;
    }
    const n = lead + 1; // total byte count
    let v = BigInt(b0 & (0xff >> n)); // low (8-n) value bits of byte0
    for (let i = 1; i < n; i++) v = (v << 8n) | BigInt(this.u8());
    return v;
  }
  /** Read a varint as a JS number (throws if it would lose precision). */
  varintNum(): number {
    const v = this.varint();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('varint exceeds safe integer');
    return Number(v);
  }
  bytesLP(): Uint8Array {
    const len = this.varintNum();
    return this.raw(len);
  }
  strLP(): string {
    return new TextDecoder().decode(this.bytesLP());
  }
  tuple(): string[] {
    const count = this.varintNum();
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(this.strLP());
    return out;
  }
}
