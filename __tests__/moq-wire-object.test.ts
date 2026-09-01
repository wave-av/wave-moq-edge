import { describe, it, expect } from 'vitest';
import {
  Writer,
  MOQ_OBJECT_STATUS,
  SUBGROUP_ID_MODE,
  encodeObject,
  decodeObject,
  encodeSubgroupStream,
  decodeSubgroupStream,
  subgroupTypeByte,
  isSubgroupType,
  claimsSubgroupType,
  assertValidSubgroupTypeByte,
  assertValidDatagramTypeByte,
  DATAGRAM_FLAG,
  MoqProtocolViolationError,
} from '../src/moq-wire';

// Split from moq-wire.test.ts (#212 E2) alongside the moq-wire.ts → moq-wire-object.ts source split —
// this file covers the OBJECT_DATAGRAM + SUBGROUP_HEADER object data model (§11).

describe('object data model (§11)', () => {
  it('round-trips a normal object with payload', () => {
    const payload = new Uint8Array([10, 20, 30, 40]);
    const enc = encodeObject({ trackAlias: 1n, groupId: 5n, objectId: 12n, status: MOQ_OBJECT_STATUS.NORMAL, payload });
    const o = decodeObject(enc);
    expect(o.trackAlias).toBe(1n);
    expect(o.groupId).toBe(5n);
    expect(o.objectId).toBe(12n);
    expect(o.status).toBe(MOQ_OBJECT_STATUS.NORMAL);
    expect(Array.from(o.payload)).toEqual([10, 20, 30, 40]);
  });
  it('END_OF_GROUP carries no payload', () => {
    const enc = encodeObject({
      trackAlias: 1n,
      groupId: 5n,
      objectId: 99n,
      status: MOQ_OBJECT_STATUS.END_OF_GROUP,
      payload: new Uint8Array([1, 2, 3]), // should be dropped
    });
    const o = decodeObject(enc);
    expect(o.status).toBe(MOQ_OBJECT_STATUS.END_OF_GROUP);
    expect(o.payload.length).toBe(0);
  });
  it('preserves large 64-bit group/object IDs', () => {
    const big = (1n << 60n) + 123n;
    const enc = encodeObject({ trackAlias: 1n, groupId: big, objectId: big, status: 0, payload: new Uint8Array() });
    const o = decodeObject(enc);
    expect(o.groupId).toBe(big);
    expect(o.objectId).toBe(big);
  });
});

describe('SUBGROUP_HEADER multi-object stream (§subgroup-header)', () => {
  it('type-byte encodes flags; rejects reserved id-mode 3', () => {
    expect(subgroupTypeByte({ idMode: SUBGROUP_ID_MODE.ZERO, defaultPriority: false, endOfGroup: false, firstObject: false })).toBe(0x10);
    expect(subgroupTypeByte({ idMode: SUBGROUP_ID_MODE.EXPLICIT, defaultPriority: false, endOfGroup: false, firstObject: false })).toBe(0x14);
    expect(subgroupTypeByte({ idMode: SUBGROUP_ID_MODE.EXPLICIT, defaultPriority: true, endOfGroup: true, firstObject: true })).toBe(0x10 | 0x04 | 0x08 | 0x20 | 0x40);
    expect(() => subgroupTypeByte({ idMode: 3, defaultPriority: false, endOfGroup: false, firstObject: false })).toThrow();
    expect(isSubgroupType(0x14)).toBe(true);
    expect(isSubgroupType(0x16)).toBe(false); // id-mode 3 → invalid
    expect(isSubgroupType(0x00)).toBe(false); // bit 4 clear → not a subgroup
  });
  it('round-trips an explicit-subgroup-id stream with delta-coded object ids + priority', () => {
    const header = { trackAlias: 1n, groupId: 5n, subgroupId: 2n, idMode: SUBGROUP_ID_MODE.EXPLICIT, priority: 128, defaultPriority: false, endOfGroup: true, firstObject: true };
    const objects = [
      { objectId: 10n, status: MOQ_OBJECT_STATUS.NORMAL, payload: new Uint8Array([1, 2, 3]) },
      { objectId: 11n, status: MOQ_OBJECT_STATUS.NORMAL, payload: new Uint8Array([4, 5]) },
      { objectId: 12n, status: MOQ_OBJECT_STATUS.END_OF_GROUP, payload: new Uint8Array(0) },
    ];
    const dec = decodeSubgroupStream(encodeSubgroupStream(header, objects));
    expect(dec.header.trackAlias).toBe(1n);
    expect(dec.header.groupId).toBe(5n);
    expect(dec.header.subgroupId).toBe(2n);
    expect(dec.header.priority).toBe(128);
    expect(dec.header.endOfGroup).toBe(true);
    expect(dec.objects.map((o) => o.objectId)).toEqual([10n, 11n, 12n]);
    expect(Array.from(dec.objects[0].payload)).toEqual([1, 2, 3]);
    expect(dec.objects[2].status).toBe(MOQ_OBJECT_STATUS.END_OF_GROUP);
    expect(dec.objects[2].payload.length).toBe(0);
  });
  it('FIRST_OBJECT_ID mode derives subgroup id from the first object; default priority omits the field', () => {
    const header = { trackAlias: 1n, groupId: 0n, subgroupId: 0n, idMode: SUBGROUP_ID_MODE.FIRST_OBJECT_ID, priority: 0, defaultPriority: true, endOfGroup: false, firstObject: false };
    const objects = [{ objectId: 42n, status: MOQ_OBJECT_STATUS.NORMAL, payload: new Uint8Array([9]) }];
    const dec = decodeSubgroupStream(encodeSubgroupStream(header, objects));
    expect(dec.header.subgroupId).toBe(42n); // resolved from first object id
    expect(dec.header.defaultPriority).toBe(true);
    expect(dec.objects[0].objectId).toBe(42n);
  });
});

