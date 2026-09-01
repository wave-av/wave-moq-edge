import { describe, it, expect } from 'vitest';
import { MoqRelay } from '../src/moq-relay';
import {
  MOQ_MSG,
  MOQ_ROLE,
  MOQ_ERROR,
  parseControl,
  encodeSetup,
  encodeSubscribe,
  encodePublishNamespace,
  encodePublish,
  encodeTrackStatus,
  encodeSubscribeNamespace,
  encodeFetch,
  encodeGoaway,
  encodePublishStateNotify,
  encodeObject,
  decodeSubscribeOk,
  decodeRequestOk,
  decodeRequestError,
  decodeObject,
  MOQ_OBJECT_STATUS,
  encodeSubgroupStream,
  SUBGROUP_ID_MODE,
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
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'object_received', sessionId: 'pub', bytes: 4 });
    // the decoded payload rides along on object_received so the DO can persist it (recording write path)
    expect(Array.from(events[0].payload!)).toEqual([1, 2, 3, 4]);
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
  it('PUBLISH_STATE_NOTIFY (#212 E4, draft-20 §ps-notify) is accepted silently (no REQUEST_OK/REQUEST_ERROR reply)', () => {
    const relay = new MoqRelay();
    const { replies, objects, events } = relay.onControl('pub', encodePublishStateNotify({ forward: 1, largestObject: { group: 3n, object: 0n } }));
    expect(replies).toHaveLength(0);
    expect(objects).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
  it('PUBLISH_STATE_NOTIFY does NOT fall through to the default handler\'s spurious REQUEST_ERROR (its leading varint is Number of Parameters, not a Request ID)', () => {
    const relay = new MoqRelay();
    const { replies } = relay.onControl('pub', encodePublishStateNotify({}));
    expect(replies).toHaveLength(0); // if mishandled by `default`, this would be a REQUEST_ERROR reply
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
  it('fetch with an absolute LOCATION_FILTER replays the in-range objects after FETCH_OK', () => {
    const relay = seed();
    const { replies, objects } = relay.onControl(
      'f',
      encodeFetch({ requestId: 7n, trackNamespace: NS, trackName: 'v', locationFilter: { startGroup: 1n, startObject: 0n, endGroupDelta: 1n } })
    );
    expect(parseControl(replies[0].frame).type).toBe(MOQ_MSG.FETCH_OK);
    // groups 1 & 2 (EndObject omitted ⇒ whole End Group per §5.1.2): 4 objects
    expect(objects.map((o) => Array.from(decodeObject(o.frame).payload))).toEqual([[1, 0], [1, 1], [2, 0], [2, 1]]);
  });
  it('fetch with an EndGroupDelta but no EndObject includes the whole End Group (§5.1.2 "omitted EndObject")', () => {
    const relay = seed();
    const { objects } = relay.onControl('f', encodeFetch({ requestId: 7n, trackNamespace: NS, trackName: 'v', locationFilter: { startGroup: 2n, startObject: 0n, endGroupDelta: 0n } }));
    expect(objects.map((o) => Array.from(decodeObject(o.frame).payload))).toEqual([[2, 0], [2, 1]]);
  });
  it('fetch with no LOCATION_FILTER replays the whole cached track (§5.1.2 "unfiltered ⇒ {0,0} to Largest Object")', () => {
    const relay = seed();
    const { objects } = relay.onControl('f', encodeFetch({ requestId: 7n, trackNamespace: NS, trackName: 'v' }));
    expect(objects).toHaveLength(6); // groups 0,1,2 × objects 0,1
  });
  it('out-of-range fetch → REQUEST_ERROR INVALID_RANGE, no objects', () => {
    const relay = seed();
    const { replies, objects } = relay.onControl(
      'f',
      encodeFetch({ requestId: 7n, trackNamespace: NS, trackName: 'v', locationFilter: { startGroup: 99n, startObject: 0n, endGroupDelta: 1n, endObject: 0n } })
    );
    expect(decodeRequestError(parseControl(replies[0].frame).payload).errorCode).toBe(MOQ_ERROR.INVALID_RANGE);
    expect(objects).toHaveLength(0);
  });
  it('relative LOCATION_FILTER (draft-20 #1673 replaced Joining FETCH with SUBSCRIBE-side fill-fetch) → REQUEST_ERROR NOT_SUPPORTED', () => {
    const relay = seed();
    const { replies } = relay.onControl('f', encodeFetch({ requestId: 7n, trackNamespace: NS, trackName: 'v', locationFilter: { startGroup: 1n } }));
    expect(decodeRequestError(parseControl(replies[0].frame).payload).errorCode).toBe(MOQ_ERROR.NOT_SUPPORTED);
  });
  it('the "Next Object" LOCATION_FILTER shorthand (StartGroup=StartObject=0) → REQUEST_ERROR NOT_SUPPORTED', () => {
    const relay = seed();
    const { replies } = relay.onControl('f', encodeFetch({ requestId: 7n, trackNamespace: NS, trackName: 'v', locationFilter: { startGroup: 0n, startObject: 0n } }));
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

describe('#212 E2 forwarding conformance (draft-19 #1762: a relay MAY NOT reorder or drop objects)', () => {
  it('scheduler ON: whole-group flush preserves cross-group order — within-group priority reorder never crosses a group boundary, and nothing is dropped', () => {
    const relay = new MoqRelay({ scheduler: true });
    relay.onControl('pub', encodePublishNamespace({ requestId: 1n, trackNamespace: NS }));
    relay.onControl('a', encodeSubscribe({ requestId: 2n, trackNamespace: NS, trackName: 'v' }));

    const delivered: Array<{ group: number; object: number }> = [];
    const collect = (fanout: { frame: Uint8Array }[]) => {
      for (const f of fanout) {
        const o = decodeObject(f.frame);
        delivered.push({ group: Number(o.groupId), object: Number(o.objectId) });
      }
    };

    // Three groups of three objects each, arriving strictly in group order 0, 1, 2. Priorities are
    // deliberately scrambled WITHIN each group so the E1/E3 scheduler has something to reorder — the
    // invariant under test is that this reorder is scoped to ONE group at a time and never disturbs
    // cross-group arrival order (draft-19 #1762).
    for (let g = 0; g < 3; g++) {
      const prios = [30, 10, 20]; // object 0 lowest priority, object 1 highest, object 2 middle
      for (let o = 0; o < 3; o++) {
        const r = relay.onDecodedObject({
          trackAlias: 99n,
          groupId: BigInt(g),
          objectId: BigInt(o),
          status: MOQ_OBJECT_STATUS.NORMAL,
          payload: new Uint8Array([g, o]),
          priority: prios[o],
        });
        collect(r.fanout);
      }
    }
    collect(relay.flush()); // drain the final buffered group (no group-boundary trigger for it)

    // No drop: every one of the 9 (group, object) pairs was delivered exactly once.
    expect(delivered).toHaveLength(9);
    expect(new Set(delivered.map((d) => `${d.group}.${d.object}`)).size).toBe(9);

    // No cross-group reorder: once a group's objects start appearing, no OTHER group's objects
    // interleave before that group is fully drained — i.e. a group never "resumes" after another
    // group has started (which would mean the relay put a later-arriving group ahead of an earlier
    // one, or split one group's delivery around another's).
    let lastGroup = -1;
    const finishedGroups = new Set<number>();
    for (const d of delivered) {
      if (d.group !== lastGroup) {
        expect(finishedGroups.has(d.group)).toBe(false);
        if (lastGroup !== -1) finishedGroups.add(lastGroup);
        lastGroup = d.group;
      }
    }
    expect([...new Set(delivered.map((d) => d.group))]).toEqual([0, 1, 2]); // arrival order, not renumbered

    // Within group 0, the scheduler DID reorder by priority (10, 20, 30 → objects 1, 2, 0) — proving
    // the reorder is real and scoped, not merely absent.
    expect(delivered.filter((d) => d.group === 0).map((d) => d.object)).toEqual([1, 2, 0]);
  });

  it('SUBGROUP_HEADER path: onSubgroupFrame flushes a whole group on endOfGroup, preserving cross-group order with no drop', () => {
    const relay = new MoqRelay({ scheduler: true });
    relay.onControl('pub', encodePublishNamespace({ requestId: 1n, trackNamespace: NS }));
    relay.onControl('a', encodeSubscribe({ requestId: 2n, trackNamespace: NS, trackName: 'v' }));

    const delivered: Array<{ group: number; object: number }> = [];
    for (let g = 0; g < 3; g++) {
      const header = {
        trackAlias: 99n,
        groupId: BigInt(g),
        subgroupId: 0n,
        idMode: SUBGROUP_ID_MODE.ZERO,
        priority: 10,
        defaultPriority: false,
        endOfGroup: true, // whole-group unit: the header's own FIN-implies-largest-object contract
        firstObject: true,
      };
      const objects = [
        { objectId: 0n, status: MOQ_OBJECT_STATUS.NORMAL, payload: new Uint8Array([g, 0]) },
        { objectId: 1n, status: MOQ_OBJECT_STATUS.NORMAL, payload: new Uint8Array([g, 1]) },
        { objectId: 2n, status: MOQ_OBJECT_STATUS.NORMAL, payload: new Uint8Array([g, 2]) },
      ];
      const { fanout } = relay.onSubgroupFrame(encodeSubgroupStream(header, objects));
      for (const f of fanout) {
        const o = decodeObject(f.frame);
        delivered.push({ group: Number(o.groupId), object: Number(o.objectId) });
      }
    }

    // No drop: 3 groups x 3 objects, every one delivered.
    expect(delivered).toHaveLength(9);
    // No cross-group reorder: each subgroup's endOfGroup flush drains that group in full, in order,
    // BEFORE the next group's frame is even processed — so arrival order is preserved exactly.
    expect(delivered.map((d) => `${d.group}.${d.object}`)).toEqual(['0.0', '0.1', '0.2', '1.0', '1.1', '1.2', '2.0', '2.1', '2.2']);
  });
});
