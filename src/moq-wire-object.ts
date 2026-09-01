/**
 * MoQ Transport object data model — OBJECT_DATAGRAM + SUBGROUP_HEADER (draft-20 §object-datagram-format
 * / §subgroup-header). Split out of `moq-wire.ts` (#212 E2) once the wire-codec module crossed the
 * repo's file-size gate; re-exported from `moq-wire.ts` (`export * from './moq-wire-object'`) so every
 * existing `from './moq-wire'` import keeps working unchanged — this file is additive plumbing, not a
 * behavior change on its own (the E2 behavior change is documented in the diff, see below).
 *
 * #212 E2 (#1774, "Describe OBJECT_DATAGRAM and SUBGROUP_HEADER types as Type Flags bitfields; a set
 * bit with no specified meaning is a PROTOCOL_VIOLATION"):
 *   - SUBGROUP_HEADER: `isSubgroupType`/`assertValidSubgroupTypeByte` now strictly validate the Type
 *     Flags byte — bit 4 must be set, SUBGROUP_ID_MODE 0b11 is reserved, and any value >= 128 (i.e.
 *     anything needing more than the single-byte varint form the draft defines) is a PROTOCOL_VIOLATION.
 *     `claimsSubgroupType` (bit 4 alone) is exported so the relay's dispatcher can route a MALFORMED
 *     bit-4-set byte to the violation path instead of silently re-interpreting it as an OBJECT_DATAGRAM
 *     — the two type spaces are disjoint on bit 4 (SUBGROUP_HEADER requires it set, OBJECT_DATAGRAM
 *     requires it clear), so a set-but-malformed bit 4 is NEVER a valid datagram either.
 *   - OBJECT_DATAGRAM gains a leading Type Flags byte (`encodeObject`/`decodeObject`) per draft-20
 *     §object-datagram-format. The repo's documented WS-binding deviation is preserved UNCHANGED: an
 *     explicit Object Status + length-prefixed Payload + trailing Properties block, regardless of what
 *     the Type Flags byte's PROPERTIES/STATUS/etc. bits would otherwise imply about field presence —
 *     this module only makes the LEADING byte itself a strict, spec-shaped bitfield; the WS layout that
 *     follows is unchanged. This is a WIRE-COMPAT BREAK on the datagram path (see moq-wire.ts header).
 */

import { Reader, Writer, MoqProtocolViolationError } from './moq-wire';
import { MOQ_STREAM, SUBGROUP_FLAG, SUBGROUP_ID_MODE, MOQ_OBJECT_STATUS } from './moq-wire';

// ── OBJECT_DATAGRAM Type Flags (draft-20 §object-datagram-format) ──────────────────────────────────

/**
 * OBJECT_DATAGRAM Type Flags bits. Bit 4 (0x10) is RESERVED and MUST be zero (it is the bit
 * SUBGROUP_HEADER uses to mean the opposite — "this IS a subgroup type" — so the two type spaces
 * never collide). Bits 6-7 (0x40, 0x80) have no meaning in this draft; a value >= 128 also requires
 * a multi-byte varint, which the spec explicitly disallows for this field.
 */
export const DATAGRAM_FLAG = {
  PROPERTIES: 0x01,
  END_OF_GROUP: 0x02,
  ZERO_OBJECT_ID: 0x04,
  DEFAULT_PRIORITY: 0x08,
  STATUS: 0x20,
} as const;

/** The set of bits this draft defines for OBJECT_DATAGRAM (bit 4 excluded — reserved, must be 0). */
const DATAGRAM_FLAG_MASK = DATAGRAM_FLAG.PROPERTIES | DATAGRAM_FLAG.END_OF_GROUP | DATAGRAM_FLAG.ZERO_OBJECT_ID | DATAGRAM_FLAG.DEFAULT_PRIORITY | DATAGRAM_FLAG.STATUS; // 0x2f