describe('#212 E2 — strict Type-Flags bitfields (draft-20 #1774)', () => {
  it('SUBGROUP_HEADER: a well-formed type byte round-trips through the strict assert', () => {
    const good = subgroupTypeByte({ idMode: SUBGROUP_ID_MODE.EXPLICIT, defaultPriority: false, endOfGroup: true, firstObject: false });
    expect(() => assertValidSubgroupTypeByte(good)).not.toThrow();
    expect(isSubgroupType(good)).toBe(true);
  });
  it('SUBGROUP_HEADER: a set-but-undefined bit (>= 128, needs a multi-byte varint) DECODES to a PROTOCOL_VIOLATION', () => {
    const undefinedBit = 0x10 | 0x80; // bit 4 set (claims subgroup) but bit 7 has no specified meaning
    expect(claimsSubgroupType(undefinedBit)).toBe(true); // still routed to the subgroup path, not silently reinterpreted
    expect(isSubgroupType(undefinedBit)).toBe(false);
    expect(() => assertValidSubgroupTypeByte(undefinedBit)).toThrow(MoqProtocolViolationError);
    const frame = new Writer().varint(undefinedBit).varint(1n).varint(0n).bytes();
    expect(() => decodeSubgroupStream(frame)).toThrow(MoqProtocolViolationError);
  });
  it('SUBGROUP_HEADER: SUBGROUP_ID_MODE 0b11 (reserved) is a PROTOCOL_VIOLATION, not a silent reject', () => {
    const reserved = 0x10 | 0x06; // bit4 set + idMode bits both set (0b11)
    expect(() => assertValidSubgroupTypeByte(reserved)).toThrow(MoqProtocolViolationError);
  });
  it('SUBGROUP_HEADER: bit 4 clear does NOT claim the subgroup type (so the relay can try OBJECT_DATAGRAM instead)', () => {
    expect(claimsSubgroupType(0x00)).toBe(false);
    expect(() => assertValidSubgroupTypeByte(0x00)).toThrow(MoqProtocolViolationError);
  });

  it('OBJECT_DATAGRAM: the type byte round-trips through encodeObject/decodeObject', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const enc = encodeObject({ trackAlias: 9n, groupId: 1n, objectId: 2n, status: MOQ_OBJECT_STATUS.NORMAL, payload });
    // Leading byte is the strict Type Flags byte — DEFAULT_PRIORITY set (no priority field on this
    // WS-binding path), PROPERTIES clear (no properties block on this object).
    expect(enc[0]).toBe(DATAGRAM_FLAG.DEFAULT_PRIORITY);
    const dec = decodeObject(enc);
    expect(dec.trackAlias).toBe(9n);
    expect(dec.groupId).toBe(1n);
    expect(dec.objectId).toBe(2n);
    expect(Array.from(dec.payload)).toEqual([1, 2, 3]);
  });
  it('OBJECT_DATAGRAM: the type byte reflects PROPERTIES when a trailing properties block is present', () => {
    const properties = new Uint8Array([7, 7]);
    const enc = encodeObject({ trackAlias: 1n, groupId: 0n, objectId: 0n, status: MOQ_OBJECT_STATUS.NORMAL, payload: new Uint8Array(), properties });
    expect(enc[0] & DATAGRAM_FLAG.PROPERTIES).toBe(DATAGRAM_FLAG.PROPERTIES);
    const dec = decodeObject(enc);
    expect(Array.from(dec.properties ?? [])).toEqual([7, 7]);
  });
  it('OBJECT_DATAGRAM: a set-but-undefined bit DECODES to a PROTOCOL_VIOLATION', () => {
    expect(() => assertValidDatagramTypeByte(0x40)).toThrow(MoqProtocolViolationError); // bit 6 undefined
    expect(() => assertValidDatagramTypeByte(0x80)).toThrow(MoqProtocolViolationError); // bit 7 undefined / >=128
    expect(() => assertValidDatagramTypeByte(0x10)).toThrow(MoqProtocolViolationError); // bit 4 reserved (subgroup space)
    const frame = new Writer().varint(0x40).varint(1n).varint(0n).varint(0n).varint(MOQ_OBJECT_STATUS.NORMAL).bytesLP(new Uint8Array()).bytes();
    expect(() => decodeObject(frame)).toThrow(MoqProtocolViolationError);
  });
  it('OBJECT_DATAGRAM: STATUS and END_OF_GROUP set together is a PROTOCOL_VIOLATION', () => {
    expect(() => assertValidDatagramTypeByte(DATAGRAM_FLAG.STATUS | DATAGRAM_FLAG.END_OF_GROUP)).toThrow(MoqProtocolViolationError);
  });
  it('a bit-4-set-but-malformed byte is a violation on BOTH read paths — never silently reinterpreted as a datagram', () => {
    const malformedSubgroup = 0x10 | 0x06; // claims subgroup (bit4), but idMode reserved
    expect(claimsSubgroupType(malformedSubgroup)).toBe(true);
    expect(() => assertValidSubgroupTypeByte(malformedSubgroup)).toThrow(MoqProtocolViolationError);
    // And it is ALSO rejected as a datagram (bit 4 is reserved-must-be-zero there), confirming the
    // two type spaces never silently overlap.
    expect(() => assertValidDatagramTypeByte(malformedSubgroup)).toThrow(MoqProtocolViolationError);
  });
});
