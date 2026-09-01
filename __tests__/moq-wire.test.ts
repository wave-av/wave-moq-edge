import { describe, it, expect } from 'vitest';
import {
  Writer,
  Reader,
  frameControl,
  parseControl,
  MOQ_MSG,
  MOQ_ROLE,
  MOQ_DRAFT_VERSION,
  MOQ_ALPN,
  MOQ_SESSION_ERROR,
  encodeSetup,
  decodeSetup,
  encodeSubscribe,
  decodeSubscribe,
  encodeSubscribeOk,
  decodeSubscribeOk,
  encodePublishNamespace,
  decodePublishNamespace,
  encodeRequestOk,
  decodeRequestOk,
  encodeRequestError,
  decodeRequestError,
  encodeSubscribeNamespace,
  decodeSubscribeNamespace,
  encodePublish,
  decodePublish,
  encodeTrackStatus,
  decodeTrackStatus,
  encodeFetch,
  decodeFetch,
  encodeFetchOk,
  decodeFetchOk,
  encodeGoaway,
  decodeGoaway,
  MOQ_PARAM,
  encodeLocationFilter,
  decodeLocationFilter,
  encodeFillParameters,
  decodeFillParameters,
  MoqProtocolViolationError,
  encodePublishStateNotify,
  decodePublishStateNotify,
  PUBLISH_STATE_NOTIFY_PARAM,
} from '../src/moq-wire';

describe('draft-20 constants (#212 E0/E1 uplevel from draft-18)', () => {
  it('pins draft 20 + ALPN + the relay control codes', () => {
    expect(MOQ_DRAFT_VERSION).toBe(20);
    expect(MOQ_ALPN).toBe('moqt-20');
    expect(MOQ_MSG.SETUP).toBe(0x2f00);
    expect(MOQ_MSG.SUBSCRIBE).toBe(0x3);
    expect(MOQ_MSG.SUBSCRIBE_OK).toBe(0x4);
    expect(MOQ_MSG.REQUEST_ERROR).toBe(0x5);
    expect(MOQ_MSG.PUBLISH_NAMESPACE).toBe(0x6);
    expect(MOQ_MSG.REQUEST_OK).toBe(0x7);
    expect(MOQ_MSG.GOAWAY).toBe(0x10);
  });
  it('pins the full draft-18-base message set codes (verified against the tagged source)', () => {
    expect(MOQ_MSG.PUBLISH).toBe(0x1d);
    expect(MOQ_MSG.FETCH).toBe(0x16);
    expect(MOQ_MSG.FETCH_OK).toBe(0x18);
    expect(MOQ_MSG.TRACK_STATUS).toBe(0xd);
    expect(MOQ_MSG.SUBSCRIBE_NAMESPACE).toBe(0x50);
  });
  it('PUBLISH_SKIPPED resolves (draft-19 #1779 rename of PUBLISH_BLOCKED)', () => {
    expect(MOQ_MSG.PUBLISH_SKIPPED).toBe(0xf);
  });
  it('TOO_MANY_REQUEST_UPDATES resolves in the Session Termination table (draft-19 #1613)', () => {
    expect(MOQ_SESSION_ERROR.TOO_MANY_REQUEST_UPDATES).toBe(0x1b);
  });
});

describe('varint (draft-18 §1.4.1 leading-1-bits)', () => {
  // value → expected smallest byte length (capacity 7N bits for N≤8, 64 for N=9).
  const cases: Array<[bigint, number]> = [
    [0n, 1],
    [1n, 1],
    [127n, 1], // 2^7-1
    [128n, 2],
    [16383n, 2], // 2^14-1
    [16384n, 3],
    [2097151n, 3], // 2^21-1
    [2097152n, 4],
    [268435455n, 4], // 2^28-1
    [268435456n, 5],
    [(1n << 35n) - 1n, 5],
    [1n << 35n, 6],
    [(1n << 42n) - 1n, 6],
    [1n << 42n, 7],
    [(1n << 49n) - 1n, 7],
    [1n << 49n, 8],
    [(1n << 56n) - 1n, 8],
    [1n << 56n, 9],
    [(1n << 62n) - 1n, 9],
    [BigInt(Number.MAX_SAFE_INTEGER), 8], // 2^53-1 → 53 bits → 8-byte form (cap 56)
    [(1n << 64n) - 1n, 9], // max
  ];

  it.each(cases)('round-trips %s in %d byte(s)', (v, len) => {
    const enc = new Writer().varint(v).bytes();
    expect(enc.length).toBe(len);
    const dec = new Reader(enc).varint();
    expect(dec).toBe(v);
  });

  it('rejects negative + over-max', () => {
    expect(() => new Writer().varint(-1)).toThrow();
    expect(() => new Writer().varint(1n << 64n)).toThrow();
  });

  it('reads consecutive varints from one buffer', () => {
    const enc = new Writer().varint(5n).varint(300n).varint(1n << 40n).bytes();
    const r = new Reader(enc);
    expect(r.varint()).toBe(5n);
    expect(r.varint()).toBe(300n);
    expect(r.varint()).toBe(1n << 40n);
    expect(r.remaining).toBe(0);
  });
});

