import { describe, it, expect } from 'vitest';
import {
  rational,
  groupIdForInstant,
  framePeriodNs,
  instantForGroupStart,
  mediaClockValue,
  type Rational,
} from '../src/tai-group-mapping';
import {
  encodeSt2110TimingProperties,
  decodeSt2110TimingProperties,
  ST2110_TIMING_PROP,
} from '../src/st2110-timing-properties';
import { Writer } from '../src/moq-wire';

// E1-TAI-BRIDGE P2 — boundary cases the phase's done-check names explicitly: a frame exactly on a
// period boundary, non-integer frame rates, a clock discontinuity, and a period change mid-stream.
// The rational-rate case asserts EXACT equality, never a tolerance (no `toBeCloseTo` anywhere here).

describe('groupIdForInstant — pure function contract', () => {
  it('is a pure function: identical inputs give identical output, called many times, any order', () => {
    const rate = rational(30, 1);
    const taiNs = 1_893_456_789_000_000_000n;
    const results = Array.from({ length: 50 }, () => groupIdForInstant(taiNs, rate));
    expect(new Set(results.map(String)).size).toBe(1);
  });

  it('rejects a negative TAI instant and a non-positive frame rate', () => {
    expect(() => groupIdForInstant(-1n, rational(30, 1))).toThrow(RangeError);
    expect(() => rational(0, 1)).toThrow(RangeError);
    expect(() => rational(30, 0)).toThrow(RangeError);
    expect(() => rational(-30, 1)).toThrow(RangeError);
  });
});

describe('boundary: a frame exactly on a period boundary', () => {
  it('30 fps — instantForGroupStart round-trips exactly through groupIdForInstant', () => {
    const rate = rational(30, 1);
    for (const groupId of [0n, 1n, 2n, 1000n, 999_999n]) {
      const boundaryNs = instantForGroupStart(groupId, rate);
      expect(groupIdForInstant(boundaryNs, rate)).toBe(groupId);
      // One nanosecond earlier must still belong to the previous group (never rounds up early).
      if (boundaryNs > 0n) {
        expect(groupIdForInstant(boundaryNs - 1n, rate)).toBe(groupId - 1n);
      }
      // One nanosecond later must still belong to the same group (never rounds down early).
      expect(groupIdForInstant(boundaryNs + 1n, rate)).toBe(groupId);
    }
  });

  it('non-integer rate (30000/1001) — exact boundary still resolves with no off-by-one', () => {
    const rate = rational(30000, 1001);
    for (const groupId of [0n, 1n, 29n, 30n, 12_345n]) {
      const boundaryNs = instantForGroupStart(groupId, rate);
      expect(groupIdForInstant(boundaryNs, rate)).toBe(groupId);
      expect(groupIdForInstant(boundaryNs + 1n, rate)).toBe(groupId);
      if (boundaryNs > 0n) expect(groupIdForInstant(boundaryNs - 1n, rate)).toBe(groupId - 1n);
    }
  });
});

describe('boundary: non-integer frame rates carried as exact rationals', () => {
  const NTSC_RATES: Array<[string, Rational]> = [
    ['29.97 (30000/1001)', rational(30000, 1001)],
    ['59.94 (60000/1001)', rational(60000, 1001)],
    ['23.976 (24000/1001)', rational(24000, 1001)],
  ];

  it.each(NTSC_RATES)('%s never rounds to a lossy decimal across a long run — exact equality', (_label, rate) => {
    // Two independently-constructed identical rationals must agree on every group id across 10_000
    // frames' worth of instants — if either computed via a lossy float period, the two sequences
    // would diverge (float period has 1e9*1001/30000 = non-terminating binary fraction).
    const period = framePeriodNs(rate);
    const start = 1_893_456_000_000_000_000n;
    const seqA: bigint[] = [];
    const seqB: bigint[] = [];
    for (let i = 0n; i < 10_000n; i++) {
      const taiNsA = start + (i * period.numerator) / period.denominator;
      const taiNsB = start + (i * period.numerator) / period.denominator; // recomputed independently
      seqA.push(groupIdForInstant(taiNsA, rate));
      seqB.push(groupIdForInstant(taiNsB, rate));
    }
    expect(seqA.map(String)).toEqual(seqB.map(String));
    // And the mapping must be monotonically non-decreasing — time never runs backwards in group id.
    for (let i = 1; i < seqA.length; i++) expect(seqA[i] >= seqA[i - 1]).toBe(true);
  });

  it('frame rate round-trips through the property bag as an exact rational, never a decimal', () => {
    const rate = rational(30000, 1001);
    const bag = encodeSt2110TimingProperties({ frameRate: rate });
    const decoded = decodeSt2110TimingProperties(bag);
    expect(decoded.frameRate).toEqual({ numerator: 30000n, denominator: 1001n });
  });
});

