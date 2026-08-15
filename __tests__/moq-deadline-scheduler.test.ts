import { describe, it, expect } from 'vitest';
import { MoqRelay } from '../src/moq-relay';
import { orderByDeadline } from '../src/moq-scheduler';
import {
  MOQ_OBJECT_STATUS,
  encodeObject,
  decodeObject,
  encodeSubscribe,
  encodePublishNamespace,
  type MoqObject,
} from '../src/moq-wire';

/**
 * E1 deadline-aware priority scheduler — unit + integration receipts.
 *
 * The scheduler orders a group's objects by (priority, playout-deadline) behind a flag that is OFF by
 * default. Three guarantees under test:
 *   1. flag OFF → byte-identical FIFO (no buffering, no reorder, no drop; flush() is a no-op).
 *   2. flag ON  → groups are emitted in (priority, deadline) order with the SAME set delivered (no drop).
 *   3. fail-open → an unknown/missing priority or deadline falls back to arrival order, never drops a group.
 *
 * Because the OBJECT_DATAGRAM wire form carries no priority/deadline, `onObject` (the wire entry point)
 * never sees them; the scheduler consumes them ONLY when present on a decoded `MoqObject` — injected by
 * `onDecodedObject` (a future subgroup-decode path) or by these tests.
 */

const NS = ['wave', 'cam-1'];

function attach(relay: MoqRelay, subs: number): void {
  relay.onControl('pub', encodePublishNamespace({ requestId: 1n, trackNamespace: NS }));
  for (let i = 0; i < subs; i++) {
    relay.onControl(`s${i}`, encodeSubscribe({ requestId: BigInt(i + 2), trackNamespace: NS, trackName: 'v' }));
  }
}

function obj(group: bigint, object: bigint, priority?: number, deadlineMs?: number): MoqObject {
  return {
    trackAlias: 99n,
    groupId: group,
    objectId: object,
    status: MOQ_OBJECT_STATUS.NORMAL,
    payload: new Uint8Array([Number(group), Number(object)]),
    ...(priority !== undefined ? { priority } : {}),
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
  };
}