describe('length-prefixed bytes / strings / namespace tuple', () => {
  it('round-trips a UTF-8 string', () => {
    const enc = new Writer().strLP('wave/cam-1 🎥').bytes();
    expect(new Reader(enc).strLP()).toBe('wave/cam-1 🎥');
  });
  it('round-trips a namespace tuple (§1.4.2)', () => {
    const ns = ['wave', 'studio', 'cam-1'];
    const enc = new Writer().tuple(ns).bytes();
    expect(new Reader(enc).tuple()).toEqual(ns);
  });
  it('round-trips an empty tuple', () => {
    const enc = new Writer().tuple([]).bytes();
    expect(new Reader(enc).tuple()).toEqual([]);
  });
});

describe('control framing (§10): Type(i) + Length(16) + Payload', () => {
  it('round-trips type + payload', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const framed = frameControl(MOQ_MSG.SUBSCRIBE, payload);
    const out = parseControl(framed);
    expect(out.type).toBe(MOQ_MSG.SUBSCRIBE);
    expect(Array.from(out.payload)).toEqual([1, 2, 3, 4, 5]);
  });
  it('rejects an over-long payload (>16-bit)', () => {
    expect(() => frameControl(MOQ_MSG.SUBSCRIBE, new Uint8Array(0x10000))).toThrow();
  });
});

describe('control messages round-trip', () => {
  it('SETUP with + without PATH', () => {
    for (const path of [undefined, '/relay/edge']) {
      const enc = encodeSetup({ role: MOQ_ROLE.PUBSUB, maxSubscriptions: 1000n, path });
      const { type, payload } = parseControl(enc);
      expect(type).toBe(MOQ_MSG.SETUP);
      const m = decodeSetup(payload);
      expect(m.role).toBe(MOQ_ROLE.PUBSUB);
      expect(m.maxSubscriptions).toBe(1000n);
      expect(m.path).toBe(path);
      expect(m.maxRequestUpdates).toBeUndefined();
    }
  });
  it('SETUP with MAX_REQUEST_UPDATES (option 0x08, draft-19 #1613)', () => {
    const enc = encodeSetup({ role: MOQ_ROLE.SUBSCRIBER, maxSubscriptions: 10n, maxRequestUpdates: 4n });
    const m = decodeSetup(parseControl(enc).payload);
    expect(m.maxRequestUpdates).toBe(4n);
    expect(m.path).toBeUndefined();
  });
  it('SETUP with PATH and MAX_REQUEST_UPDATES together', () => {
    const enc = encodeSetup({ role: MOQ_ROLE.PUBLISHER, maxSubscriptions: 0n, path: '/edge', maxRequestUpdates: 0n });
    const m = decodeSetup(parseControl(enc).payload);
    expect(m.path).toBe('/edge');
    expect(m.maxRequestUpdates).toBe(0n);
  });
  it('SUBSCRIBE', () => {
    const enc = encodeSubscribe({ requestId: 42n, trackNamespace: ['wave', 'cam-1'], trackName: 'video' });
    const m = decodeSubscribe(parseControl(enc).payload);
    expect(m.requestId).toBe(42n);
    expect(m.trackNamespace).toEqual(['wave', 'cam-1']);
    expect(m.trackName).toBe('video');
  });
  it('SUBSCRIBE_OK', () => {
    const enc = encodeSubscribeOk({ requestId: 42n, expires: 5000n });
    const m = decodeSubscribeOk(parseControl(enc).payload);
    expect(m).toEqual({ requestId: 42n, expires: 5000n });
  });
  it('PUBLISH_NAMESPACE', () => {
    const enc = encodePublishNamespace({ requestId: 7n, trackNamespace: ['wave', 'studio'] });
    const m = decodePublishNamespace(parseControl(enc).payload);
    expect(m.requestId).toBe(7n);
    expect(m.trackNamespace).toEqual(['wave', 'studio']);
  });
  it('REQUEST_OK + REQUEST_ERROR', () => {
    expect(decodeRequestOk(parseControl(encodeRequestOk({ requestId: 9n })).payload).requestId).toBe(9n);
    const err = decodeRequestError(
      parseControl(encodeRequestError({ requestId: 9n, errorCode: 0x10, reason: 'gone' })).payload
    );
    expect(err).toEqual({ requestId: 9n, errorCode: 0x10, reason: 'gone' });
  });
});