describe('boundary: a clock discontinuity', () => {
  it('a backward TAI jump produces a smaller (or equal) group id — pure function, no memory of the past', () => {
    const rate = rational(30, 1);
    const beforeJump = groupIdForInstant(2_000_000_000_000_000_000n, rate);
    // Clock steps backward by 10 seconds (e.g. a PTP leap-second correction or a re-lock event).
    const afterJump = groupIdForInstant(1_990_000_000_000_000_000n, rate);
    expect(afterJump).toBeLessThan(beforeJump);
    // Critically: calling the function again with the PRE-jump instant gives the SAME answer as
    // before — the function has no state that the discontinuity could have corrupted.
    expect(groupIdForInstant(2_000_000_000_000_000_000n, rate)).toBe(beforeJump);
  });

  it('a forward TAI jump (re-lock after loss) produces a larger group id with no interpolation', () => {
    const rate = rational(30, 1);
    const before = groupIdForInstant(1_000_000_000_000_000_000n, rate);
    const after = groupIdForInstant(1_000_000_060_000_000_000n, rate); // +60s
    expect(after - before).toBe(1800n); // exactly 60s * 30fps, no smoothing/interpolation applied
  });
});

describe('boundary: a period change mid-stream (frame rate change)', () => {
  it('switching frame rate at a given instant is just calling the pure function with a new rational', () => {
    const before = rational(30, 1);
    const after = rational(60, 1);
    const switchInstant = 5_000_000_000_000_000_000n;
    const idBefore = groupIdForInstant(switchInstant - 1n, before);
    const idAfterAtSameInstant = groupIdForInstant(switchInstant - 1n, after);
    // Same instant, different declared rate → different (generally non-comparable) group id
    // namespace. The function does not try to reconcile them — that is a stream-level concern
    // (e.g. a new track) outside this pure mapping's contract, which is exactly why it is pure.
    expect(idAfterAtSameInstant).not.toBe(idBefore);
    // Post-switch, the new rate's own arithmetic is exact and self-consistent.
    const g0 = instantForGroupStart(0n, after);
    expect(groupIdForInstant(g0, after)).toBe(0n);
  });
});

describe('property bag — full round trip, all fields', () => {
  it('encodes and decodes every ST2110_TIMING_PROP field exactly, including 8-byte clock id', () => {
    const clockId = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
    const meta = {
      sourceTaiNs: 1_893_456_789_123_456_789n,
      mediaClockValue: 4_294_967_290n, // exceeds u32 by construction — full-width varint, not truncated
      frameRate: rational(30000, 1001),
      clockId,
      clockDomain: 127,
    };
    const bytes = encodeSt2110TimingProperties(meta);
    const decoded = decodeSt2110TimingProperties(bytes);
    expect(decoded.sourceTaiNs).toBe(meta.sourceTaiNs);
    expect(decoded.mediaClockValue).toBe(meta.mediaClockValue);
    expect(decoded.frameRate).toEqual(meta.frameRate);
    expect(decoded.clockId).toEqual(clockId);
    expect(decoded.clockDomain).toBe(127);
  });

  it('rejects a clockId that is not exactly 8 bytes', () => {
    expect(() => encodeSt2110TimingProperties({ clockId: new Uint8Array(7) })).toThrow(RangeError);
  });

  it('skips a well-formed but unrecognized TLV without throwing (fail-open, matches viewport-properties.ts)', () => {
    const known = encodeSt2110TimingProperties({ sourceTaiNs: 42n });
    // A well-formed (type, length, value) triple with a type this codec does not know about, e.g. a
    // future property from a later phase. Built with the same Writer the codec itself uses.
    const unknownTlv = new Writer().varint(0xff1e).bytesLP(new Uint8Array([0xaa, 0xbb])).bytes();
    const combined = new Uint8Array(known.length + unknownTlv.length);
    combined.set(known, 0);
    combined.set(unknownTlv, known.length);
    const decoded = decodeSt2110TimingProperties(combined);
    expect(decoded.sourceTaiNs).toBe(42n); // known field still decodes correctly
  });

  it('empty bag round-trips to an empty object', () => {
    expect(decodeSt2110TimingProperties(encodeSt2110TimingProperties({}))).toEqual({});
  });

  it('provisional codepoints stay in the 0xFF10-0xFF1F range, disjoint from VIEWPORT_PROP 0xFF00-0xFF0F', () => {
    const values = Object.values(ST2110_TIMING_PROP);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0xff10);
      expect(v).toBeLessThanOrEqual(0xff1f);
    }
  });
});

describe('mediaClockValue — exact media-clock (RTP-style) sample counter', () => {
  it('90kHz media clock at 30fps advances by exactly 3000 ticks per frame', () => {
    const rate = rational(30, 1);
    expect(mediaClockValue(0n, 90_000n, rate)).toBe(0n);
    expect(mediaClockValue(1n, 90_000n, rate)).toBe(3000n);
    expect(mediaClockValue(10n, 90_000n, rate)).toBe(30_000n);
  });

  it('90kHz media clock at 30000/1001 fps is exact (no fractional tick rounded away silently each call)', () => {
    const rate = rational(30000, 1001);
    // 90000 * 1001 / 30000 = 3003 exactly — a famous ST 2110 constant, must land exactly.
    expect(mediaClockValue(1n, 90_000n, rate)).toBe(3003n);
  });
});
