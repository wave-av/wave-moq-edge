import { describe, it, expect } from 'vitest';
import { MoqRelay } from '../src/moq-relay';
import {
  MOQ_MSG,
  MOQ_ROLE,
  parseControl,
  encodeSetup,
  encodeSubscribe,
  encodePublishNamespace,
  encodeObject,
  decodeSubscribeOk,
  decodeRequestOk,
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