/**
 * Strictly validate an OBJECT_DATAGRAM Type Flags byte (draft-20 §object-datagram-format, #1774).
 * Throws `MoqProtocolViolationError` — never silently accepts — for: a value requiring more than one
 * byte (>= 128), bit 4 set (reserved), any bit outside the five defined flags, or STATUS+END_OF_GROUP
 * both set (mutually exclusive per the spec's own invalid-values list).
 */
export function assertValidDatagramTypeByte(typeByte: number): void {
  if (typeByte < 0 || typeByte >= 128) {
    throw new MoqProtocolViolationError(`OBJECT_DATAGRAM Type Flags requires a single-byte value (0-127): 0x${typeByte.toString(16)}`);
  }
  if (typeByte & 0x10) {
    throw new MoqProtocolViolationError('OBJECT_DATAGRAM Type Flags bit 4 (0x10) is reserved and MUST be zero');
  }
  if (typeByte & ~DATAGRAM_FLAG_MASK) {
    throw new MoqProtocolViolationError(`OBJECT_DATAGRAM Type Flags has a set bit with no specified meaning: 0x${typeByte.toString(16)}`);
  }
  if ((typeByte & DATAGRAM_FLAG.STATUS) !== 0 && (typeByte & DATAGRAM_FLAG.END_OF_GROUP) !== 0) {
    throw new MoqProtocolViolationError('OBJECT_DATAGRAM Type Flags cannot set both STATUS (0x20) and END_OF_GROUP (0x02)');
  }
}

/**
 * Compose the OBJECT_DATAGRAM Type Flags byte for this repo's WS-binding layout. The layout always
 * carries an explicit Object ID (ZERO_OBJECT_ID stays 0) and never carries a Priority field on the
 * datagram path (DEFAULT_PRIORITY is always set — see `MoqObject.priority`'s doc: it is a non-wire
 * scheduling hint, never serialized here). PROPERTIES reflects whether the trailing properties block
 * is present, matching `encodeObject`'s existing conditional `bytesLP(o.properties)`.
 */
function datagramTypeByte(o: Pick<MoqObject, 'properties'>): number {
  let t = DATAGRAM_FLAG.DEFAULT_PRIORITY;
  if (o.properties !== undefined && o.properties.length > 0) t |= DATAGRAM_FLAG.PROPERTIES;
  return t;
}

// ── object data model (§11) — OBJECT_DATAGRAM form (one object per frame, ideal for a WS binding) ──

export interface MoqObject {
  trackAlias: bigint;
  groupId: bigint;
  objectId: bigint;
  status: number; // MOQ_OBJECT_STATUS.*
  payload: Uint8Array; // empty when status != NORMAL
  /**
   * Opaque Object Properties block (the §2.5 extension-header bag), carried VERBATIM. The relay MUST
   * NOT modify it, MUST forward it and MUST cache it with the object — draft-19 §2.5 states this
   * explicitly and draft-18's SUBGROUP_HEADER already reserves the PROPERTIES flag (0x01) plus the
   * length-prefixed block that `skipObjectProperties` walks. This field is the datagram-form
   * equivalent; `viewport-properties.ts` owns the codec for the block's contents.
   *
   * WIRE NOTE — the block is appended AFTER the payload, not before it. In native draft-18/-19 the
   * extension headers precede the payload and are signalled by the datagram type byte. On the WS
   * envelope (already a documented deviation: explicit Object Status + length-prefixed payload) a
   * TRAILING optional block is what makes the change strictly additive: a frame with no properties is
   * byte-identical to the pre-existing encoding, and an older decoder simply stops reading. When the
   * WebTransport binding lands the block moves ahead of the payload with no change to its contents.
   *
   * OBJECT_DELIVERY_TIMEOUT (draft-20 #1844): the timeout window now starts at the LAST HEADER BYTE
   * (i.e. the end of this trailing Properties block when present, or the end of the Payload-length
   * prefix's payload when absent) rather than the first payload byte. This module does not compute
   * or enforce delivery timeouts — `viewport-properties.ts`'s `ViewportObjectMeta` is the place that
   * interprets Properties-block contents and is where the -20 boundary shift is documented/applied.
   */
  properties?: Uint8Array;
  /**
   * Non-wire scheduling hint (E1 deadline scheduler) — NOT serialized by encodeObject and NOT
   * populated by decodeObject. The OBJECT_DATAGRAM wire form carries no priority field: priority
   * lives only on the SUBGROUP_HEADER stream form (`SubgroupHeader.priority`, 0-255 where LOWER =
   * HIGHER priority per draft-18 §subgroup-header), which the relay's forward path never decodes.
   * Populated only by a future subgroup-decode path or by tests. Absent → the scheduler falls back
   * to arrival order (fail-open, never drops a group).
   */
  priority?: number;
  /**
   * Non-wire scheduling hint (E1 deadline scheduler): the playout deadline (epoch ms) by which the
   * object must reach the player's jitter buffer. NOT serialized / decoded — same provenance as
   * `priority`. Absent → the scheduler falls back to arrival order (fail-open).
   */
  deadlineMs?: number;
}

