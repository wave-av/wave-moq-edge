import { describe, it, expect } from 'vitest';
import { MoqRelay } from '../src/moq-relay';
import {
  MOQ_MSG,
  MOQ_ROLE,
  MOQ_ERROR,
  MOQ_FETCH_TYPE,
  parseControl,
  encodeSetup,
  encodeSubscribe,
  encodePublishNamespace,
  encodePublish,
  encodeTrackStatus,
  encodeSubscribeNamespace,
  encodeFetch,
  encodeGoaway,
  encodeObject,
  decodeSubscribeOk,
  decodeRequestOk,
  decodeRequestError,
  decodeObject,
  MOQ_OBJECT_STATUS,
} from '../src/moq-wire';
import { MetricsCollector, type MoqMetric } from '../metrics-collector';

const NS = ['wave', 'cam-1'];

function setup(relay: MoqRelay, sid: string, role: number) {
  return relay.onControl(sid, encodeSetup({ role, maxSubscriptions: 100n }));
}

describe('MoqRelay control plane', () => {
  it('SETUP is echoed back as a relay SETUP', () => {
    const relay = new MoqRelay();
    const { replies } = setup(relay, 'pub', MOQ_ROLE.PUBLISHER);
    expect(replies).toHaveLength(1);
    expect(parseControl(replies[0].frame).type).toBe(MOQ_MSG.SETUP);
  });

  it('PUBLISH_NAMESPACE attaches the publisher + replies REQUEST_OK', () => {
    const relay = new MoqRelay();
    const { replies, events } = relay.onControl('pub', encodePublishNamespace({ requestId: 7n, trackNamespace: NS }));
    expect(relay.hasPublisher).toBe(true);
    expect(decodeRequestOk(parseControl(replies[0].frame).payload).requestId).toBe(7n);
    expect(events).toEqual([{ kind: 'publish_start', sessionId: 'pub' }]);
  });

  it('SUBSCRIBE registers a subscriber + replies SUBSCRIBE_OK', () => {
    const relay = new MoqRelay();
    const { replies, events } = relay.onControl('sub', encodeSubscribe({ requestId: 5n, trackNamespace: NS, trackName: 'video' }));
    expect(relay.subscriberCount).toBe(1);
    const ok = decodeSubscribeOk(parseControl(replies[0].frame).payload);
    expect(ok.requestId).toBe(5n);
    expect(events).toEqual([{ kind: 'subscribe', sessionId: 'sub' }]);
  });
});

