import { describe, it, expect } from 'vitest';
import { MoqRelay } from '../src/moq-relay';
import {
  MOQ_ERROR,
  parseControl,
  encodeSubscribe,
  encodePublishNamespace,
  encodeObject,
  encodeRequestUpdate,
  decodeObject,
  decodeRequestOk,
  decodeRequestError,
  MOQ_OBJECT_STATUS,
} from '../src/moq-wire';

// New test file (not added to __tests__/moq-relay.test.ts, already flagged over the repo's file-size
// advisory) — #212 E6 relay-behavior tests: REQUEST_UPDATE applied to a LIVE subscription mid-stream.

const NS = ['wave', 'cam-1'];

function attachPub(relay: MoqRelay, sid = 'pub') {
  relay.onControl(sid, encodePublishNamespace({ requestId: 1n, trackNamespace: NS }));
}
function pushObj(relay: MoqRelay, group: number, object: number, sid = 'pub') {
  return relay.onObject(sid, encodeObject({ trackAlias: 1n, groupId: BigInt(group), objectId: BigInt(object), status: MOQ_OBJECT_STATUS.NORMAL, payload: new Uint8Array([group, object]) }));
}
function deliveredLocations(fanout: ReturnType<MoqRelay['onObject']>['fanout'], to: string): string[] {
  return fanout.filter((f) => f.to === to).map((f) => {
    const o = decodeObject(f.frame);
    return `${o.groupId}.${o.objectId}`;
  });
}

describe('#212 E6 REQUEST_UPDATE — mid-stream viewport range update (draft-20 §message-request-update, 0x2)', () => {
  it('a REQUEST_UPDATE with a new LOCATION_FILTER replies REQUEST_OK and re-filters SUBSEQUENT live objects by the NEW range', () => {
    const relay = new MoqRelay();
    attachPub(relay);
    relay.onControl('viewport', encodeSubscribe({ requestId: 2n, trackNamespace: NS, trackName: 'v', locationFilter: { startGroup: 0n, startObject: 0n, endGroupDelta: 0n, endObject: 5n } }));

    // Before the update: group 0 is in range, group 5 is not.
    expect(deliveredLocations(pushObj(relay, 0, 1).fanout, 'viewport')).toEqual(['0.1']);
    expect(deliveredLocations(pushObj(relay, 5, 1).fanout, 'viewport')).toEqual([]);

    // The viewer's viewport moved — REQUEST_UPDATE narrows the range to group 5 only.
    const { replies } = relay.onControl('viewport', encodeRequestUpdate({ requestId: 4n, locationFilter: { startGroup: 5n, startObject: 0n, endGroupDelta: 0n } }));
    expect(decodeRequestOk(parseControl(replies[0].frame).payload).requestId).toBe(4n);

    // After the update: the OLD range (group 0) no longer applies; the NEW range (group 5+) does.
    expect(deliveredLocations(pushObj(relay, 0, 2).fanout, 'viewport')).toEqual([]);
    expect(deliveredLocations(pushObj(relay, 5, 2).fanout, 'viewport')).toEqual(['5.2']);
  });

  it('a zero-length LOCATION_FILTER ({}) on REQUEST_UPDATE removes the filter — subscriber becomes unfiltered', () => {
    const relay = new MoqRelay();
    attachPub(relay);
    relay.onControl('viewport', encodeSubscribe({ requestId: 2n, trackNamespace: NS, trackName: 'v', locationFilter: { startGroup: 0n, startObject: 0n, endGroupDelta: 0n, endObject: 0n } }));
    expect(deliveredLocations(pushObj(relay, 9, 0).fanout, 'viewport')).toEqual([]); // out of range pre-update

    relay.onControl('viewport', encodeRequestUpdate({ requestId: 4n, locationFilter: {} }));
    expect(deliveredLocations(pushObj(relay, 9, 0).fanout, 'viewport')).toEqual(['9.0']); // unfiltered post-update
  });

  it('a REQUEST_UPDATE with no LOCATION_FILTER parameter leaves the current range unchanged', () => {
    const relay = new MoqRelay();
    attachPub(relay);
    relay.onControl('viewport', encodeSubscribe({ requestId: 2n, trackNamespace: NS, trackName: 'v', locationFilter: { startGroup: 1n, startObject: 0n, endGroupDelta: 0n, endObject: 2n } }));

    relay.onControl('viewport', encodeRequestUpdate({ requestId: 4n, forward: 1 })); // no locationFilter field
    expect(deliveredLocations(pushObj(relay, 1, 1).fanout, 'viewport')).toEqual(['1.1']); // still the original range
    expect(deliveredLocations(pushObj(relay, 9, 0).fanout, 'viewport')).toEqual([]); // still excluded
  });

  it('REQUEST_UPDATE(FORWARD=0) pauses live delivery to that subscriber WITHOUT dropping the subscription', () => {
    const relay = new MoqRelay();
    attachPub(relay);
    relay.onControl('viewport', encodeSubscribe({ requestId: 2n, trackNamespace: NS, trackName: 'v' }));
    expect(relay.subscriberCount).toBe(1);

    relay.onControl('viewport', encodeRequestUpdate({ requestId: 4n, forward: 0 }));
    expect(relay.subscriberCount).toBe(1); // still subscribed — just paused
    expect(deliveredLocations(pushObj(relay, 0, 0).fanout, 'viewport')).toEqual([]);

    relay.onControl('viewport', encodeRequestUpdate({ requestId: 6n, forward: 1 })); // resume
    expect(deliveredLocations(pushObj(relay, 0, 1).fanout, 'viewport')).toEqual(['0.1']);
  });

  it('a relative LOCATION_FILTER on REQUEST_UPDATE → REQUEST_ERROR NOT_SUPPORTED, the OLD range stays in effect', () => {
    const relay = new MoqRelay();
    attachPub(relay);
    relay.onControl('viewport', encodeSubscribe({ requestId: 2n, trackNamespace: NS, trackName: 'v', locationFilter: { startGroup: 1n, startObject: 0n, endGroupDelta: 0n, endObject: 2n } }));

    const { replies } = relay.onControl('viewport', encodeRequestUpdate({ requestId: 4n, locationFilter: { startGroup: 3n } })); // lone StartGroup = relative
    expect(decodeRequestError(parseControl(replies[0].frame).payload).errorCode).toBe(MOQ_ERROR.NOT_SUPPORTED);
    expect(deliveredLocations(pushObj(relay, 1, 1).fanout, 'viewport')).toEqual(['1.1']); // old range unchanged
  });

  it('a REQUEST_UPDATE from a session with no active subscription → REQUEST_ERROR DOES_NOT_EXIST', () => {
    const relay = new MoqRelay();
    attachPub(relay);
    const { replies } = relay.onControl('ghost', encodeRequestUpdate({ requestId: 4n, forward: 1 }));
    expect(decodeRequestError(parseControl(replies[0].frame).payload).errorCode).toBe(MOQ_ERROR.DOES_NOT_EXIST);
  });
});