/**
 * Encode one object as an OBJECT_DATAGRAM (§11.3.1). Prefixes a strict Type Flags byte (#212 E2,
 * #1774) ahead of the repo's existing WS-binding layout, which is UNCHANGED: an explicit Object
 * Status and a length-prefixed payload so the framing is self-describing on a message-oriented
 * transport (WS). Layout: TypeFlags(i) TrackAlias(i) GroupId(i) ObjectId(i) Status(i) PayloadLen(i)
 * Payload [PropsLen(i) Props]. WIRE-COMPAT BREAK: a pre-E2 decoder reading this frame will
 * mis-parse the leading Type Flags byte as the start of TrackAlias.
 */
export function encodeObject(o: MoqObject): Uint8Array {
  const w = new Writer()
    .varint(datagramTypeByte(o))
    .varint(o.trackAlias)
    .varint(o.groupId)
    .varint(o.objectId)
    .varint(o.status)
    .bytesLP(o.status === MOQ_OBJECT_STATUS.NORMAL ? o.payload : new Uint8Array(0));
  if (o.properties !== undefined && o.properties.length > 0) w.bytesLP(o.properties);
  return w.bytes();
}
export function decodeObject(bytes: Uint8Array): MoqObject {
  const r = new Reader(bytes);
  const typeByte = r.varintNum();
  assertValidDatagramTypeByte(typeByte); // throws MoqProtocolViolationError on a set-but-undefined bit
  const trackAlias = r.varint();
  const groupId = r.varint();
  const objectId = r.varint();
  const status = r.varintNum();
  const payload = r.bytesLP();
  const properties = r.remaining > 0 ? r.bytesLP() : undefined;
  return { trackAlias, groupId, objectId, status, payload, ...(properties ? { properties } : {}) };
}

// ── SUBGROUP_HEADER multi-object stream (§subgroup-header) ──────────────────────────────────────────
//
// A subgroup carries MANY objects of one group on a single QUIC unidirectional stream (vs one object
// per OBJECT_DATAGRAM). On the WS binding we carry the whole subgroup as one tagged frame. The stream
// TYPE BYTE is a bitfield (SUBGROUP_BASE | flags); the header fields and per-object layout depend on
// those flags. Object IDs are DELTA-coded (first absolute, rest are deltas) per §subgroup-header.

export interface SubgroupObject {
  objectId: bigint;
  status: number; // MOQ_OBJECT_STATUS.* (only serialized when payload is empty)
  payload: Uint8Array;
  /**
   * Priority stamped from the enclosing SubgroupHeader — 0-255 where LOWER = HIGHER priority
   * per draft-18 §subgroup-header. Undefined when `defaultPriority` is set on the header (the
   * wire form omits the field and the scheduler falls back to arrival order).
   */
  priority?: number;
}
export interface SubgroupHeader {
  trackAlias: bigint;
  groupId: bigint;
  subgroupId: bigint; // resolved value (see idMode for how it was encoded)
  idMode: number; // SUBGROUP_ID_MODE.* — how subgroupId is carried on the wire
  priority: number; // 0-255; ignored when defaultPriority is set
  defaultPriority: boolean; // omit the Priority field, inherit subscription priority
  endOfGroup: boolean;
  firstObject: boolean;
}

