import { describe, it, expect } from 'vitest';
import { MoqRelay, SCHEDULER_MAX_BUFFER_MS } from '../src/moq-relay';
import {
  MOQ_OBJECT_STATUS,
  decodeObject,
  encodeSubscribe,
  encodePublishNamespace,
  type MoqObject,
} from '../src/moq-wire';

/**
 * #211: the deadline scheduler's ONLY flush triggers were a group boundary or a 64-object window
 * (SCHEDULER_WINDOW_OBJECTS), so a low-rate or single-group track's tail buffered forever — it was
 * only ever emitted by publish_end → flush(). These tests exercise the ADDITIONAL max-buffer-age
 * trigger added to close that gap, with an INJECTED clock (the `now` constructor option) so no real
 * timers are involved — the relay stays hermetically unit-testable per the module's design.
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

/** A mutable clock the test controls directly — the relay's `now` option reads it. */
function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('#211 max-buffer-age flush: default threshold', () => {
  it('exports a small, low-latency default (SCHEDULER_MAX_BUFFER_MS)', () => {
    expect(SCHEDULER_MAX_BUFFER_MS).toBeGreaterThan(0);
    expect(SCHEDULER_MAX_BUFFER_MS).toBeLessThanOrEqual(50);
  });
});

describe('#211 case (a): objects keep arriving — age is checked on each onDecodedObject', () => {
  it('flushes a partial group once the oldest buffered object ages past maxBufferAgeMs', () => {
    const c = clock();
    const relay = new MoqRelay({ scheduler: true, maxBufferAgeMs: 20, now: c.now });
    attach(relay, 1);

    // Two objects buffer (below the 64-object window, no group boundary yet — the two OLD triggers
    // never fire). Not yet stale → still buffered.
    let r = relay.onDecodedObject(obj(0n, 0n, 100));
    expect(r.fanout).toHaveLength(0);
    c.advance(5);
    r = relay.onDecodedObject(obj(0n, 1n, 100));
    expect(r.fanout).toHaveLength(0); // buffer is only 5ms old — not stale yet

    // Age the buffer past the 20ms threshold, then a THIRD object of the SAME group arrives.
    c.advance(20);
    r = relay.onDecodedObject(obj(0n, 2n, 100));

    // The stale buffer (objects 0, 1) is flushed as a UNIT; object 2 starts a fresh buffer.
    const flushedIds = r.fanout.map((f) => Number(decodeObject(f.frame).objectId));
    expect(flushedIds).toEqual([0, 1]);
    expect(relay.pendingBufferedAt).not.toBeNull(); // object 2 is now buffered, freshly timestamped
  });

  it('single never-ending group: prompt delivery without a group boundary (the #211 symptom)', () => {
    const c = clock();
    const relay = new MoqRelay({ scheduler: true, maxBufferAgeMs: 20, now: c.now });
    attach(relay, 1);

    const delivered: number[] = [];
    for (let o = 0; o < 5; o++) {
      const r = relay.onDecodedObject(obj(0n, BigInt(o), 100));
      for (const f of r.fanout) delivered.push(Number(decodeObject(f.frame).objectId));
      c.advance(25); // each object individually ages the buffer past threshold before the next arrives
    }

    // Every object was delivered promptly — none stranded waiting for a group boundary that (for a
    // single-group track) never comes. Fail-open: same set, no drop.
    expect(delivered.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]); // objects 0-3 flushed as each new one ages the prior buffer; object 4 is still pending
    expect(relay.pendingBufferedAt).not.toBeNull(); // the final object (4) is buffered awaiting its own flush
  });
});

describe('#211 case (b): a stalled stream — no new object arrives to trigger the age check', () => {
  it('flushStale() flushes the buffered tail once it ages past the threshold, using the timer/alarm path', () => {
    const c = clock();
    const relay = new MoqRelay({ scheduler: true, maxBufferAgeMs: 20, now: c.now });
    attach(relay, 2);

    relay.onDecodedObject(obj(0n, 0n, 100));
    relay.onDecodedObject(obj(0n, 1n, 100));

    // The stream stalls here — no further onDecodedObject calls. flushStale() is what a DO
    // alarm/timer armed off `pendingBufferedAt` would call.
    expect(relay.flushStale()).toHaveLength(0); // not yet stale (clock hasn't moved)

    c.advance(19);
    expect(relay.flushStale()).toHaveLength(0); // still just under the threshold

    c.advance(1); // now exactly at 20ms
    const flushed = relay.flushStale();
    // 2 objects fanned out to 2 subscribers each = 4 outbound frames, no drop/dup
    expect(flushed).toHaveLength(4);
    expect(new Set(flushed.map((f) => Number(decodeObject(f.frame).objectId)))).toEqual(new Set([0, 1]));
    // fanned out to BOTH subscribers, not just one
    expect(new Set(flushed.map((f) => f.to))).toEqual(new Set(['s0', 's1']));
    expect(relay.pendingBufferedAt).toBeNull(); // buffer drained

    // idempotent / safe to call again — nothing pending, no re-flush, no throw
    expect(relay.flushStale()).toHaveLength(0);
  });

  it('pendingBufferedAt exposes the timestamp a caller (the DO) arms its alarm from', () => {
    const c = clock(1000);
    const relay = new MoqRelay({ scheduler: true, maxBufferAgeMs: 20, now: c.now });
    attach(relay, 1);

    expect(relay.pendingBufferedAt).toBeNull(); // nothing buffered yet
    relay.onDecodedObject(obj(0n, 0n, 100));
    expect(relay.pendingBufferedAt).toBe(1000); // stamped from the clock at buffer start
  });
});

