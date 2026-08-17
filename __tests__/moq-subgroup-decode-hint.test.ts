import { describe, it, expect } from 'vitest';
import { MoqRelay } from '../src/moq-relay';
import {
  MOQ_OBJECT_STATUS,
  SUBGROUP_ID_MODE,
  encodeObject,
  decodeObject,
  encodeSubgroupStream,
  decodeSubgroupStream,
  encodeSubscribe,
  encodePublishNamespace,
  type SubgroupHeader,
  type SubgroupObject,
} from '../src/moq-wire';

/**
 * E3 prerequisite: subgroup-decode → scheduler hint path. Exercises the new `onSubgroupFrame`
 * method that decodes a SUBGROUP_HEADER frame, converts each SubgroupObject to a MoqObject
 * (stamping the header's priority), and routes through `onDecodedObject` for the E1 scheduler.
 *
 * Four receipts:
 *   (a) priority byte round-trips from SubgroupHeader → SubgroupObject via decodeSubgroupStream
 *   (b) defaultPriority=true leaves SubgroupObject.priority undefined
 *   (c) scheduler-enabled relay reorders a group fed through onSubgroupFrame
 *   (d) baseline decodeObject keys remain unchanged (regression gate)
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

// ─── (a) priority byte decodes into SubgroupHeader AND stamps onto SubgroupObject ────────────────

describe('subgroup decode: priority stamps onto SubgroupObject', () => {
  it('priority from header appears on every decoded SubgroupObject', () => {
    const frame = makeSubgroupFrame(7n, 200, [
      { objectId: 0n, payload: new Uint8Array([1, 2]) },
      { objectId: 1n, payload: new Uint8Array([3, 4]) },
    ]);
    const { header, objects } = decodeSubgroupStream(frame);
    expect(header.priority).toBe(200);
    expect(header.defaultPriority).toBe(false);
    expect(objects).toHaveLength(2);
    for (const o of objects) {
      expect(o.priority).toBe(200);
    }
  });

  it('different priority values stamp correctly', () => {
    for (const p of [0, 50, 128, 255]) {
      const frame = makeSubgroupFrame(1n, p, [{ objectId: 0n, payload: new Uint8Array([9]) }]);
      const { objects } = decodeSubgroupStream(frame);
      expect(objects[0].priority).toBe(p);
    }
  });
});

// ─── (b) defaultPriority path leaves priority undefined ────────────────────────────────────────

describe('subgroup decode: defaultPriority leaves SubgroupObject.priority undefined', () => {
  it('defaultPriority=true → SubgroupObject.priority is undefined', () => {
    const frame = makeSubgroupFrame(1n, 0, [
      { objectId: 0n, payload: new Uint8Array([1]) },
      { objectId: 1n, payload: new Uint8Array([2]) },
    ], { defaultPriority: true });
    const { header, objects } = decodeSubgroupStream(frame);
    expect(header.defaultPriority).toBe(true);
    // priority field is 0 when defaultPriority is set (wire form omits the byte)
    // but SubgroupObject.priority should be undefined since the header has no explicit priority
    expect(objects[0].priority).toBeUndefined();
    expect(objects[1].priority).toBeUndefined();
  });

  it('round-trip: encodeSubgroupStream with defaultPriority → decode yields no priority on objects', () => {
    const hdr: SubgroupHeader = {
      trackAlias: 1n,
      groupId: 5n,
      subgroupId: 2n,
      idMode: SUBGROUP_ID_MODE.EXPLICIT,
      priority: 0, // ignored when defaultPriority is true
      defaultPriority: true,
      endOfGroup: false,
      firstObject: true,
    };
    const subObjs: SubgroupObject[] = [
      { objectId: 0n, status: MOQ_OBJECT_STATUS.NORMAL, payload: new Uint8Array([10, 20]) },
      { objectId: 1n, status: MOQ_OBJECT_STATUS.NORMAL, payload: new Uint8Array([30]) },
    ];
    const { objects } = decodeSubgroupStream(encodeSubgroupStream(hdr, subObjs));
    for (const o of objects) {
      expect(o.priority).toBeUndefined();
    }
  });
});

// ─── (c) scheduler-enabled relay reorders via onSubgroupFrame ──────────────────────────────────

describe('onSubgroupFrame: scheduler-enabled relay reorders by priority', () => {
  it('feeds subgroup objects through onDecodedObject with priority, relay reorders', () => {
    const relay = new MoqRelay({ scheduler: true });
    attach(relay, 1);

    // We need to build a frame with explicit per-object priorities.
    // The standard makeSubgroupFrame stamps the SAME priority on all objects.
    // Instead, build the subgroup manually with header priority=0 and override per-object:
    // Actually, we need to build objects with DIFFERENT priorities. Since priority is per-HEADER
    // (not per-object in the subgroup wire form), we need three separate subgroups to test
    // per-object priority differentiation. But the E1 scheduler operates on MoqObject.priority,
    // so we can inject three objects with different priorities via three separate onSubgroupFrame
    // calls with different headers (each carrying one object with a distinct priority).

    const frame0 = makeSubgroupFrame(0n, 200, [{ objectId: 0n, payload: new Uint8Array([0]) }]);
    const frame1 = makeSubgroupFrame(0n, 100, [{ objectId: 1n, payload: new Uint8Array([1]) }]);
    const frame2 = makeSubgroupFrame(0n, 150, [{ objectId: 2n, payload: new Uint8Array([2]) }]);

    // All three arrive in arrival order: obj0(p200), obj1(p100), obj2(p150)
    // Scheduler sorts by priority ascending: obj1(p100) → obj2(p150) → obj0(p200)
    const r0 = relay.onSubgroupFrame(frame0);
    expect(r0.fanout).toHaveLength(0); // buffered

    const r1 = relay.onSubgroupFrame(frame1);
    expect(r1.fanout).toHaveLength(0); // buffered

    const r2 = relay.onSubgroupFrame(frame2);
    expect(r2.fanout).toHaveLength(0); // buffered (same group)

    // Flush the final group
    const flushed = relay.flush();
    const order = flushed.map((f) => Number(decodeObject(f.frame).objectId));
    expect(order).toEqual([1, 2, 0]); // priority ascending: 100, 150, 200
    expect(new Set(order)).toEqual(new Set([0, 1, 2])); // same set, no drop
  });

  it('scheduler OFF → onSubgroupFrame is a no-op (byte-identical FIFO preserved)', () => {
    const relay = new MoqRelay(); // default OFF
    attach(relay, 1);

    const frame = makeSubgroupFrame(0n, 100, [
      { objectId: 0n, payload: new Uint8Array([1]) },
      { objectId: 1n, payload: new Uint8Array([2]) },
    ]);

    const { fanout } = relay.onSubgroupFrame(frame);
    expect(fanout).toHaveLength(0); // no-op when scheduler is OFF
  });

  it('defaultPriority subgroup → objects have no priority, scheduler falls back to arrival order', () => {
    const relay = new MoqRelay({ scheduler: true });
    attach(relay, 1);

    // Two separate subgroups with defaultPriority=true → priority undefined on all objects
    const frame0 = makeSubgroupFrame(0n, 0, [{ objectId: 0n, payload: new Uint8Array([0]) }], { defaultPriority: true });
    const frame1 = makeSubgroupFrame(0n, 0, [{ objectId: 1n, payload: new Uint8Array([1]) }], { defaultPriority: true });

    relay.onSubgroupFrame(frame0);
    relay.onSubgroupFrame(frame1);

    const flushed = relay.flush();
    const order = flushed.map((f) => Number(decodeObject(f.frame).objectId));
    // All unknown priority → fail-open arrival order
    expect(order).toEqual([0, 1]);
  });

  it('auto-flushes previous group when a new group begins via onSubgroupFrame', () => {
    const relay = new MoqRelay({ scheduler: true });
    attach(relay, 1);

    // Group 0: objects with priorities 200, 100
    relay.onSubgroupFrame(makeSubgroupFrame(0n, 200, [{ objectId: 0n, payload: new Uint8Array([0]) }]));
    relay.onSubgroupFrame(makeSubgroupFrame(0n, 100, [{ objectId: 1n, payload: new Uint8Array([1]) }]));

    // Group 1: first object → triggers flush of group 0 in priority order
    const r = relay.onSubgroupFrame(makeSubgroupFrame(1n, 50, [{ objectId: 0n, payload: new Uint8Array([2]) }]));

    // Group 0 flushed sorted: obj1(p100) before obj0(p200)
    const flushedIds = r.fanout.map((f) => Number(decodeObject(f.frame).objectId));
    expect(flushedIds).toEqual([1, 0]);

    // Group 1 is buffered
    const tail = relay.flush();
    expect(tail).toHaveLength(1);
    expect(Number(decodeObject(tail[0].frame).objectId)).toBe(0);
  });
});

// ─── (d) baseline: decodeObject keys unchanged (regression gate) ───────────────────────────────

describe('baseline: decodeObject keys remain unchanged', () => {
  it('decodeObject returns exactly { trackAlias, groupId, objectId, status, payload } with no extra keys', () => {
    const frame = encodeObject({
      trackAlias: 42n,
      groupId: 7n,
      objectId: 3n,
      status: MOQ_OBJECT_STATUS.NORMAL,
      payload: new Uint8Array([10, 20, 30]),
    });
    const decoded = decodeObject(frame) as unknown as Record<string, unknown>;
    expect(Object.keys(decoded)).toEqual(['trackAlias', 'groupId', 'objectId', 'status', 'payload']);
    expect(decoded.trackAlias).toBe(42n);
    expect(decoded.groupId).toBe(7n);
    expect(decoded.objectId).toBe(3n);
    expect(decoded.status).toBe(MOQ_OBJECT_STATUS.NORMAL);
    expect(Array.from(decoded.payload as Uint8Array)).toEqual([10, 20, 30]);
  });

  it('decodeObject with properties still returns only the standard keys (properties is set)', () => {
    const frame = encodeObject({
      trackAlias: 1n,
      groupId: 0n,
      objectId: 0n,
      status: MOQ_OBJECT_STATUS.NORMAL,
      payload: new Uint8Array([1]),
      properties: new Uint8Array([0xaa, 0xbb]),
    });
    const decoded = decodeObject(frame) as unknown as Record<string, unknown>;
    // properties is present in the decoded output
    expect(Object.keys(decoded)).toEqual(['trackAlias', 'groupId', 'objectId', 'status', 'payload', 'properties']);
    expect(decoded.properties).toBeInstanceOf(Uint8Array);
  });
});