/** Compose the SUBGROUP_HEADER type byte from header flags. */
export function subgroupTypeByte(h: Pick<SubgroupHeader, 'idMode' | 'defaultPriority' | 'endOfGroup' | 'firstObject'>): number {
  if (h.idMode === 3) throw new RangeError('subgroup id mode 3 is reserved/invalid');
  let t = MOQ_STREAM.SUBGROUP_BASE;
  t |= (h.idMode & 0x3) << SUBGROUP_FLAG.SUBGROUP_ID_SHIFT;
  if (h.endOfGroup) t |= SUBGROUP_FLAG.END_OF_GROUP;
  if (h.defaultPriority) t |= SUBGROUP_FLAG.DEFAULT_PRIORITY;
  if (h.firstObject) t |= SUBGROUP_FLAG.FIRST_OBJECT;
  // NOTE: PROPERTIES (0x01) is not emitted — we never attach per-object extension headers.
  return t;
}

/**
 * True when `typeByte`'s bit 4 (0x10) is set — i.e. the byte CLAIMS to be a SUBGROUP_HEADER type,
 * whether or not the rest of its bits are well-formed. #212 E2: the relay's frame-type dispatcher
 * uses this (not `isSubgroupType`) to decide whether to route a frame to the subgroup decode path —
 * a bit-4-set-but-malformed byte must land on `decodeSubgroupStream`'s PROTOCOL_VIOLATION, never
 * silently fall through to `decodeObject` (bit 4 is reserved-must-be-zero for OBJECT_DATAGRAM, so a
 * bit-4-set byte is NEVER a valid datagram either).
 */
export function claimsSubgroupType(typeByte: number): boolean {
  return (typeByte & 0x10) !== 0;
}

/**
 * Is `typeByte` a fully well-formed SUBGROUP_HEADER stream type (bit 4 set, no undefined bit set,
 * id-mode != 3, and representable in the draft's mandated single-byte form)? Every bit in the
 * defined 0-6 range already has a specified meaning in this codec (PROPERTIES, the 2-bit ID mode,
 * END_OF_GROUP, the base bit, DEFAULT_PRIORITY, FIRST_OBJECT) — draft-20's "set bit with no
 * specified meaning" case for this header therefore reduces to: id-mode 0b11 (explicitly reserved)
 * or a value >= 128 (any bit 7+ set, which also needs a multi-byte varint the spec disallows here).
 */
export function isSubgroupType(typeByte: number): boolean {
  if (!claimsSubgroupType(typeByte)) return false; // bit 4 must be set
  if (typeByte < 0 || typeByte >= 128) return false; // single-byte form only; also catches undefined bits 7+
  const idMode = (typeByte >> SUBGROUP_FLAG.SUBGROUP_ID_SHIFT) & 0x3;
  return idMode !== 3; // mode 3 is a PROTOCOL_VIOLATION
}

/**
 * Strict assert form of `isSubgroupType` — throws `MoqProtocolViolationError` (not a plain
 * `RangeError`) describing exactly which draft-20 invalid-value rule was hit (#212 E2, #1774).
 */
export function assertValidSubgroupTypeByte(typeByte: number): void {
  if (!claimsSubgroupType(typeByte)) {
    throw new MoqProtocolViolationError(`SUBGROUP_HEADER Type Flags bit 4 (0x10) must be set: 0x${typeByte.toString(16)}`);
  }
  if (typeByte < 0 || typeByte >= 128) {
    throw new MoqProtocolViolationError(`SUBGROUP_HEADER Type Flags requires a single-byte value (0-127): 0x${typeByte.toString(16)}`);
  }
  const idMode = (typeByte >> SUBGROUP_FLAG.SUBGROUP_ID_SHIFT) & 0x3;
  if (idMode === 3) {
    throw new MoqProtocolViolationError('SUBGROUP_HEADER Type Flags SUBGROUP_ID_MODE 0b11 is reserved for future use');
  }
}

