import { describe, it, expect } from 'vitest';
import {
  Writer,
  frameControl,
  parseControl,
  MOQ_MSG,
  encodeRequestUpdate,
  decodeRequestUpdate,
  REQUEST_UPDATE_PARAM,
  MoqProtocolViolationError,
} from '../src/moq-wire';

// New test file (not added to __tests__/moq-wire.test.ts, already flagged over the repo's file-size
// advisory) — #212 E6, draft-20 §message-request-update.

describe('REQUEST_UPDATE (draft-20 §message-request-update, 0x2) — #212 E6', () => {
  it('has type 0x2 and round-trips the Request ID with no parameters', () => {
    expect(MOQ_MSG.REQUEST_UPDATE).toBe(0x2);
    const enc = encodeRequestUpdate({ requestId: 7n });
    expect(parseControl(enc).type).toBe(MOQ_MSG.REQUEST_UPDATE);
    expect(decodeRequestUpdate(parseControl(enc).payload)).toEqual({ requestId: 7n });
  });

  it('round-trips FORWARD (0x10, §forward-parameter) — uint8, 0 or 1', () => {
    expect(decodeRequestUpdate(parseControl(encodeRequestUpdate({ requestId: 1n, forward: 0 })).payload)).toEqual({ requestId: 1n, forward: 0 });
    expect(decodeRequestUpdate(parseControl(encodeRequestUpdate({ requestId: 1n, forward: 1 })).payload)).toEqual({ requestId: 1n, forward: 1 });
  });

  it('round-trips LOCATION_FILTER (0x21, §location-filter) — shared LocationFilter type/codec with SUBSCRIBE/FETCH', () => {
    const enc = encodeRequestUpdate({ requestId: 3n, locationFilter: { startGroup: 10n, startObject: 0n, endGroupDelta: 2n } });
    expect(decodeRequestUpdate(parseControl(enc).payload)).toEqual({
      requestId: 3n,
      locationFilter: { startGroup: 10n, startObject: 0n, endGroupDelta: 2n },
    });
  });

  it('a zero-length LOCATION_FILTER ({}) round-trips distinctly from an OMITTED one (§location-filters: "Length 0 ... remove the filter")', () => {
    const withEmptyFilter = decodeRequestUpdate(parseControl(encodeRequestUpdate({ requestId: 5n, locationFilter: {} })).payload);
    const withOmittedFilter = decodeRequestUpdate(parseControl(encodeRequestUpdate({ requestId: 5n })).payload);
    expect(withEmptyFilter).toEqual({ requestId: 5n, locationFilter: {} });
    expect(withOmittedFilter).toEqual({ requestId: 5n });
    expect(withEmptyFilter).not.toEqual(withOmittedFilter);
  });

  it('round-trips both parameters together, serialized in ascending Type order (FORWARD 0x10 before LOCATION_FILTER 0x21) regardless of field order', () => {
    const enc = encodeRequestUpdate({ requestId: 9n, locationFilter: { startGroup: 4n }, forward: 1 });
    expect(decodeRequestUpdate(parseControl(enc).payload)).toEqual({
      requestId: 9n,
      forward: 1,
      locationFilter: { startGroup: 4n },
    });
  });

  it('rejects an out-of-range FORWARD value as a PROTOCOL_VIOLATION (§forward-parameter)', () => {
    // RequestId=1, NumParams=1, TypeDelta=FORWARD(0x10), Value=2 (only 0/1 are legal).
    const body = new Writer().varint(1n).varint(1n).varint(REQUEST_UPDATE_PARAM.FORWARD).u8(2).bytes();
    const enc = frameControl(MOQ_MSG.REQUEST_UPDATE, body);
    expect(() => decodeRequestUpdate(parseControl(enc).payload)).toThrow(MoqProtocolViolationError);
  });

  it('rejects an unknown Message Parameter as a PROTOCOL_VIOLATION (§message-params — e.g. LARGEST_OBJECT (0x9) is not modeled here)', () => {
    // RequestId=1, NumParams=1, TypeDelta=0x9 (LARGEST_OBJECT), Value=two varints (Location).
    const body = new Writer().varint(1n).varint(1n).varint(0x9n).varint(1n).varint(1n).bytes();
    const enc = frameControl(MOQ_MSG.REQUEST_UPDATE, body);
    expect(() => decodeRequestUpdate(parseControl(enc).payload)).toThrow(MoqProtocolViolationError);
  });

  it('rejects a repeated Message Parameter type as a PROTOCOL_VIOLATION (§message-params: "MUST NOT repeat")', () => {
    // RequestId=1, NumParams=2, both FORWARD (0x10): TypeDelta=0x10,Value=1 then TypeDelta=0(repeat),Value=1.
    const body = new Writer().varint(1n).varint(2n).varint(0x10n).u8(1).varint(0n).u8(1).bytes();
    const enc = frameControl(MOQ_MSG.REQUEST_UPDATE, body);
    expect(() => decodeRequestUpdate(parseControl(enc).payload)).toThrow(MoqProtocolViolationError);
  });
});