describe('MoqRelay fan-out', () => {
  it('fans a publisher object out to every subscriber, re-stamped with the track alias', () => {
    const relay = new MoqRelay();
    relay.onControl('pub', encodePublishNamespace({ requestId: 1n, trackNamespace: NS }));
    relay.onControl('a', encodeSubscribe({ requestId: 2n, trackNamespace: NS, trackName: 'v' }));
    relay.onControl('b', encodeSubscribe({ requestId: 3n, trackNamespace: NS, trackName: 'v' }));

    const obj = encodeObject({ trackAlias: 99n, groupId: 0n, objectId: 0n, status: MOQ_OBJECT_STATUS.NORMAL, payload: new Uint8Array([1, 2, 3, 4]) });
    const { fanout, events } = relay.onObject('pub', obj);

    expect(fanout.map((f) => f.to).sort()).toEqual(['a', 'b']);
    for (const f of fanout) {
      expect(f.kind).toBe('object');
      const o = decodeObject(f.frame);
      expect(o.trackAlias).toBe(1n); // re-stamped to the relay's single track alias
      expect(Array.from(o.payload)).toEqual([1, 2, 3, 4]);
    }
    expect(events).toEqual([{ kind: 'object_received', sessionId: 'pub', bytes: 4 }]);
  });

  it('ignores objects from a non-publisher session', () => {
    const relay = new MoqRelay();
    relay.onControl('pub', encodePublishNamespace({ requestId: 1n, trackNamespace: NS }));
    relay.onControl('a', encodeSubscribe({ requestId: 2n, trackNamespace: NS, trackName: 'v' }));
    const obj = encodeObject({ trackAlias: 1n, groupId: 0n, objectId: 0n, status: 0, payload: new Uint8Array([9]) });
    const { fanout, events } = relay.onObject('a', obj); // 'a' is a subscriber, not the publisher
    expect(fanout).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('emits group_complete when the group id advances', () => {
    const relay = new MoqRelay();
    relay.onControl('pub', encodePublishNamespace({ requestId: 1n, trackNamespace: NS }));
    relay.onObject('pub', encodeObject({ trackAlias: 1n, groupId: 0n, objectId: 0n, status: 0, payload: new Uint8Array([1]) }));
    const { events } = relay.onObject('pub', encodeObject({ trackAlias: 1n, groupId: 1n, objectId: 0n, status: 0, payload: new Uint8Array([2]) }));
    expect(events).toContainEqual({ kind: 'group_complete', sessionId: 'pub' });
  });

  it('removeSession drops publisher/subscriber with the right events', () => {
    const relay = new MoqRelay();
    relay.onControl('pub', encodePublishNamespace({ requestId: 1n, trackNamespace: NS }));
    relay.onControl('a', encodeSubscribe({ requestId: 2n, trackNamespace: NS, trackName: 'v' }));
    expect(relay.removeSession('a')).toEqual([{ kind: 'unsubscribe', sessionId: 'a' }]);
    expect(relay.subscriberCount).toBe(0);
    expect(relay.removeSession('pub')).toEqual([{ kind: 'publish_end', sessionId: 'pub' }]);
    expect(relay.hasPublisher).toBe(false);
  });
});

function attachPub(relay: MoqRelay, sid = 'pub') {
  relay.onControl(sid, encodePublishNamespace({ requestId: 1n, trackNamespace: NS }));
}
function pushObj(relay: MoqRelay, group: number, object: number, sid = 'pub') {
  return relay.onObject(sid, encodeObject({ trackAlias: 1n, groupId: BigInt(group), objectId: BigInt(object), status: MOQ_OBJECT_STATUS.NORMAL, payload: new Uint8Array([group, object]) }));
}

describe('MoqRelay full draft-18 control handlers', () => {
  it('PUBLISH attaches the publisher + replies REQUEST_OK (like PUBLISH_NAMESPACE)', () => {
    const relay = new MoqRelay();
    const { replies, events } = relay.onControl('pub', encodePublish({ requestId: 5n, trackNamespace: NS, trackName: 'v', trackAlias: 9n }));
    expect(relay.hasPublisher).toBe(true);
    expect(decodeRequestOk(parseControl(replies[0].frame).payload).requestId).toBe(5n);
    expect(events).toEqual([{ kind: 'publish_start', sessionId: 'pub' }]);
  });
  it('SUBSCRIBE_NAMESPACE replies REQUEST_OK', () => {
    const relay = new MoqRelay();
    const { replies } = relay.onControl('s', encodeSubscribeNamespace({ requestId: 3n, trackNamespacePrefix: ['wave'] }));
    expect(parseControl(replies[0].frame).type).toBe(MOQ_MSG.REQUEST_OK);
    expect(decodeRequestOk(parseControl(replies[0].frame).payload).requestId).toBe(3n);
  });
  it('TRACK_STATUS: REQUEST_OK when a publisher is live, DOES_NOT_EXIST otherwise', () => {
    const relay = new MoqRelay();
    let r = relay.onControl('q', encodeTrackStatus({ requestId: 4n, trackNamespace: NS, trackName: 'v' }));
    expect(parseControl(r.replies[0].frame).type).toBe(MOQ_MSG.REQUEST_ERROR);
    expect(decodeRequestError(parseControl(r.replies[0].frame).payload).errorCode).toBe(MOQ_ERROR.DOES_NOT_EXIST);
    attachPub(relay);
    r = relay.onControl('q', encodeTrackStatus({ requestId: 5n, trackNamespace: NS, trackName: 'v' }));
    expect(parseControl(r.replies[0].frame).type).toBe(MOQ_MSG.REQUEST_OK);
  });
  it('GOAWAY is accepted silently (no reply)', () => {
    const relay = new MoqRelay();
    const { replies, objects, events } = relay.onControl('x', encodeGoaway({ newSessionUri: '', timeoutMs: 0n }));
    expect(replies).toHaveLength(0);
    expect(objects).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe('MoqRelay late-joiner group cache', () => {
  it('replays cached recent objects to a subscriber that joins mid-stream', () => {
    const relay = new MoqRelay();
    attachPub(relay);
    pushObj(relay, 0, 0);
    pushObj(relay, 0, 1);
    const { objects } = relay.onControl('late', encodeSubscribe({ requestId: 9n, trackNamespace: NS, trackName: 'v' }));
    expect(objects).toHaveLength(2);
    expect(objects.every((o) => o.to === 'late' && o.kind === 'object')).toBe(true);
    // replayed frames are the forwarded (re-stamped alias) frames
    expect(decodeObject(objects[0].frame).trackAlias).toBe(1n);
    expect(Array.from(decodeObject(objects[1].frame).payload)).toEqual([0, 1]);
  });
  it('evicts oldest groups beyond the cap', () => {
    const relay = new MoqRelay({ cachedGroups: 2 });
    attachPub(relay);
    pushObj(relay, 0, 0);
    pushObj(relay, 1, 0);
    pushObj(relay, 2, 0); // group 0 evicted; cache holds groups 1,2
    expect(relay.cachedObjectCount).toBe(2);
    const { objects } = relay.onControl('late', encodeSubscribe({ requestId: 1n, trackNamespace: NS, trackName: 'v' }));
    expect(objects.map((o) => Array.from(decodeObject(o.frame).payload))).toEqual([[1, 0], [2, 0]]);
  });
  it('a zero-size cache replays nothing', () => {
    const relay = new MoqRelay({ cachedGroups: 0 });
    attachPub(relay);
    pushObj(relay, 0, 0);
    expect(relay.cachedObjectCount).toBe(0);
    const { objects } = relay.onControl('late', encodeSubscribe({ requestId: 1n, trackNamespace: NS, trackName: 'v' }));
    expect(objects).toHaveLength(0);
  });
});

describe('MoqRelay FETCH from cache', () => {
  function seed() {
    const relay = new MoqRelay();
    attachPub(relay);
    for (const g of [0, 1, 2]) for (const o of [0, 1]) pushObj(relay, g, o);
    return relay;
  }
  it('standalone fetch replays the in-range objects after FETCH_OK', () => {
    const relay = seed();
    const { replies, objects } = relay.onControl(
      'f',
      encodeFetch({ requestId: 7n, fetchType: MOQ_FETCH_TYPE.STANDALONE, standalone: { trackNamespace: NS, trackName: 'v', start: { group: 1n, object: 0n }, end: { group: 2n, object: 0n } } })
    );
    expect(parseControl(replies[0].frame).type).toBe(MOQ_MSG.FETCH_OK);
    // groups 1 & 2 (end.object=0 ⇒ whole group 2): 4 objects
    expect(objects.map((o) => Array.from(decodeObject(o.frame).payload))).toEqual([[1, 0], [1, 1], [2, 0], [2, 1]]);
  });
  it('out-of-range fetch → REQUEST_ERROR INVALID_RANGE, no objects', () => {
    const relay = seed();
    const { replies, objects } = relay.onControl(
      'f',
      encodeFetch({ requestId: 7n, fetchType: MOQ_FETCH_TYPE.STANDALONE, standalone: { trackNamespace: NS, trackName: 'v', start: { group: 99n, object: 0n }, end: { group: 100n, object: 0n } } })
    );
    expect(decodeRequestError(parseControl(replies[0].frame).payload).errorCode).toBe(MOQ_ERROR.INVALID_RANGE);
    expect(objects).toHaveLength(0);
  });
  it('joining fetch → REQUEST_ERROR NOT_SUPPORTED', () => {
    const relay = seed();
    const { replies } = relay.onControl('f', encodeFetch({ requestId: 7n, fetchType: MOQ_FETCH_TYPE.RELATIVE_JOINING, joining: { joiningRequestId: 1n, joiningStart: 0n } }));
    expect(decodeRequestError(parseControl(replies[0].frame).payload).errorCode).toBe(MOQ_ERROR.NOT_SUPPORTED);
  });
});

describe('MoqRelay hibernation rehydration', () => {
  it('restores publisher + subscribers from attachments so fan-out resumes without re-handshake', () => {
    // Simulate a DO wake: a fresh relay rebuilt purely from surviving socket attachments.
    const woken = new MoqRelay();
    woken.hydrate([
      { sessionId: 'pub', role: 'publisher' },
      { sessionId: 'a', role: 'subscriber' },
      { sessionId: 'b', role: 'subscriber' },
    ]);
    expect(woken.hasPublisher).toBe(true);
    expect(woken.subscriberCount).toBe(2);

    // A post-wake publisher object still fans out to both restored subscribers.
    const { fanout } = pushObj(woken, 7, 0);
    expect(fanout.map((f) => f.to).sort()).toEqual(['a', 'b']);
  });
  it('a non-publisher restored session cannot push objects', () => {
    const woken = new MoqRelay();
    woken.hydrate([{ sessionId: 'a', role: 'subscriber' }]);
    const { fanout, events } = pushObj(woken, 0, 0, 'a'); // 'a' is a subscriber, not the publisher
    expect(fanout).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe('relay events fold into the R4 wave.usage meter', () => {
  it('object_received increments frames + bytes in the canonical meter', async () => {
    const relay = new MoqRelay();
    const collector = new MetricsCollector({ MOQ_TRACK_REGISTRY: {} as never, ENVIRONMENT: 'test', MOQ_DRAFT_VERSION: '18' });
    const trackKey = 'wave/cam-1';

    relay.onControl('pub', encodePublishNamespace({ requestId: 1n, trackNamespace: NS }));
    relay.onControl('a', encodeSubscribe({ requestId: 2n, trackNamespace: NS, trackName: 'v' }));

    for (let i = 0; i < 3; i++) {
      const { events } = relay.onObject('pub', encodeObject({ trackAlias: 1n, groupId: 0n, objectId: BigInt(i), status: 0, payload: new Uint8Array(100) }));
      for (const e of events) {
        const metric: MoqMetric = { ts: '', kind: e.kind, trackKey, sessionId: e.sessionId, bytes: e.bytes };
        await collector.record(metric);
      }
    }

    const usage = collector.usage(trackKey);
    expect(usage.protocol).toBe('moq');
    expect(usage.direction).toBe('out');
    expect(usage.frames).toBe(3);
    expect(usage.bytes).toBe(300);
    expect(usage.integrity.checked).toBe(3);
    expect(usage.integrity.matches).toBe(3);
  });
});