/** Encode a full subgroup (header + objects) as one frame. Object IDs are delta-coded from the first. */
export function encodeSubgroupStream(h: SubgroupHeader, objects: SubgroupObject[]): Uint8Array {
  const w = new Writer().varint(subgroupTypeByte(h)).varint(h.trackAlias).varint(h.groupId);
  if (h.idMode === SUBGROUP_ID_MODE.EXPLICIT) w.varint(h.subgroupId);
  if (!h.defaultPriority) w.u8(h.priority & 0xff);
  let prev: bigint | null = null;
  for (const o of objects) {
    const delta = prev === null ? o.objectId : o.objectId - prev;
    if (delta < 0n) throw new RangeError('subgroup object ids must be non-decreasing');
    prev = o.objectId;
    w.varint(delta);
    const isNormal = o.status === MOQ_OBJECT_STATUS.NORMAL && o.payload.length > 0;
    if (isNormal) {
      w.varint(o.payload.length).raw(o.payload);
    } else {
      w.varint(0).varint(o.status); // Object Status carried only when payload length is 0
    }
  }
  return w.bytes();
}

/**
 * Decode a subgroup frame → header + objects. Resolves delta-coded object IDs to absolute. Throws
 * `MoqProtocolViolationError` (#212 E2) for a Type Flags byte with a set-but-undefined bit — never
 * silently accepts one.
 */
export function decodeSubgroupStream(bytes: Uint8Array): { header: SubgroupHeader; objects: SubgroupObject[] } {
  const r = new Reader(bytes);
  const typeByte = r.varintNum();
  assertValidSubgroupTypeByte(typeByte);
  const properties = (typeByte & SUBGROUP_FLAG.PROPERTIES) !== 0;
  const idMode = (typeByte >> SUBGROUP_FLAG.SUBGROUP_ID_SHIFT) & 0x3;
  const endOfGroup = (typeByte & SUBGROUP_FLAG.END_OF_GROUP) !== 0;
  const defaultPriority = (typeByte & SUBGROUP_FLAG.DEFAULT_PRIORITY) !== 0;
  const firstObject = (typeByte & SUBGROUP_FLAG.FIRST_OBJECT) !== 0;

  const trackAlias = r.varint();
  const groupId = r.varint();
  let subgroupId = 0n;
  if (idMode === SUBGROUP_ID_MODE.EXPLICIT) subgroupId = r.varint();
  const priority = defaultPriority ? 0 : r.u8();

  const objects: SubgroupObject[] = [];
  let cur: bigint | null = null;
  while (r.remaining > 0) {
    const delta = r.varint();
    cur = cur === null ? delta : cur + delta;
    if (idMode === SUBGROUP_ID_MODE.FIRST_OBJECT_ID && objects.length === 0) subgroupId = cur;
    if (properties) skipObjectProperties(r); // we don't model extension headers; skip them faithfully
    const len = r.varintNum();
    const objPriority = defaultPriority ? undefined : priority;
    if (len > 0) {
      objects.push({ objectId: cur, status: MOQ_OBJECT_STATUS.NORMAL, payload: r.raw(len), ...(objPriority !== undefined ? { priority: objPriority } : {}) });
    } else {
      const status = r.varintNum();
      objects.push({ objectId: cur, status, payload: new Uint8Array(0), ...(objPriority !== undefined ? { priority: objPriority } : {}) });
    }
  }
  return { header: { trackAlias, groupId, subgroupId, idMode, priority, defaultPriority, endOfGroup, firstObject }, objects };
}

/** Skip a per-object Object Properties block (a length-prefixed extension-header bag). */
function skipObjectProperties(r: Reader): void {
  const len = r.varintNum();
  r.raw(len);
}