describe('orderByDeadline (pure ordering kernel)', () => {
  it('orders by priority (LOWER = higher priority first), stable, no drop', () => {
    const items = [
      { id: 'a', priority: 200 },
      { id: 'b', priority: 100 },
      { id: 'c', priority: 150 },
    ];
    expect(orderByDeadline(items).map((x) => x.id)).toEqual(['b', 'c', 'a']);
    // same set, no drop / no dup
    expect(new Set(orderByDeadline(items).map((x) => x.id))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('breaks priority ties by earlier deadline first', () => {
    const items = [
      { id: 'a', priority: 100, deadlineMs: 900 },
      { id: 'b', priority: 100, deadlineMs: 300 },
      { id: 'c', priority: 100, deadlineMs: 600 },
    ];
    expect(orderByDeadline(items).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('orders by deadline alone when priority is absent everywhere', () => {
    const items = [
      { id: 'a', deadlineMs: 800 },
      { id: 'b', deadlineMs: 100 },
      { id: 'c', deadlineMs: 400 },
    ];
    expect(orderByDeadline(items).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('missing priority or deadline sorts LAST within its tier (fail-open, never dropped)', () => {
    const items = [
      { id: 'high-no-deadline', priority: 50 }, // highest priority, but NO deadline → still first (priority dominates)
      { id: 'mid', priority: 100, deadlineMs: 500 },
      { id: 'low', priority: 200, deadlineMs: 100 }, // lower priority despite EARLIER deadline → priority wins
      { id: 'no-prio', deadlineMs: 100 }, // no priority → last tier
      { id: 'neither' }, // nothing → last tier, after no-prio (missing deadline sorts last within tier)
    ];
    // lexicographic (priority, then deadline): 50, 100, 200, then undefined-priority tier (no-prio, neither)
    expect(orderByDeadline(items).map((x) => x.id)).toEqual(['high-no-deadline', 'mid', 'low', 'no-prio', 'neither']);
    expect(orderByDeadline(items)).toHaveLength(5); // nothing dropped
  });

  it('is stable for equal keys (equal priority + deadline keep arrival order)', () => {
    const items = [
      { id: 'x', priority: 7, deadlineMs: 1 },
      { id: 'y', priority: 7, deadlineMs: 1 },
      { id: 'z', priority: 7, deadlineMs: 1 },
    ];
    expect(orderByDeadline(items).map((x) => x.id)).toEqual(['x', 'y', 'z']);
  });

  it('does not mutate its input', () => {
    const items = [{ id: 'b', priority: 100 }, { id: 'a', priority: 50 }];
    const snapshot = items.map((x) => x.id);
    orderByDeadline(items);
    expect(items.map((x) => x.id)).toEqual(snapshot);
  });
});

describe('E1 scheduler: flag OFF = byte-identical FIFO', () => {
  it('flush() is a no-op when the scheduler is off', () => {
    const relay = new MoqRelay(); // default = OFF
    attach(relay, 1);
    relay.onObject('pub', encodeObject({ trackAlias: 99n, groupId: 0n, objectId: 0n, status: 0, payload: new Uint8Array([1]) }));
    expect(relay.flush()).toHaveLength(0);
    const explicitOff = new MoqRelay({ scheduler: false });
    expect(explicitOff.flush()).toHaveLength(0);
  });

  it('fans out immediately (no buffering) with byte-identical re-stamped frames', () => {
    const relay = new MoqRelay({ scheduler: false });
    attach(relay, 2);

    const frame = encodeObject({ trackAlias: 99n, groupId: 0n, objectId: 0n, status: 0, payload: new Uint8Array([1, 2, 3]) });
    const { fanout } = relay.onObject('pub', frame);

    // delivered on the very first call — no buffering — to every subscriber
    expect(fanout.map((f) => f.to).sort()).toEqual(['s0', 's1']);
    // byte-identical to the pre-E1 forward contract: re-stamp trackAlias → 1, nothing else changes
    const expected = encodeObject({ trackAlias: 1n, groupId: 0n, objectId: 0n, status: 0, payload: new Uint8Array([1, 2, 3]) });
    for (const f of fanout) expect(Array.from(f.frame)).toEqual(Array.from(expected));
  });

  it('preserves the FIFO delivery == arrival order contract (no reorder/drop) when off', () => {
    const relay = new MoqRelay({ scheduler: false });
    attach(relay, 1);
    const received: number[] = [];
    for (let g = 0; g < 3; g++) {
      for (let o = 0; o < 4; o++) {
        const { fanout } = relay.onObject('pub', encodeObject({ trackAlias: 99n, groupId: BigInt(g), objectId: BigInt(o), status: 0, payload: new Uint8Array([g, o]) }));
        for (const f of fanout) received.push(Number(decodeObject(f.frame).objectId));
      }
    }
    // arrival order within each group, and no object dropped
    expect(received).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
  });
});

describe('E1 scheduler: flag ON reorders by (priority, deadline), same set, no drop', () => {
  it('emits a group in (priority, deadline) order on flush(), same set delivered', () => {
    const relay = new MoqRelay({ scheduler: true });
    attach(relay, 1);

    // arrival order deliberately NOT sorted; (priority, deadline) sorts to b, c, a, d
    const inputs: MoqObject[] = [
      obj(0n, 0n, 200, 500), // 'a' lowest priority
      obj(0n, 1n, 100, 300), // 'b'
      obj(0n, 2n, 100, 100), // 'c' same priority as b, earlier deadline → before b
      obj(0n, 3n, 150, 400), // 'd'
    ];
    for (const o of inputs) {
      const r = relay.onDecodedObject(o);
      expect(r.fanout).toHaveLength(0); // buffered, not yet emitted
    }

    const flushed = relay.flush();
    const order = flushed.map((f) => Number(decodeObject(f.frame).objectId));
    expect(order).toEqual([2, 1, 3, 0]); // (priority asc, then deadline asc)

    // SAME set delivered — no drop, no dup
    expect(new Set(order)).toEqual(new Set([0, 1, 2, 3]));
    expect(flushed).toHaveLength(4);
  });

  it('auto-flushes the previous group in sorted order when the next group begins', () => {
    const relay = new MoqRelay({ scheduler: true });
    attach(relay, 1);

    relay.onDecodedObject(obj(0n, 0n, 200));
    relay.onDecodedObject(obj(0n, 1n, 100));
    // first object of group 1 triggers the flush of group 0
    const r = relay.onDecodedObject(obj(1n, 0n, 50));

    // group 0 flushed now (sorted), group 1's object is buffered
    expect(r.fanout.map((f) => Number(decodeObject(f.frame).objectId))).toEqual([1, 0]);

    const tail = relay.flush();
    expect(tail.map((f) => Number(decodeObject(f.frame).objectId))).toEqual([0]);
  });

  it('fail-open: live wire frames (no priority/deadline) are all delivered in arrival order', () => {
    // The OBJECT_DATAGRAM form carries no priority/deadline, so a real onObject() path is
    // entirely fail-open: every object is delivered, in arrival order, none dropped.
    const relay = new MoqRelay({ scheduler: true });
    attach(relay, 1);

    const delivered: number[] = [];
    for (let o = 0; o < 6; o++) {
      const { fanout } = relay.onObject('pub', encodeObject({ trackAlias: 99n, groupId: 0n, objectId: BigInt(o), status: 0, payload: new Uint8Array([o]) }));
      for (const f of fanout) delivered.push(Number(decodeObject(f.frame).objectId));
    }
    for (const f of relay.flush()) delivered.push(Number(decodeObject(f.frame).objectId));

    expect(delivered).toEqual([0, 1, 2, 3, 4, 5]); // arrival order, full set
  });

  it('mixed known/unknown hints: known sorts first, unknown falls back to arrival order (no drop)', () => {
    const relay = new MoqRelay({ scheduler: true });
    attach(relay, 1);

    const inputs: MoqObject[] = [
      obj(0n, 0n, 100, 500), // known
      obj(0n, 1n), // no hint → arrival order (last)
      obj(0n, 2n, 50, 200), // known, higher priority → first
      obj(0n, 3n), // no hint → arrival order (last, after obj 1)
    ];
    for (const o of inputs) relay.onDecodedObject(o);

    const order = relay.flush().map((f) => Number(decodeObject(f.frame).objectId));
    expect(order).toEqual([2, 0, 1, 3]); // known sorted first (2 then 0), unknown in arrival order (1 then 3)
    expect(new Set(order)).toEqual(new Set([0, 1, 2, 3]));
  });
});
