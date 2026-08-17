import { describe, it, expect } from 'vitest';
import { MoqRelay } from '../src/moq-relay';
import {
  MOQ_OBJECT_STATUS,
  SUBGROUP_ID_MODE,
  decodeObject,
  encodeObject,
  encodeSubgroupStream,
  encodeSubscribe,
  encodePublishNamespace,
  type SubgroupHeader,
  type SubgroupObject,
} from '../src/moq-wire';

/**
 * Transport hookup: proves that SUBGROUP-HEADER frames arriving via `onObject` (the WS
 * WS_KIND=OBJECT path) are detected and routed to `onSubgroupFrame` when the scheduler is ON,
 * and silently dropped (same as today) when the scheduler is OFF.
 *
 * (a) scheduler ON  — subgroup frame via onObject → objects reach onDecodedObject with priority
 * (b) scheduler OFF — subgroup frame via onObject → empty fanout (byte-identical FIFO)
 */

const NS = ['wave', 'cam-1'];

function attach(relay: MoqRelay, subs: number): void {
  relay.onControl('pub', encodePublishNamespace({ requestId: 1n, trackNamespace: NS }));
  for (let i = 0; i < subs; i++) {
    relay.onControl(`s${i}`, encodeSubscribe({ requestId: BigInt(i + 2), trackNamespace: NS, trackName: 'v' }));
  }
}

function makeSubgroupFrame(
  groupId: bigint,
  priority: number,
  objects: Array<{ objectId: bigint; payload: Uint8Array }>,
  opts: { defaultPriority?: boolean; endOfGroup?: boolean } = {},
): Uint8Array {
  const hdr: SubgroupHeader = {
    trackAlias: 1n,
    groupId,
    subgroupId: 0n,
    idMode: SUBGROUP_ID_MODE.EXPLICIT,
    priority,
    defaultPriority: opts.defaultPriority ?? false,
    endOfGroup: opts.endOfGroup ?? false,
    firstObject: true,
  };
  const subObjs: SubgroupObject[] = objects.map((o) => ({
    objectId: o.objectId,
    status: MOQ_OBJECT_STATUS.NORMAL,
    payload: o.payload,
  }));
  return encodeSubgroupStream(hdr, subObjs);
}

// ─── (a) scheduler ON — subgroup via onObject reaches onDecodedObject with priority ───────────

describe('transport hookup: scheduler ON routes subgroup via onObject', () => {
  it('subgroup frame sent through onObject reaches onDecodedObject with priority', () => {
    const relay = new MoqRelay({ scheduler: true });
    attach(relay, 1);

    // Three subgroups arriving as onObject frames, each with a distinct priority.
    // Arrival order: obj0(p200), obj1(p100), obj2(p150)
    // Expected flush order (priority ascending): obj1(p100), obj2(p150), obj0(p200)
    const frame0 = makeSubgroupFrame(0n, 200, [{ objectId: 0n, payload: new Uint8Array([0]) }]);
    const frame1 = makeSubgroupFrame(0n, 100, [{ objectId: 1n, payload: new Uint8Array([1]) }]);
    const frame2 = makeSubgroupFrame(0n, 150, [{ objectId: 2n, payload: new Uint8Array([2]) }]);

    // Route through onObject — the transport hookup should detect subgroup type byte
    const r0 = relay.onObject('pub', frame0);
    expect(r0.fanout).toHaveLength(0); // buffered by scheduler

    const r1 = relay.onObject('pub', frame1);
    expect(r1.fanout).toHaveLength(0); // buffered

    const r2 = relay.onObject('pub', frame2);
    expect(r2.fanout).toHaveLength(0); // buffered (same group)

    // Flush the final group — scheduler sorts by priority ascending
    const flushed = relay.flush();
    const order = flushed.map((f) => Number(decodeObject(f.frame).objectId));
    expect(order).toEqual([1, 2, 0]); // priority ascending: 100, 150, 200
  });

  it('endOfGroup on the last subgroup frame flushes without an explicit relay.flush()', () => {
    const relay = new MoqRelay({ scheduler: true });
    attach(relay, 1);

    // Same group (0n), distinct priorities, END_OF_GROUP on the last frame —
    // the exact live-publisher pattern: multiple subgroups, one group.
    const frame0 = makeSubgroupFrame(0n, 200, [{ objectId: 0n, payload: new Uint8Array([0]) }]);
    const frame1 = makeSubgroupFrame(0n, 100, [{ objectId: 1n, payload: new Uint8Array([1]) }]);
    const frame2 = makeSubgroupFrame(0n, 150, [{ objectId: 2n, payload: new Uint8Array([2]) }], { endOfGroup: true });

    const r0 = relay.onObject('pub', frame0);
    expect(r0.fanout).toHaveLength(0); // buffered

    const r1 = relay.onObject('pub', frame1);
    expect(r1.fanout).toHaveLength(0); // buffered

    const r2 = relay.onObject('pub', frame2);
    const order = r2.fanout.map((f) => Number(decodeObject(f.frame).objectId));
    expect(order).toEqual([1, 2, 0]); // flushed at endOfGroup, priority ascending
  });

  it('subgroup frame routed via onObject preserves publisher gate', () => {
    const relay = new MoqRelay({ scheduler: true });
    attach(relay, 1);

    const frame = makeSubgroupFrame(0n, 100, [
      { objectId: 0n, payload: new Uint8Array([1]) },
    ]);

    // Non-publisher session should be rejected
    const r = relay.onObject('not-the-publisher', frame);
    expect(r.fanout).toHaveLength(0);
    expect(r.events).toHaveLength(0);

    // Publisher session should succeed
    const r2 = relay.onObject('pub', frame);
    // Buffered — scheduler is ON, no group boundary yet
    expect(r2.fanout).toHaveLength(0);
  });

  it('regular object frame still works through onObject when scheduler ON', () => {
    const relay = new MoqRelay({ scheduler: true });
    attach(relay, 1);

    // A regular OBJECT_DATAGRAM frame (not a subgroup)
    const objFrame = encodeObject({
      trackAlias: 1n,
      groupId: 0n,
      objectId: 0n,
      status: MOQ_OBJECT_STATUS.NORMAL,
      payload: new Uint8Array([42]),
    });

    // When scheduler is ON, a single object in a group is buffered until group boundary
    const r = relay.onObject('pub', objFrame);
    expect(r.fanout).toHaveLength(0); // buffered

    // Flush delivers it
    const flushed = relay.flush();
    expect(flushed).toHaveLength(1);
    const decoded = decodeObject(flushed[0].frame);
    expect(decoded.payload).toEqual(new Uint8Array([42]));
  });
});

