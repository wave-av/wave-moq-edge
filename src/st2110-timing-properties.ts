/**
 * ST 2110 Timing Object Properties — carries the originating professional-video timing on the SAME
 * MoQ object as the frame it describes, alongside `tai-group-mapping.ts`'s deterministic group id.
 *
 * WHY ON THE OBJECT, NOT A SIDECAR. Same reasoning as `viewport-properties.ts`: a sidecar timing
 * track has its own subscription and its own delivery timeout, so timing can arrive detached from
 * (or without) the frame it describes exactly when the network is worst. Riding the object means
 * the timing that justified this object's group id travels WITH it, by construction.
 *
 * WHY IT WORKS ON A RELAY. Same wire slot as viewport properties: `MoqObject.properties` /
 * `SubgroupObject` + PROPERTIES flag, an opaque length-prefixed extension-header bag the relay
 * forwards and caches verbatim without needing to understand it (draft-19 §2.5, quoted in
 * `viewport-properties.ts`). This module supplies the codec for the bag's CONTENTS; the relay never
 * parses it.
 *
 * CODEPOINTS ARE PROVISIONAL — same 0xFF.. private-use range as viewport properties, for the same
 * fail-open reason (a relay that predates this phase still forwards the video). MUST be replaced by
 * IANA-registered codepoints before any interop claim. See PIN-DECISION.md for the draft-19 pin.
 *
 * PURE module: bytes in / structs out. No I/O.
 */
// Explicit .ts extensions here (root tsconfig sets allowImportingTsExtensions, added by this phase)
// so this module resolves correctly BOTH under bundler resolution (vitest/wrangler, already worked
// extensionless) AND under raw `node --experimental-transform-types` (tools/tai-bench's CLI scripts,
// which import this module transitively and need real ESM specifier resolution — Node does not
// resolve extensionless relative specifiers, unlike a bundler).
import { Writer, Reader } from './moq-wire.ts';
import type { Rational } from './tai-group-mapping.ts';

/** Provisional ST 2110 timing Object Property codepoints (0xFF10–0xFF1F — disjoint from
 *  VIEWPORT_PROP's 0xFF00–0xFF0F so the two property bags can coexist on one object). */
export const ST2110_TIMING_PROP = {
  /** varint — the absolute source capture instant, TAI nanoseconds. The input to the group-id
   *  mapping; carried alongside the group id it produced so a receiver can verify the mapping
   *  independently rather than trusting the sender's arithmetic. */
  SOURCE_TAI_NS: 0xff10,
  /** varint — the ST 2110 / RTP media-clock sample value at this frame (NOT TAI; a modulo-2^32
   *  sample-domain counter per RFC 3550, carried as a full-width varint here since the object
   *  properties slot has no reason to truncate it). */
  MEDIA_CLOCK_VALUE: 0xff11,
  /** varint — exact frame rate numerator (frames per second numerator). Carried as a Rational pair
   *  (this + FRAME_RATE_DEN) specifically so non-integer rates (30000/1001) never round-trip
   *  through a lossy decimal. */
  FRAME_RATE_NUM: 0xff12,
  /** varint — exact frame rate denominator. See FRAME_RATE_NUM. */
  FRAME_RATE_DEN: 0xff13,
  /** 8 bytes — the SMPTE ST 2059-2 / PTP clock identity (EUI-64) of the source clock, carried
   *  verbatim so two objects can be checked for having shared (or diverged) their reference clock. */
  CLOCK_ID: 0xff14,
  /** varint — the PTP clock domain number (0-255 per IEEE 1588; ST 2059-2 profile default is 127). */
  CLOCK_DOMAIN: 0xff15,
} as const;

/** The decoded contents of an ST 2110 timing property block. Every field is optional on the wire
 *  (fail-open: an object may carry a partial bag, e.g. no clock identity yet). */
