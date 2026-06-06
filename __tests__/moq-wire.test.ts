import { describe, it, expect } from 'vitest';
import {
  Writer,
  Reader,
  frameControl,
  parseControl,
  MOQ_MSG,
  MOQ_ROLE,
  MOQ_OBJECT_STATUS,
  MOQ_DRAFT_VERSION,
  MOQ_ALPN,
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
  encodeObject,
  decodeObject,
  MOQ_FETCH_TYPE,
  SUBGROUP_ID_MODE,
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
  encodeSubgroupStream,
  decodeSubgroupStream,
  subgroupTypeByte,
  isSubgroupType,
} from '../src/moq-wire';

describe('draft-18 constants', () => {
  it('pins draft 18 + ALPN + the relay control codes', () => {
    expect(MOQ_DRAFT_VERSION).toBe(18);
    expect(MOQ_ALPN).toBe('moqt-18');
    expect(MOQ_MSG.SETUP).toBe(0x2f00);
    expect(MOQ_MSG.SUBSCRIBE).toBe(0x3);
    expect(MOQ_MSG.SUBSCRIBE_OK).toBe(0x4);
    expect(MOQ_MSG.REQUEST_ERROR).toBe(0x5);
    expect(MOQ_MSG.PUBLISH_NAMESPACE).toBe(0x6);
    expect(MOQ_MSG.REQUEST_OK).toBe(0x7);
    expect(MOQ_MSG.GOAWAY).toBe(0x10);
  });
  it('pins the full draft-18 message set codes (verified against the tagged source)', () => {
    expect(MOQ_MSG.PUBLISH).toBe(0x1d);
    expect(MOQ_MSG.FETCH).toBe(0x16);
    expect(MOQ_MSG.FETCH_OK).toBe(0x18);
    expect(MOQ_MSG.TRACK_STATUS).toBe(0xd);
    expect(MOQ_MSG.SUBSCRIBE_NAMESPACE).toBe(0x50);
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
    }
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
  it('FETCH standalone (group/object range)', () => {
    const enc = encodeFetch({
      requestId: 4n,
      fetchType: MOQ_FETCH_TYPE.STANDALONE,
      standalone: { trackNamespace: ['wave', 'cam-1'], trackName: 'v', start: { group: 2n, object: 0n }, end: { group: 5n, object: 0n } },
    });
    expect(parseControl(enc).type).toBe(MOQ_MSG.FETCH);
    const m = decodeFetch(parseControl(enc).payload);
    expect(m.requestId).toBe(4n);
    expect(m.fetchType).toBe(MOQ_FETCH_TYPE.STANDALONE);
    expect(m.standalone).toEqual({ trackNamespace: ['wave', 'cam-1'], trackName: 'v', start: { group: 2n, object: 0n }, end: { group: 5n, object: 0n } });
  });
  it('FETCH joining', () => {
    const enc = encodeFetch({ requestId: 6n, fetchType: MOQ_FETCH_TYPE.RELATIVE_JOINING, joining: { joiningRequestId: 2n, joiningStart: 1n } });
    const m = decodeFetch(parseControl(enc).payload);
    expect(m.joining).toEqual({ joiningRequestId: 2n, joiningStart: 1n });
  });
  it('FETCH_OK (no request id; end location)', () => {
    const enc = encodeFetchOk({ endOfTrack: true, end: { group: 9n, object: 4n } });
    expect(parseControl(enc).type).toBe(MOQ_MSG.FETCH_OK);
    expect(decodeFetchOk(parseControl(enc).payload)).toEqual({ endOfTrack: true, end: { group: 9n, object: 4n } });
  });
  it('GOAWAY with + without a control-stream request id', () => {
    const a = decodeGoaway(parseControl(encodeGoaway({ newSessionUri: '', timeoutMs: 5000n })).payload);
    expect(a).toEqual({ newSessionUri: '', timeoutMs: 5000n, requestId: undefined });
    const b = decodeGoaway(parseControl(encodeGoaway({ newSessionUri: 'wss://b/relay', timeoutMs: 0n, requestId: 12n })).payload);
    expect(b).toEqual({ newSessionUri: 'wss://b/relay', timeoutMs: 0n, requestId: 12n });
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