// ─── (b) scheduler OFF — subgroup via onObject behaves as before (silent drop) ────────────────

describe('transport hookup: scheduler OFF drops subgroup via onObject', () => {
  it('subgroup frame sent through onObject → empty fanout (byte-identical FIFO)', () => {
    const relay = new MoqRelay(); // default: scheduler OFF
    attach(relay, 1);

    const frame = makeSubgroupFrame(0n, 100, [
      { objectId: 0n, payload: new Uint8Array([1]) },
      { objectId: 1n, payload: new Uint8Array([2]) },
    ]);

    // Subgroup frame via onObject — scheduler OFF → decodeObject fails → silent drop
    const r = relay.onObject('pub', frame);
    expect(r.fanout).toHaveLength(0);
    expect(r.events).toHaveLength(0);
  });

  it('regular object still fans out when scheduler OFF', () => {
    const relay = new MoqRelay(); // default: scheduler OFF
    attach(relay, 1);

    const objFrame = encodeObject({
      trackAlias: 1n,
      groupId: 0n,
      objectId: 0n,
      status: MOQ_OBJECT_STATUS.NORMAL,
      payload: new Uint8Array([42]),
    });

    const r = relay.onObject('pub', objFrame);
    expect(r.fanout).toHaveLength(1); // fanned out immediately (FIFO)
    const decoded = decodeObject(r.fanout[0].frame);
    expect(decoded.payload).toEqual(new Uint8Array([42]));
  });

  it('onSubgroupFrame directly is also a no-op when scheduler OFF', () => {
    const relay = new MoqRelay(); // default: scheduler OFF
    attach(relay, 1);

    const frame = makeSubgroupFrame(0n, 100, [
      { objectId: 0n, payload: new Uint8Array([1]) },
    ]);

    const r = relay.onSubgroupFrame(frame);
    expect(r.fanout).toHaveLength(0);
  });
});

// ─── (c) subgroup type byte detection — edge cases ───────────────────────────────────────────

describe('transport hookup: subgroup type byte detection edge cases', () => {
  it('malformed frame in onObject with scheduler ON falls through to decodeObject', () => {
    const relay = new MoqRelay({ scheduler: true });
    attach(relay, 1);

    // An empty frame — both subgroup detection and decodeObject will fail
    const r = relay.onObject('pub', new Uint8Array(0));
    expect(r.fanout).toHaveLength(0);
    expect(r.events).toHaveLength(0);
  });

  it('frame starting with non-subgroup varint goes through decodeObject path', () => {
    const relay = new MoqRelay({ scheduler: true });
    attach(relay, 1);

    // A valid OBJECT_DATAGRAM — trackAlias=1 starts with varint(1), which is NOT a subgroup type
    const objFrame = encodeObject({
      trackAlias: 1n,
      groupId: 99n,
      objectId: 0n,
      status: MOQ_OBJECT_STATUS.NORMAL,
      payload: new Uint8Array([7]),
    });

    const r = relay.onObject('pub', objFrame);
    // Buffered by scheduler (single object, no group boundary yet)
    expect(r.fanout).toHaveLength(0);

    const flushed = relay.flush();
    expect(flushed).toHaveLength(1);
    expect(decodeObject(flushed[0].frame).groupId).toBe(99n);
  });
});
