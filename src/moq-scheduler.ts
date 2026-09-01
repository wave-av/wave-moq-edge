/**
 * E1 deadline-aware priority scheduling — PURE ordering kernel (no I/O, no relay state).
 *
 * The MoQ wire already ships a priority byte (SubgroupHeader.priority, 0-255, LOWER = HIGHER —
 * draft-18 §subgroup-header) but it is dead on the relay's OBJECT_DATAGRAM forward path: the
 * datagram form has no priority field, so a decoded MoqObject carries priority/deadline ONLY as
 * optional non-wire hints (MoqObject.priority / MoqObject.deadlineMs) injected by a future
 * subgroup-decode path or by tests. This module is the ordering rule: given a group's objects
 * (each with OPTIONAL hints), return the SAME objects in (priority, playout-deadline) order —
 * fail-open, never dropping or duplicating an object.
 *
 * E2-fix: the scheduler now exposes `earliestDeadline` so the relay can make deadline-driven
 * flush decisions without holding objects until the next group boundary.
 *
 * E3-fix (#211): mid-group deadline-pressure flushing was tried and REJECTED here (E2-fix) — it
 * breaks whole-group priority ordering. But the relay's ONLY flush triggers were a group boundary
 * or a 64-object window (see moq-relay.ts SCHEDULER_WINDOW_OBJECTS), so a low-rate or single-group
 * track that never trips either one buffers its tail forever. `PendingGroupBuffer` adds a bounded
 * max-buffer-age as a THIRD, additional trigger: the buffer is still always flushed as a WHOLE unit,
 * in (priority, deadline) order — never a partial/mid-group flush — so the E2-fix ordering guarantee
 * holds. It is pure state (no wall-clock reads; the caller supplies `now`) so it stays hermetically
 * testable with an injected clock, same as `orderByDeadline`.
 *
 * #212 E2 CONFORMANCE NOTE (draft-19 #1762: a relay MAY NOT reorder or drop objects, vs. this
 * module's own (priority, deadline) reordering): the tension is resolved by SCOPE, not by removing
 * the reorder. `orderByDeadline` only ever reorders objects that belong to the SAME group — the
 * caller (`moq-relay.ts` `schedule()`) flushes `PendingGroupBuffer` on every group-boundary crossing
 * BEFORE buffering the next group's first object (`boundaryCrossed` check), so a `PendingGroupBuffer`
 * instance NEVER holds objects from more than one group at once (see `groupId` getter — it is a
 * single value, not a set). `drain()` therefore always emits one whole group, reordered internally
 * by (priority, deadline), with NO possibility of a cross-group reorder and NO possibility of a drop
 * (every pushed item is returned by `drain()` — see `orderByDeadline`'s "no drop, no dup" contract).
 * This is documented here as "subgroup-priority scheduling, not object drop/reorder across the
 * subscription": #1762 governs cross-group/cross-subscription ordering and delivery, which this
 * module never touches; within-group reordering by priority is the SUBGROUP_HEADER's own documented
 * mechanism (multiple subgroups of one group MAY be delivered in any order — draft-18/-19/-20
 * §subgroup-header — the scheduler is choosing among already-permitted orderings, not inventing a
 * new one). See `__tests__/moq-relay.test.ts` "#212 E2 forwarding conformance" for the assertion
 * that a multi-group publish sequence is forwarded/cached in group-arrival order with the scheduler
 * ON, i.e. no cross-group reorder and no drop.
 */

/** The subset of scheduling fields an orderable item must expose (see MoqObject). */
export interface ScheduledItem {
  /** 0-255; LOWER value = HIGHER priority (draft-18 SubgroupHeader.priority semantics). */
  priority?: number;
  /** Playout deadline (epoch ms) — the instant the object must reach the player's jitter buffer. */
  deadlineMs?: number;
}

/**
 * Order `items` by (priority, then deadline), stable. An item missing its priority or deadline is
 * treated as the LOWEST scheduling priority and sorted to the back in arrival order — the fail-open
 * guarantee: an unknown deadline never drops or reorders an object ahead of a known one, it just
 * falls back to arrival order. Returns a NEW array; the input is unchanged (no drop, no dup).
 */
export function orderByDeadline<T extends ScheduledItem>(items: readonly T[]): T[] {
  const indexed = items.map((item, arrival) => ({ item, arrival }));
  indexed.sort((a, b) => {
    const p = cmpOptional(a.item.priority, b.item.priority); // LOWER value sorts first (higher priority)
    if (p !== 0) return p;
    const d = cmpOptional(a.item.deadlineMs, b.item.deadlineMs); // EARLIER deadline sorts first
    if (d !== 0) return d;
    return a.arrival - b.arrival; // stable: equal keys keep arrival order
  });
  return indexed.map((x) => x.item);
}

/** Compare two optional numbers: a defined value sorts BEFORE undefined; equal → 0. */
function cmpOptional(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1; // undefined = unknown → sort last (fail-open)
  if (b === undefined) return -1;
  return a - b;
}

/**
 * Compute the earliest deadline among a group of scheduled items.
 * Returns `undefined` if all items have undefined deadlines.
 */
export function earliestDeadline<T extends ScheduledItem>(items: readonly T[]): number | undefined {
  let min: number | undefined;
  for (const it of items) {
    if (it.deadlineMs !== undefined && (min === undefined || it.deadlineMs < min)) {
      min = it.deadlineMs;
    }
  }
  return min;
}

/** Default max-buffer-age (ms) before a pending group/window is flushed regardless of size (#211). */
export const SCHEDULER_MAX_BUFFER_MS = 30;

/** The subset of fields `PendingGroupBuffer` needs to know an item's group (see moq-relay.PendingObject). */
export interface BufferedItem extends ScheduledItem {
  groupId: bigint;
}

/**
 * The E1/E3 pending-group buffer: holds one group's (or one reordering window's) worth of items,
 * remembers when the FIRST item was buffered, and reports staleness against a caller-supplied clock.
 * Pure — no timers, no wall-clock reads — so time-based flush is exercised in tests with a plain
 * counter as `now`. `drain()` always returns the WHOLE buffer in (priority, deadline) order, matching
 * every other flush trigger (group boundary, window, time) — never a partial/out-of-order emission.
 */
export class PendingGroupBuffer<T extends BufferedItem> {
  private items: T[] = [];
  private bufferedAt: number | null = null;

  /** Number of items currently buffered. */
  get length(): number {
    return this.items.length;
  }
  /** The group ID of the buffered items (they are always all the same group), or null if empty. */
  get groupId(): bigint | null {
    return this.items.length > 0 ? this.items[0].groupId : null;
  }
  /** The clock reading (per the caller's `now`) at which the FIRST item was buffered, or null if empty. */
  get bufferedSince(): number | null {
    return this.bufferedAt;
  }

  /** Buffer one item, stamping the buffer's start time from the first item added. */
  push(item: T, now: number): void {
    if (this.items.length === 0) this.bufferedAt = now;
    this.items.push(item);
  }

  /** Whether the buffer is non-empty and has been open at least `maxAgeMs` as of `now`. */
  isStale(now: number, maxAgeMs: number): boolean {
    return this.bufferedAt !== null && now - this.bufferedAt >= maxAgeMs;
  }

  /** Drain and return the buffer's contents in (priority, deadline) order; resets to empty. */
  drain(): T[] {
    if (this.items.length === 0) return [];
    const ordered = orderByDeadline(this.items);
    this.items = [];
    this.bufferedAt = null;
    return ordered;
  }
}