describe('full draft-18 message set round-trip', () => {
  it('SUBSCRIBE_NAMESPACE', () => {
    const enc = encodeSubscribeNamespace({ requestId: 11n, trackNamespacePrefix: ['wave', 'studio'] });
    expect(parseControl(enc).type).toBe(MOQ_MSG.SUBSCRIBE_NAMESPACE);
    const m = decodeSubscribeNamespace(parseControl(enc).payload);
    expect(m).toEqual({ requestId: 11n, trackNamespacePrefix: ['wave', 'studio'] });
  });
  it('PUBLISH', () => {
    const enc = encodePublish({ requestId: 3n, trackNamespace: ['wave', 'cam-1'], trackName: 'video', trackAlias: 7n });
    expect(parseControl(enc).type).toBe(MOQ_MSG.PUBLISH);
    const m = decodePublish(parseControl(enc).payload);
    expect(m).toEqual({ requestId: 3n, trackNamespace: ['wave', 'cam-1'], trackName: 'video', trackAlias: 7n });
  });
  it('TRACK_STATUS (SUBSCRIBE-shaped)', () => {
    const enc = encodeTrackStatus({ requestId: 8n, trackNamespace: ['wave'], trackName: 'audio' });
    expect(parseControl(enc).type).toBe(MOQ_MSG.TRACK_STATUS);
    const m = decodeTrackStatus(parseControl(enc).payload);
    expect(m).toEqual({ requestId: 8n, trackNamespace: ['wave'], trackName: 'audio' });
  });
  it('FETCH with a LOCATION_FILTER (draft-20 #1809 — range moved from message fields to a parameter)', () => {
    const enc = encodeFetch({
      requestId: 4n,
      trackNamespace: ['wave', 'cam-1'],
      trackName: 'v',
      locationFilter: { startGroup: 2n, startObject: 0n, endGroupDelta: 3n, endObject: 0n },
    });
    expect(parseControl(enc).type).toBe(MOQ_MSG.FETCH);
    const m = decodeFetch(parseControl(enc).payload);
    expect(m).toEqual({
      requestId: 4n,
      trackNamespace: ['wave', 'cam-1'],
      trackName: 'v',
      locationFilter: { startGroup: 2n, startObject: 0n, endGroupDelta: 3n, endObject: 0n },
    });
  });
  it('FETCH without a filter round-trips with no LOCATION_FILTER param (whole-track fetch)', () => {
    const enc = encodeFetch({ requestId: 5n, trackNamespace: ['wave'], trackName: 'audio' });
    const m = decodeFetch(parseControl(enc).payload);
    expect(m).toEqual({ requestId: 5n, trackNamespace: ['wave'], trackName: 'audio', locationFilter: undefined });
  });
  it('FETCH has no FetchType/joining variant any more (draft-20 #1673 removed it)', () => {
    const enc = encodeFetch({ requestId: 6n, trackNamespace: ['wave'], trackName: 'v' });
    const m = decodeFetch(parseControl(enc).payload);
    expect(m).not.toHaveProperty('fetchType');
    expect(m).not.toHaveProperty('standalone');
    expect(m).not.toHaveProperty('joining');
  });
  it('LOCATION_FILTER (§5.1.2) positional-prefix field encoding round-trips 0..4 fields', () => {
    expect(decodeLocationFilter(encodeLocationFilter({}))).toEqual({});
    expect(decodeLocationFilter(encodeLocationFilter({ startGroup: 7n }))).toEqual({ startGroup: 7n });
    expect(decodeLocationFilter(encodeLocationFilter({ startGroup: 7n, startObject: 0n }))).toEqual({ startGroup: 7n, startObject: 0n });
    expect(decodeLocationFilter(encodeLocationFilter({ startGroup: 1n, startObject: 0n, endGroupDelta: 4n }))).toEqual({
      startGroup: 1n,
      startObject: 0n,
      endGroupDelta: 4n,
    });
    expect(decodeLocationFilter(encodeLocationFilter({ startGroup: 1n, startObject: 0n, endGroupDelta: 4n, endObject: 9n }))).toEqual({
      startGroup: 1n,
      startObject: 0n,
      endGroupDelta: 4n,
      endObject: 9n,
    });
  });
  it('LOCATION_FILTER rejects a non-positional-prefix combination (e.g. startObject without startGroup)', () => {
    expect(() => encodeLocationFilter({ startObject: 1n })).toThrow(/startGroup/);
    expect(() => encodeLocationFilter({ startGroup: 1n, endGroupDelta: 2n })).toThrow(/startObject/);
    expect(() => encodeLocationFilter({ endObject: 1n })).toThrow(/endGroupDelta/);
  });
  it('FILL_PARAMETERS (0x23, §10.2.15) is the draft-20 #1673 replacement for Joining FETCH', () => {
    expect(MOQ_PARAM.FILL_PARAMETERS).toBe(0x23);
    expect(MOQ_PARAM.LOCATION_FILTER).toBe(0x21);
  });
  it('FILL_PARAMETERS round-trips a fill range and an empty (no-op) value', () => {
    const withFilter = decodeFillParameters(encodeFillParameters({ locationFilter: { startGroup: 4n, startObject: 0n, endGroupDelta: 1n } }));
    expect(withFilter).toEqual({ locationFilter: { startGroup: 4n, startObject: 0n, endGroupDelta: 1n } });
    const empty = decodeFillParameters(encodeFillParameters({}));
    expect(empty).toEqual({ locationFilter: undefined });
  });
  it('decodeLocationFilter rejects more than 4 positional fields as a PROTOCOL_VIOLATION (§5.1.2)', () => {
    const tooMany = new Writer().varint(1n).varint(2n).varint(3n).varint(4n).varint(5n).bytes();
    expect(() => decodeLocationFilter(tooMany)).toThrow(MoqProtocolViolationError);
  });
  it('decodeFetch rejects an unknown Message Parameter as a PROTOCOL_VIOLATION (§10.2)', () => {
    // Number of Parameters=1, TypeDelta=0x99 (unknown), Length=0.
    const params = new Writer().varint(1n).varint(0x99n).varint(0n).bytes();
    const body = new Writer().varint(7n).tuple(['wave']).strLP('v').raw(params).bytes();
    const enc = frameControl(MOQ_MSG.FETCH, body);
    expect(() => decodeFetch(parseControl(enc).payload)).toThrow(MoqProtocolViolationError);
  });
  it('FETCH_OK (no request id; end location)', () => {
    const enc = encodeFetchOk({ endOfTrack: true, end: { group: 9n, object: 4n } });
    expect(parseControl(enc).type).toBe(MOQ_MSG.FETCH_OK);
    expect(decodeFetchOk(parseControl(enc).payload)).toEqual({ endOfTrack: true, end: { group: 9n, object: 4n } });
  });
  it('GOAWAY round-trips WITHOUT a Request ID (draft-19 #1623 dropped the field)', () => {
    const a = decodeGoaway(parseControl(encodeGoaway({ newSessionUri: '', timeoutMs: 5000n })).payload);
    expect(a).toEqual({ newSessionUri: '', timeoutMs: 5000n });
    const b = decodeGoaway(parseControl(encodeGoaway({ newSessionUri: 'wss://b/relay', timeoutMs: 0n })).payload);
    expect(b).toEqual({ newSessionUri: 'wss://b/relay', timeoutMs: 0n });
    // No trailing bytes are emitted — the body is exactly NewSessionUri(strLP) + Timeout(i).
    expect(Object.keys(a)).not.toContain('requestId');
  });
});

