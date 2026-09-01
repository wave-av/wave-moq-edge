/**
 * MoQ relay LOCATION_FILTER resolution + per-viewport delivery handlers (#212 E5/E6). Split out of
 * `moq-relay.ts` (#212 file-size follow-up, epic #212) once that module crossed the repo's
 * file-size gate — this is the cohesive "LOCATION_FILTER" concern SUBSCRIBE/FETCH/REQUEST_UPDATE all
 * share, mirroring the wire-side split of the same era (`moq-wire-subscribe.ts`, `moq-wire-fetch.ts`,
 * `moq-wire-request-update.ts` each carry the codec half; this file carries the relay-side range
 * resolution + FETCH/REQUEST_UPDATE handling that consumes it).
 *
 * `handleFetch`/`handleRequestUpdate` are pure extractions of `MoqRelay`'s former private
 * `onFetch`/`onRequestUpdate` methods: same logic, parameterized with the relay's `cache` array /
 * `subscribers` map instead of reading `this.cache`/`this.subscribers` — since both are reference
 * types (array / Map), mutations made here are visible to the caller identically to when the code
 * lived inline in the class, so this is a pure move with NO behavior change. `moq-relay.ts` keeps
 * the thin call sites (`handleFetch(this.cache, ...)` / `handleRequestUpdate(this.subscribers, ...)`)
 * in its `onControl` switch.
 */
import { decodeFetch, decodeRequestUpdate, encodeFetchOk, encodeRequestError, encodeRequestOk, MOQ_ERROR, type LocationFilter } from './moq-wire.ts';
import type { CachedGroup, Outbound, ResolvedRange, Subscriber } from './moq-relay-types.ts';

/**
 * Resolve a decoded LOCATION_FILTER (#212 E5, §location-filters) into either an ABSOLUTE
 * `ResolvedRange` (or `undefined` for "no filter" / unfiltered) or a `{ relative: true }` marker for
 * the two forms this bounded-cache relay does not resolve: a lone StartGroup, or
 * StartGroup=StartObject=0 (both defined relative to `Largest Object`, which this relay does not track
 * independently of the last-N-groups cache it retains). Shared by `handleFetch` and `moq-relay.ts`'s
 * SUBSCRIBE/REQUEST_UPDATE handlers — the resolution rules are identical for every message type
 * (§location-filters applies the same positional-field semantics to FETCH, SUBSCRIBE, and
 * REQUEST_UPDATE Location filters).
 */
export function resolveLocationFilter(f: LocationFilter | undefined): { relative: true } | { relative: false; range?: ResolvedRange } {
  if (f === undefined || f.startGroup === undefined) return { relative: false, range: undefined };
  const isRelative = f.startObject === undefined || (f.startGroup === 0n && f.startObject === 0n && f.endGroupDelta === undefined);
  if (isRelative) return { relative: true };
  const start = { group: f.startGroup, object: f.startObject! };
  let end: { group: bigint; object: bigint } | undefined;
  let endGroupOpen = false;
  if (f.endGroupDelta !== undefined) {
    end = { group: f.startGroup + f.endGroupDelta, object: f.endObject ?? 0n };
    endGroupOpen = f.endObject === undefined;
  }
  return { relative: false, range: { start, end, endGroupOpen } };
}

/** Whether Location {g, o} falls inside `range` (inclusive both ends, §location-filters). `range`
 * `undefined` means unfiltered — everything passes (the fast path every non-filtering subscriber and
 * every unfiltered FETCH takes). */
export function locationInRange(g: bigint, o: bigint, range: ResolvedRange | undefined): boolean {
  if (range === undefined) return true;
  if (g < range.start.group || (g === range.start.group && o < range.start.object)) return false;
  if (range.end === undefined) return true;
  if (g > range.end.group) return false;
  return !(g === range.end.group && !range.endGroupOpen && o > range.end.object);
}

/**
 * Serve a FETCH from the late-joiner cache. #212 E3: draft-20 drops the FetchType/joining variant
 * (see moq-wire-fetch.ts header) — every FETCH is now the same shape, and its range comes from an
 * OPTIONAL LOCATION_FILTER parameter instead of dedicated message fields. This handler resolves the
 * absolute forms of that filter (an omitted filter ⇒ whole cached track; explicit StartGroup+
 * StartObject with an optional EndGroupDelta[+EndObject] ⇒ that range, EndObject omitted meaning
 * "rest of the End Group") and replays every cached object in range, preceded by FETCH_OK with the
 * largest matched location. A fetch with nothing in range → REQUEST_ERROR(INVALID_RANGE).
 *
 * draft-20 §5.1.2 also defines two RELATIVE forms of LOCATION_FILTER (a lone StartGroup, or
 * StartGroup=StartObject=0) resolved against "Largest Object" — this relay's bounded per-track
 * cache doesn't track Largest Object independently of what it still retains, so those forms →
 * REQUEST_ERROR(NOT_SUPPORTED), same as the "joining" FETCH variant they functionally replace was
 * before E3 (fill-fetch, draft-20's actual replacement mechanism, is SUBSCRIBE-side — see
 * moq-wire-fetch.ts's FillParameters doc — and isn't wired into this one-track-per-DO relay yet).
 */