export interface St2110TimingMeta {
  sourceTaiNs?: bigint;
  mediaClockValue?: bigint;
  frameRate?: Rational;
  clockId?: Uint8Array; // exactly 8 bytes when present
  clockDomain?: number;
}

/**
 * Encode an ST 2110 timing property block: (Type varint, Length-prefixed Value) pairs in ascending
 * type order, matching `encodeViewportProperties`'s canonical-encoding convention so the two bags
 * concatenate deterministically when both are present on one object.
 *
 * NOTE: emitted WITHOUT its own outer length prefix, same convention as `viewport-properties.ts` —
 * the caller's `bytesLP` (via `MoqObject.properties`) or the subgroup properties block supplies that.
 */
export function encodeSt2110TimingProperties(m: St2110TimingMeta): Uint8Array {
  const w = new Writer();
  if (m.sourceTaiNs !== undefined) {
    w.varint(ST2110_TIMING_PROP.SOURCE_TAI_NS).bytesLP(new Writer().varint(m.sourceTaiNs).bytes());
  }
  if (m.mediaClockValue !== undefined) {
    w.varint(ST2110_TIMING_PROP.MEDIA_CLOCK_VALUE).bytesLP(new Writer().varint(m.mediaClockValue).bytes());
  }
  if (m.frameRate !== undefined) {
    w.varint(ST2110_TIMING_PROP.FRAME_RATE_NUM).bytesLP(new Writer().varint(m.frameRate.numerator).bytes());
    w.varint(ST2110_TIMING_PROP.FRAME_RATE_DEN).bytesLP(new Writer().varint(m.frameRate.denominator).bytes());
  }
  if (m.clockId !== undefined) {
    if (m.clockId.length !== 8) throw new RangeError(`clockId must be exactly 8 bytes, got ${m.clockId.length}`);
    w.varint(ST2110_TIMING_PROP.CLOCK_ID).bytesLP(m.clockId);
  }
  if (m.clockDomain !== undefined) {
    w.varint(ST2110_TIMING_PROP.CLOCK_DOMAIN).bytesLP(new Writer().varint(m.clockDomain).bytes());
  }
  return w.bytes();
}

/**
 * Decode an ST 2110 timing property block. Unknown property types are SKIPPED, never fatal — same
 * fail-open contract as `decodeViewportProperties` (a relay/decoder that predates a future property
 * must not choke on it).
 */
export function decodeSt2110TimingProperties(bytes: Uint8Array): St2110TimingMeta {
  const r = new Reader(bytes);
  const out: St2110TimingMeta = {};
  let frameRateNum: bigint | undefined;
  let frameRateDen: bigint | undefined;
  while (r.remaining > 0) {
    const type = r.varintNum();
    const value = r.bytesLP();
    switch (type) {
      case ST2110_TIMING_PROP.SOURCE_TAI_NS:
        out.sourceTaiNs = new Reader(value).varint();
        break;
      case ST2110_TIMING_PROP.MEDIA_CLOCK_VALUE:
        out.mediaClockValue = new Reader(value).varint();
        break;
      case ST2110_TIMING_PROP.FRAME_RATE_NUM:
        frameRateNum = new Reader(value).varint();
        break;
      case ST2110_TIMING_PROP.FRAME_RATE_DEN:
        frameRateDen = new Reader(value).varint();
        break;
      case ST2110_TIMING_PROP.CLOCK_ID:
        if (value.length !== 8) throw new RangeError(`CLOCK_ID property must be exactly 8 bytes, got ${value.length}`);
        out.clockId = value;
        break;
      case ST2110_TIMING_PROP.CLOCK_DOMAIN:
        out.clockDomain = new Reader(value).varintNum();
        break;
      default:
        break; // unknown property — skipped, not fatal
    }
  }
  if (frameRateNum !== undefined && frameRateDen !== undefined) {
    out.frameRate = { numerator: frameRateNum, denominator: frameRateDen };
  }
  return out;
}