describe('#211: ordering is preserved — a time-based flush emits the buffer as a WHOLE unit, sorted', () => {
  it('flushStale() sorts the aged buffer by (priority, deadline), same as every other flush trigger', () => {
    const c = clock();
    const relay = new MoqRelay({ scheduler: true, maxBufferAgeMs: 20, now: c.now });
    attach(relay, 1);

    // Arrival order deliberately unsorted.
    relay.onDecodedObject(obj(0n, 0n, 200, 500)); // lowest priority
    relay.onDecodedObject(obj(0n, 1n, 100, 300));
    relay.onDecodedObject(obj(0n, 2n, 100, 100)); // same priority as 1, earlier deadline → before it
    relay.onDecodedObject(obj(0n, 3n, 150, 400));

    c.advance(20);
    const order = relay.flushStale().map((f) => Number(decodeObject(f.frame).objectId));
    expect(order).toEqual([2, 1, 3, 0]); // (priority asc, deadline asc) — identical ordering rule as flush()
    expect(new Set(order)).toEqual(new Set([0, 1, 2, 3])); // no drop, no dup
  });

  it('multi-group scenario: a time-flushed group never mixes with the next group (whole-group ordering, E2-fix invariant)', () => {
    const c = clock();
    const relay = new MoqRelay({ scheduler: true, maxBufferAgeMs: 20, now: c.now });
    attach(relay, 1);

    // Group 0: two objects, deliberately unsorted by priority.
    relay.onDecodedObject(obj(0n, 0n, 200));
    relay.onDecodedObject(obj(0n, 1n, 50));
    c.advance(20); // group 0's buffer is now stale

    // Group 1 begins — the group-boundary trigger flushes group 0 (sorted) BEFORE group 1 buffers.
    const r1 = relay.onDecodedObject(obj(1n, 0n, 10));
    const group0Order = r1.fanout.map((f) => Number(decodeObject(f.frame).objectId));
    expect(group0Order).toEqual([1, 0]); // sorted: priority 50 before 200 — group 0 only, nothing from group 1

    relay.onDecodedObject(obj(1n, 1n, 5));
    c.advance(20); // group 1's buffer is also now stale
    const tail = relay.flushStale();
    const group1Order = tail.map((f) => Number(decodeObject(f.frame).objectId));
    expect(group1Order).toEqual([1, 0]); // group 1 sorted on its own — never mixed with group 0's frames
  });
});

describe('#211: group-boundary and 64-object window triggers are unchanged (regression)', () => {
  it('group boundary still flushes the previous group immediately, independent of buffer age', () => {
    const c = clock();
    const relay = new MoqRelay({ scheduler: true, maxBufferAgeMs: 1000, now: c.now }); // huge threshold — age can't be why this flushes
    attach(relay, 1);

    relay.onDecodedObject(obj(0n, 0n, 200));
    relay.onDecodedObject(obj(0n, 1n, 100));
    const r = relay.onDecodedObject(obj(1n, 0n, 50)); // group boundary — no time has passed
    expect(r.fanout.map((f) => Number(decodeObject(f.frame).objectId))).toEqual([1, 0]);
  });

  it('the 64-object window still forces a flush within a single never-ending group, independent of buffer age', () => {
    const c = clock();
    const relay = new MoqRelay({ scheduler: true, maxBufferAgeMs: 1000, now: c.now }); // huge threshold
    attach(relay, 1);

    let flushedAt = -1;
    for (let o = 0; o < 64; o++) {
      const r = relay.onDecodedObject(obj(0n, BigInt(o), 100));
      if (r.fanout.length > 0) flushedAt = o;
    }
    expect(flushedAt).toBe(63); // the 64th object (index 63) trips the window, not buffer age
  });
});

describe('#211: scheduler OFF is byte-identical to before this fix (no time-based behavior at all)', () => {
  it('ignores maxBufferAgeMs / now entirely — immediate FIFO fan-out, ignoring the injected clock', () => {
    const c = clock();
    const relay = new MoqRelay({ scheduler: false, maxBufferAgeMs: 1, now: c.now }); // 1ms threshold, if it mattered
    attach(relay, 1);

    const { fanout } = relay.onDecodedObject(obj(0n, 0n, 100));
    expect(fanout).toHaveLength(1); // delivered immediately — no buffering at all
    expect(relay.pendingBufferedAt).toBeNull();
    expect(relay.flushStale()).toHaveLength(0); // flushStale() is a no-op when scheduler is OFF
    expect(relay.flush()).toHaveLength(0);
  });

  it('default relay (no scheduler option) behaves identically regardless of clock/threshold options', () => {
    const relay = new MoqRelay();
    attach(relay, 1);
    const { fanout } = relay.onDecodedObject(obj(0n, 0n, 100));
    expect(fanout).toHaveLength(1);
  });
});