export function handleFetch(cache: CachedGroup[], sessionId: string, payload: Uint8Array, replies: Outbound[], objects: Outbound[]): void {
  const m = decodeFetch(payload);
  const resolved = resolveLocationFilter(m.locationFilter);
  if (resolved.relative) {
    replies.push({ to: sessionId, kind: 'control', frame: encodeRequestError({ requestId: m.requestId, errorCode: MOQ_ERROR.NOT_SUPPORTED, reason: 'relative Location Filter not supported' }) });
    return;
  }
  const range = resolved.range;

  const matched: Array<{ frame: Uint8Array; group: bigint; object: bigint }> = [];
  for (const grp of cache) for (const o of grp.objects) if (locationInRange(grp.groupId, o.objectId, range)) matched.push({ frame: o.frame, group: grp.groupId, object: o.objectId });

  if (matched.length === 0) {
    replies.push({ to: sessionId, kind: 'control', frame: encodeRequestError({ requestId: m.requestId, errorCode: MOQ_ERROR.INVALID_RANGE, reason: 'range not in cache' }) });
    return;
  }
  const last = matched[matched.length - 1];
  replies.push({ to: sessionId, kind: 'control', frame: encodeFetchOk({ endOfTrack: false, end: { group: last.group, object: last.object } }) });
  for (const x of matched) objects.push({ to: sessionId, kind: 'object', frame: x.frame });
}

/**
 * Handle REQUEST_UPDATE (#212 E6, draft-20 §message-request-update, 0x2) — the mid-stream
 * viewport-update payoff: a viewer updates its active LOCATION_FILTER (and/or FORWARD state) on an
 * already-open subscription WITHOUT tearing it down and re-SUBSCRIBEing. Per `moq-wire-request-update.ts`'s
 * header discrepancy note, this relay correlates the update to a subscription by SESSION (its one
 * bidi-request-stream stand-in on the WS transport), not by matching the REQUEST_UPDATE's own (new)
 * Request ID against the original SUBSCRIBE's.
 *
 * A session with no active subscriber entry has nothing to update — draft-20 says an
 * out-of-context REQUEST_UPDATE "MUST close the session with PROTOCOL_VIOLATION"; this relay takes
 * the same softer REQUEST_ERROR(DOES_NOT_EXIST) posture `moq-relay.ts`'s TRACK_STATUS case already
 * uses for "no such state" rather than tearing down the whole session, matching this relay's
 * established pattern of REQUEST_ERROR over hard session termination for request-scoped failures
 * (see the relative-Location-Filter NOT_SUPPORTED replies above).
 *
 * LOCATION_FILTER present ⇒ REPLACES the subscriber's range entirely (never merged field-by-field,
 * §message-request-update / §location-filters); a relative form is rejected the same way SUBSCRIBE's
 * initial filter is (this relay does not track Largest Object independently of its cache). A
 * zero-length LOCATION_FILTER (`{}`, all fields undefined) resolves to `range: undefined` via the
 * SAME `resolveLocationFilter` SUBSCRIBE/FETCH already use — no special-casing needed, since an
 * all-undefined LocationFilter already means "unfiltered" there (§location-filters: "Length 0 ...
 * remove the filter"). FORWARD present ⇒ sets the subscriber's forwarding state; 0 pauses fan-out to
 * this subscriber (checked in `moq-relay.ts`'s `fanOut` below) without dropping the subscription itself.
 */
export function handleRequestUpdate(subscribers: Map<string, Subscriber>, sessionId: string, payload: Uint8Array, replies: Outbound[]): void {
  const m = decodeRequestUpdate(payload);
  const sub = subscribers.get(sessionId);
  if (!sub) {
    replies.push({
      to: sessionId,
      kind: 'control',
      frame: encodeRequestError({ requestId: m.requestId, errorCode: MOQ_ERROR.DOES_NOT_EXIST, reason: 'no active subscription to update' }),
    });
    return;
  }
  if (m.locationFilter !== undefined) {
    const resolved = resolveLocationFilter(m.locationFilter);
    if (resolved.relative) {
      replies.push({
        to: sessionId,
        kind: 'control',
        frame: encodeRequestError({ requestId: m.requestId, errorCode: MOQ_ERROR.NOT_SUPPORTED, reason: 'relative Location Filter not supported' }),
      });
      return;
    }
    sub.range = resolved.range;
  }
  if (m.forward !== undefined) sub.forward = m.forward;
  replies.push({ to: sessionId, kind: 'control', frame: encodeRequestOk({ requestId: m.requestId }) });
}