describe('PUBLISH_STATE_NOTIFY (draft-20 §ps-notify, 0x22, #1820 — new in draft-20) — #212 E4', () => {
  it('has type 0x22 and no Request ID field (implied by the bidi stream, like FETCH_OK)', () => {
    expect(MOQ_MSG.PUBLISH_STATE_NOTIFY).toBe(0x22);
    const enc = encodePublishStateNotify({});
    expect(parseControl(enc).type).toBe(MOQ_MSG.PUBLISH_STATE_NOTIFY);
    expect(decodePublishStateNotify(parseControl(enc).payload)).not.toHaveProperty('requestId');
  });
  it('round-trips an empty notification (no parameters changed)', () => {
    const enc = encodePublishStateNotify({});
    expect(decodePublishStateNotify(parseControl(enc).payload)).toEqual({});
  });
  it('round-trips LARGEST_OBJECT (0x9, §largest-param) — Location as two raw varints, no length prefix', () => {
    const enc = encodePublishStateNotify({ largestObject: { group: 12n, object: 4n } });
    expect(decodePublishStateNotify(parseControl(enc).payload)).toEqual({ largestObject: { group: 12n, object: 4n } });
  });
  it('round-trips FORWARD (0x10, §forward-parameter) — uint8, 0 or 1', () => {
    expect(decodePublishStateNotify(parseControl(encodePublishStateNotify({ forward: 0 })).payload)).toEqual({ forward: 0 });
    expect(decodePublishStateNotify(parseControl(encodePublishStateNotify({ forward: 1 })).payload)).toEqual({ forward: 1 });
  });
  it('round-trips LOCATION_FILTER (0x21, §location-filter) — shared LocationFilter type/codec with FETCH', () => {
    const enc = encodePublishStateNotify({ locationFilter: { startGroup: 3n, startObject: 0n } });
    expect(decodePublishStateNotify(parseControl(enc).payload)).toEqual({ locationFilter: { startGroup: 3n, startObject: 0n } });
  });
  it('round-trips all three parameters together, serialized in ascending Type order regardless of field order', () => {
    const enc = encodePublishStateNotify({
      locationFilter: { startGroup: 1n },
      forward: 1,
      largestObject: { group: 5n, object: 2n },
    });
    expect(decodePublishStateNotify(parseControl(enc).payload)).toEqual({
      largestObject: { group: 5n, object: 2n },
      forward: 1,
      locationFilter: { startGroup: 1n },
    });
  });
  it('rejects an out-of-range FORWARD value as a PROTOCOL_VIOLATION (§forward-parameter)', () => {
    // Number of Parameters=1, TypeDelta=FORWARD(0x10), Value=2 (only 0/1 are legal).
    const body = new Writer().varint(1n).varint(PUBLISH_STATE_NOTIFY_PARAM.FORWARD).u8(2).bytes();
    const enc = frameControl(MOQ_MSG.PUBLISH_STATE_NOTIFY, body);
    expect(() => decodePublishStateNotify(parseControl(enc).payload)).toThrow(MoqProtocolViolationError);
  });
  it('rejects an unknown Message Parameter as a PROTOCOL_VIOLATION (§message-params — e.g. GROUP_ORDER is not valid here)', () => {
    // Number of Parameters=1, TypeDelta=0x22 (GROUP_ORDER — valid elsewhere, NOT listed for
    // PUBLISH_STATE_NOTIFY), Length=1, Value=1.
    const body = new Writer().varint(1n).varint(0x22n).varint(1n).u8(1).bytes();
    const enc = frameControl(MOQ_MSG.PUBLISH_STATE_NOTIFY, body);
    expect(() => decodePublishStateNotify(parseControl(enc).payload)).toThrow(MoqProtocolViolationError);
  });
  it('rejects a repeated Message Parameter type as a PROTOCOL_VIOLATION (§message-params: "MUST NOT repeat")', () => {
    // Number of Parameters=2, both FORWARD (0x10): TypeDelta=0x10,Value=1 then TypeDelta=0(repeat),Value=1.
    const body = new Writer().varint(2n).varint(0x10n).u8(1).varint(0n).u8(1).bytes();
    const enc = frameControl(MOQ_MSG.PUBLISH_STATE_NOTIFY, body);
    expect(() => decodePublishStateNotify(parseControl(enc).payload)).toThrow(MoqProtocolViolationError);
  });
});
