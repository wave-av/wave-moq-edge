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
