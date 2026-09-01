/**
 * MoQ relay core — the publish/subscribe fan-out state machine for ONE track (draft-18).
 *
 * PURE and transport-agnostic: it speaks in opaque session IDs (strings) and wire frames (Uint8Array
 * produced/consumed by moq-wire.ts). It does NOT know about WebSockets, WebTransport, or Durable
 * Objects — the Durable Object (moq-session-do.ts) binds it to CF WebSocket sessions, and a future
 * WebTransport binding drops in unchanged. This makes the relay logic hermetically unit-testable
 * (see __tests__/moq-relay.test.ts).
 *
 * One MoqRelay instance serves one track (the DO is already keyed per `namespace/track`). The flow:
 *   publisher: SETUP → PUBLISH_NAMESPACE        (relay records the publisher, replies REQUEST_OK)
 *   subscriber: SETUP → SUBSCRIBE               (relay replies SUBSCRIBE_OK, registers for fan-out)
 *   publisher: OBJECT, OBJECT, …                (relay fans each object out to every subscriber)
 * The relay re-stamps each forwarded object with this track's single Track Alias so subscribers see a
 * consistent alias regardless of the publisher's.
 */
import {
  MOQ_MSG,
  MOQ_ROLE,
  MOQ_ERROR,
  Reader,
  claimsSubgroupType,
  parseControl,
  decodeSetup,
  encodeSetup,
  decodeSubscribe,
  encodeSubscribeOk,
  decodePublishNamespace,
  decodePublish,
  decodeTrackStatus,
  decodeSubscribeNamespace,
  decodeFetch,
  encodeFetchOk,
  encodeRequestOk,
  encodeRequestError,
  decodePublishStateNotify,
  decodeRequestUpdate,
  decodeObject,
  decodeSubgroupStream,
  encodeObject,
  type MoqObject,
  type MoqLocation,
  type LocationFilter,
} from './moq-wire';
import { PendingGroupBuffer, SCHEDULER_MAX_BUFFER_MS } from './moq-scheduler';

export { SCHEDULER_MAX_BUFFER_MS } from './moq-scheduler';

/** Reordering window: max objects buffered before a forced flush (E2-fix). */
export const SCHEDULER_WINDOW_OBJECTS = 64;

/** A frame to deliver to a specific session (control reply or fanned-out object). */
export interface Outbound {
  to: string;
  frame: Uint8Array;
  kind: 'control' | 'object';
}

/** A relay observation the DO folds into the R4 metering (maps to MetricsCollector.MoqMetric.kind). */
export interface RelayEvent {
  kind: 'publish_start' | 'publish_end' | 'subscribe' | 'unsubscribe' | 'object_received' | 'group_complete';
  sessionId: string;
  bytes?: number;
  /** The decoded object payload, present on `object_received` only — so the DO can persist it (the
   * recording write path) without re-decoding the frame on the hot path. Publisher objects only. */
  payload?: Uint8Array;
}

/** An absolute Location range (#212 E5) — the resolved form of an absolute LOCATION_FILTER. `end`
 * undefined ⇒ open-ended (§location-filters: "When EndGroupDelta and EndObject are omitted from a
 * subscription filter, the subscription is open-ended"). `endGroupOpen` true ⇒ EndObject was omitted,
 * so the whole End Group passes (§location-filters: "the filter includes all objects in the End
 * Group"). Relative-to-Largest-Object forms are NOT representable here — see `resolveLocationFilter`. */
interface ResolvedRange {
  start: MoqLocation;
  end?: MoqLocation;
  endGroupOpen: boolean;
}

interface Subscriber {
  requestId: bigint;
  /** Resolved absolute LOCATION_FILTER range (#212 E5, updatable in-place by #212 E6's REQUEST_UPDATE)
   * — the per-viewport filter. `undefined` means the subscription carried no filter (or was decoded
   * with one that resolved to unfiltered): forward every object, byte-identical to pre-E5 fan-out. */
  range?: ResolvedRange;
  /** FORWARD state (#212 E6, §forward-parameter) — 0 = paused, 1/undefined = forwarding. Only
   * REQUEST_UPDATE sets this today (SUBSCRIBE itself carries no FORWARD parameter in this codec — see
   * moq-wire-subscribe.ts); `undefined` is the default forwarding-ON state, matching every
   * pre-E6 subscriber's behavior byte-for-byte. */
  forward?: 0 | 1;
}

/** One cached group: the forwarded object frames of a single Group ID, in arrival order. */
interface CachedGroup {
  groupId: bigint;
  objects: Array<{ objectId: bigint; frame: Uint8Array }>;
}

/** One object buffered by the E1 scheduler awaiting its group's flush (scheduler ON only). */
interface PendingObject {
  groupId: bigint;
  objectId: bigint;
  frame: Uint8Array;
  priority?: number; // non-wire hint (see MoqObject.priority)
  deadlineMs?: number; // non-wire hint (see MoqObject.deadlineMs)
}

/** The single Track Alias this relay stamps on forwarded objects (one track per DO). */
const TRACK_ALIAS = 1n;

/** Default number of recent groups to retain for late-joiner replay + FETCH-from-cache. */
const DEFAULT_CACHED_GROUPS = 3;

/** What a control frame produces: control replies, fanned-out objects (late-joiner replay), events. */
export interface ControlResult {
  replies: Outbound[];
  objects: Outbound[];
  events: RelayEvent[];
}

export class MoqRelay {
  private publisher: string | null = null;
  private publisherNamespace: string[] | null = null;
  private subscribers = new Map<string, Subscriber>();
  private lastGroupId: bigint | null = null;

  // Late-joiner cache: the last N groups of forwarded object frames, oldest-first (a small ring).
  private cache: CachedGroup[] = [];
  private readonly maxCachedGroups: number;

  // E1 deadline scheduler. When OFF (default) the forward path is byte-identical FIFO. When ON, the
  // objects of the CURRENT group are buffered and flushed in (priority, deadline) order at a group
  // boundary, a 64-object window, or a max-buffer-age timeout (#211); unknown priority/deadline
  // falls back to arrival order (fail-open). `now`/`maxBufferAgeMs` are injectable so the time-based
  // trigger is hermetically testable (see __tests__/moq-deadline-scheduler.test.ts).
  private readonly schedulerEnabled: boolean;
  private readonly maxBufferAgeMs: number;
  private readonly now: () => number;
  private readonly pending = new PendingGroupBuffer<PendingObject>();

  constructor(opts: { cachedGroups?: number; scheduler?: boolean; maxBufferAgeMs?: number; now?: () => number } = {}) {
    const n = opts.cachedGroups ?? DEFAULT_CACHED_GROUPS;
    this.maxCachedGroups = n > 0 ? n : 0;
    this.schedulerEnabled = opts.scheduler === true;
    this.maxBufferAgeMs = opts.maxBufferAgeMs ?? SCHEDULER_MAX_BUFFER_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Whether a publisher session is currently attached. */
  get hasPublisher(): boolean {
    return this.publisher !== null;
  }
  get subscriberCount(): number {
    return this.subscribers.size;
  }
  /** Number of cached objects across all retained groups (for tests / observability). */
  get cachedObjectCount(): number {
    return this.cache.reduce((n, g) => n + g.objects.length, 0);
  }

  /**
   * Handle one inbound control frame from `sessionId`. Returns the control replies to send back, any
   * objects to deliver to the caller (late-joiner / FETCH cache replay), and metering events. Unknown
   * / unsupported control types yield a REQUEST_ERROR(NOT_SUPPORTED).
   */
  onControl(sessionId: string, frame: Uint8Array): ControlResult {
    const replies: Outbound[] = [];
    const objects: Outbound[] = [];
    const events: RelayEvent[] = [];
    let type: number;
    let payload: Uint8Array;
    try {
      ({ type, payload } = parseControl(frame));
    } catch {
      return { replies, objects, events }; // malformed framing — ignore (a strict server would reset)
    }

    switch (type) {
      case MOQ_MSG.SETUP: {
        // Echo a SETUP advertising the relay as PUBSUB. (Each peer sends its own SETUP.)
        decodeSetup(payload); // validate it parses
        replies.push({
          to: sessionId,
          kind: 'control',
          frame: encodeSetup({ role: MOQ_ROLE.PUBSUB, maxSubscriptions: 0xffffn }),
        });
        break;
      }
      case MOQ_MSG.PUBLISH_NAMESPACE: {
        const m = decodePublishNamespace(payload);
        this.publisher = sessionId;
        this.publisherNamespace = m.trackNamespace;
        replies.push({ to: sessionId, kind: 'control', frame: encodeRequestOk({ requestId: m.requestId }) });
        events.push({ kind: 'publish_start', sessionId });
        break;
      }
      case MOQ_MSG.PUBLISH: {
        // Publisher-initiated push (vs the subscriber-pull SUBSCRIBE). Same effect on the relay as
        // PUBLISH_NAMESPACE: attach the publisher and ack with the generic REQUEST_OK.
        const m = decodePublish(payload);
        this.publisher = sessionId;
        this.publisherNamespace = m.trackNamespace;
        replies.push({ to: sessionId, kind: 'control', frame: encodeRequestOk({ requestId: m.requestId }) });
        events.push({ kind: 'publish_start', sessionId });
        break;
      }
      case MOQ_MSG.SUBSCRIBE: {
        // #212 E5 (draft-20 §location-filters, #1809): SUBSCRIBE now carries an OPTIONAL
        // LOCATION_FILTER Message Parameter (`moq-wire-subscribe.ts`) — the per-viewport range
        // selector. Same resolution/support rules as `onFetch`'s LOCATION_FILTER handling below:
        // the four absolute forms filter; the two relative-to-Largest-Object forms are rejected
        // (this relay does not track Largest Object independently of the cache it retains).
        const m = decodeSubscribe(payload);
        const resolved = resolveLocationFilter(m.locationFilter);
        if (resolved.relative) {
          replies.push({
            to: sessionId,
            kind: 'control',
            frame: encodeRequestError({ requestId: m.requestId, errorCode: MOQ_ERROR.NOT_SUPPORTED, reason: 'relative Location Filter not supported' }),
          });
          break;
        }
        this.subscribers.set(sessionId, { requestId: m.requestId, range: resolved.range });
        replies.push({ to: sessionId, kind: 'control', frame: encodeSubscribeOk({ requestId: m.requestId, expires: 0n }) });
        // Late-joiner replay: hand the new subscriber the cached recent groups so it can begin
        // decoding from a recent group boundary instead of waiting for the next one. E5: only the
        // objects inside this subscriber's range replay — an unfiltered subscriber (range
        // undefined) still gets every cached object, byte-identical to pre-E5.
        for (const g of this.cache) for (const o of g.objects) if (locationInRange(g.groupId, o.objectId, resolved.range)) objects.push({ to: sessionId, kind: 'object', frame: o.frame });
        events.push({ kind: 'subscribe', sessionId });
        break;
      }
      case MOQ_MSG.SUBSCRIBE_NAMESPACE: {
        // Subscriber announces interest in a namespace prefix. Ack with REQUEST_OK (the relay would
        // then stream NAMESPACE matches; with one track per DO we just acknowledge interest).
        const m = decodeSubscribeNamespace(payload);
        replies.push({ to: sessionId, kind: 'control', frame: encodeRequestOk({ requestId: m.requestId }) });
        break;
      }
      case MOQ_MSG.TRACK_STATUS: {
        // Liveness query (same wire shape as SUBSCRIBE). REQUEST_OK if a publisher is live on this
        // track, else REQUEST_ERROR(DOES_NOT_EXIST).
        const m = decodeTrackStatus(payload);
        const frameOut = this.hasPublisher
          ? encodeRequestOk({ requestId: m.requestId })
          : encodeRequestError({ requestId: m.requestId, errorCode: MOQ_ERROR.DOES_NOT_EXIST, reason: 'no publisher' });
        replies.push({ to: sessionId, kind: 'control', frame: frameOut });
        break;
      }
      case MOQ_MSG.FETCH: {
        this.onFetch(sessionId, payload, replies, objects);
        break;
      }
      case MOQ_MSG.GOAWAY: {
        // A peer signalling graceful drain/migration. The relay has no upstream to migrate to, so we
        // accept it silently (no reply per spec). Disconnect handling runs on socket close.
        break;
      }
      case MOQ_MSG.REQUEST_UPDATE: {
        this.onRequestUpdate(sessionId, payload, replies);
        break;
      }
      case MOQ_MSG.PUBLISH_STATE_NOTIFY: {
        // #212 E4 (draft-20 §ps-notify, 0x22) — UNILATERAL notification, no REQUEST_OK/REQUEST_ERROR
        // reply. Explicit case (vs `default`) fixes a real bug: `default`'s readFirstVarint() would
        // otherwise misread this message's "Number of Parameters" varint as a Request ID and reply
        // with a spurious REQUEST_ERROR — this message has no Request ID field (implied by the bidi
        // stream, like FETCH_OK). Decode-only to surface PROTOCOL_VIOLATION on a malformed frame; no
        // per-subscription state applied — SUBSCRIBE carries no Message Parameters yet in this relay
        // (moq-wire-fetch.ts), so this is codec-surface-only, matching E1/E3's precedent.
        decodePublishStateNotify(payload);
        break;
      }
      default: {
        // Reply with a REQUEST_ERROR for request-shaped messages we don't implement (requestId is the
        // first field of every request message). Best-effort: if it doesn't parse, stay silent.
        try {
          const { type: _t, payload: p } = parseControl(frame);
          void _t;
          // first varint of the payload is the request id for request-type messages
          const reqId = readFirstVarint(p);
          if (reqId !== null) {
            replies.push({
              to: sessionId,
              kind: 'control',
              frame: encodeRequestError({ requestId: reqId, errorCode: MOQ_ERROR.NOT_SUPPORTED, reason: 'unsupported' }),
            });
          }
        } catch {
          /* ignore */
        }
        break;
      }
    }
    return { replies, objects, events };
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
  private onFetch(sessionId: string, payload: Uint8Array, replies: Outbound[], objects: Outbound[]): void {
    const m = decodeFetch(payload);
    const resolved = resolveLocationFilter(m.locationFilter);
    if (resolved.relative) {
      replies.push({ to: sessionId, kind: 'control', frame: encodeRequestError({ requestId: m.requestId, errorCode: MOQ_ERROR.NOT_SUPPORTED, reason: 'relative Location Filter not supported' }) });
      return;
    }
    const range = resolved.range;

    const matched: Array<{ frame: Uint8Array; group: bigint; object: bigint }> = [];
    for (const grp of this.cache) for (const o of grp.objects) if (locationInRange(grp.groupId, o.objectId, range)) matched.push({ frame: o.frame, group: grp.groupId, object: o.objectId });

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
   * the same softer REQUEST_ERROR(DOES_NOT_EXIST) posture `onControl`'s TRACK_STATUS case already
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
   * this subscriber (checked in `fanOut` below) without dropping the subscription itself.
   */
  private onRequestUpdate(sessionId: string, payload: Uint8Array, replies: Outbound[]): void {
    const m = decodeRequestUpdate(payload);
    const sub = this.subscribers.get(sessionId);
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

  /**
   * Handle one inbound OBJECT frame from `sessionId` (only the attached publisher's objects fan out).
   * Returns the per-subscriber object frames + metering events. The forwarded object is re-stamped
   * with this relay's TRACK_ALIAS so every subscriber sees a consistent alias, and cached for late
   * joiners (last-N-groups ring).
   */
  onObject(sessionId: string, frame: Uint8Array): { fanout: Outbound[]; events: RelayEvent[] } {
    if (sessionId !== this.publisher) return { fanout: [], events: [] }; // only the publisher may push objects

    // SUBGROUP_HEADER detection: on the WS binding, subgroup frames arrive tagged as
    // WS_KIND=OBJECT (they're data-stream frames, same envelope as single objects). When the
    // scheduler is ON, detect the subgroup type byte and route through onSubgroupFrame which
    // decodes, stamps priority, and feeds the scheduler. When OFF, fall through to decodeObject
    // — it fails to parse the subgroup format (different structure), producing the same
    // silent-drop as today (byte-identical FIFO preserved).
    //
    // #212 E2 (#1774): dispatch on `claimsSubgroupType` (bit 4 alone), NOT the strict `isSubgroupType`.
    // Bit 4 is reserved-must-be-zero for OBJECT_DATAGRAM (moq-wire-object.ts), so a bit-4-set byte is
    // NEVER a valid datagram either — routing a malformed-but-bit-4-set byte to `decodeObject` instead
    // of `onSubgroupFrame` would silently reinterpret a PROTOCOL_VIOLATION as a differently-malformed
    // datagram (which decodeObject would then also reject, but for the wrong reason, on the wrong
    // path). `onSubgroupFrame` → `decodeSubgroupStream` throws `MoqProtocolViolationError` for any
    // malformed bit-4-set byte; the existing try/catch below still drops it (fail-safe, same observed
    // behavior as before), but the classification is now correct.
    if (this.schedulerEnabled) {
      try {
        const typeByte = new Reader(frame).varintNum();
        if (claimsSubgroupType(typeByte)) {
          return this.onSubgroupFrame(frame);
        }
      } catch {
        // malformed frame — fall through to decodeObject which will also fail
      }
    }

    let obj: MoqObject;
    try {
      obj = decodeObject(frame);
    } catch {
      return { fanout: [], events: [] };
    }
    return this.onDecodedObject(obj);
  }

  /**
   * Handle one inbound SUBGROUP_HEADER frame — decode the subgroup, convert each object to a
   * MoqObject (stamping the header's priority), and route through `onDecodedObject`. This is the
   * production-consumer path that feeds the scheduler hint data (priority from the wire) into the
   * E1 deadline scheduler.
   *
   * When the scheduler is OFF (default), the method is a no-op: the caller should use `onObject`
   * for the byte-identical OBJECT_DATAGRAM path instead. This ensures the flag-OFF path remains
   * byte-identical FIFO (E3 hard-gate).
   */
  onSubgroupFrame(frame: Uint8Array): { fanout: Outbound[]; events: RelayEvent[] } {
    if (!this.schedulerEnabled) return { fanout: [], events: [] };

    let decoded: ReturnType<typeof decodeSubgroupStream>;
    try {
      decoded = decodeSubgroupStream(frame);
    } catch {
      return { fanout: [], events: [] };
    }

    const { header, objects } = decoded;
    const fanout: Outbound[] = [];
    const events: RelayEvent[] = [];

    for (const o of objects) {
      const moqObj: MoqObject = {
        trackAlias: 0n, // will be re-stamped by onDecodedObject
        groupId: header.groupId,
        objectId: o.objectId,
        status: o.status,
        payload: o.payload,
        priority: header.defaultPriority ? undefined : header.priority,
      };
      const r = this.onDecodedObject(moqObj);
      fanout.push(...r.fanout);
      events.push(...r.events);
    }

    if (header.endOfGroup) this.flushPending(fanout);

    return { fanout, events };
  }

  /**
   * Forward a DECODED object through the fan-out/cache path — the E1 scheduler's entry point. `onObject`
   * decodes a wire frame then delegates here; a future subgroup-decode path (or a test) may populate
   * `obj.priority`/`obj.deadlineMs`, since the OBJECT_DATAGRAM wire form carries neither (live traffic
   * is therefore always fail-open arrival order). Scheduler OFF (default): fan out + cache immediately,
   * byte-identical FIFO. Scheduler ON: buffer per group and flush the PREVIOUS buffer in (priority,
   * deadline) order at a group boundary, a 64-object window, or a max-buffer-age timeout (#211, see
   * `schedule()`); call flush() to emit the final group (publish_end / tests), or flushStale() for the
   * stalled-stream case (see moq-session-do.ts's alarm-armed call).
   */
  onDecodedObject(obj: MoqObject): { fanout: Outbound[]; events: RelayEvent[] } {
    const fanout: Outbound[] = [];
    const events: RelayEvent[] = [];
    const sessionId = this.publisher;
    if (sessionId === null) return { fanout, events }; // no publisher attached — nothing to forward

    const forwarded = encodeObject({ ...obj, trackAlias: TRACK_ALIAS });
    if (this.schedulerEnabled) {
      this.schedule(obj.groupId, obj.objectId, forwarded, obj.priority, obj.deadlineMs, fanout);
    } else {
      this.fanOut(forwarded, fanout, obj.groupId, obj.objectId);
      this.cacheObject(obj.groupId, obj.objectId, forwarded);
    }

    events.push({ kind: 'object_received', sessionId, bytes: obj.payload.length, payload: obj.payload });
    if (this.lastGroupId !== null && obj.groupId !== this.lastGroupId) {
      events.push({ kind: 'group_complete', sessionId });
    }
    this.lastGroupId = obj.groupId;
    return { events, fanout };
  }

  /** Append a forwarded object to the last-N-groups cache, starting a new group + evicting as needed. */
  private cacheObject(groupId: bigint, objectId: bigint, frame: Uint8Array): void {
    if (this.maxCachedGroups === 0) return;
    let grp = this.cache.length > 0 ? this.cache[this.cache.length - 1] : undefined;
    if (!grp || grp.groupId !== groupId) {
      grp = { groupId, objects: [] };
      this.cache.push(grp);
      while (this.cache.length > this.maxCachedGroups) this.cache.shift();
    }
    grp.objects.push({ objectId, frame });
  }

  /**
   * Fan one forwarded frame out to every subscriber whose Location filter admits it, in subscriber
   * arrival (Map insertion) order. #212 E5: this is the per-viewport live-delivery filter — a
   * subscriber with no filter (`range === undefined`) always receives the object, byte-identical to
   * pre-E5 fan-out; a subscriber with a range only receives objects whose (group, object) Location
   * falls inside it (§location-filters: "A publisher MUST NOT send subscription-delivered objects
   * from outside the requested range"). The SAME frame bytes go to every admitted subscriber — only
   * the recipient SET changes, never the bytes or the per-subscriber delivery order — so this does
   * not disturb the E2 whole-group-flush ordering invariant.
   */
  private fanOut(frame: Uint8Array, out: Outbound[], groupId: bigint, objectId: bigint): void {
    for (const [subId, sub] of this.subscribers) {
      if (sub.forward === 0) continue; // #212 E6: REQUEST_UPDATE(FORWARD=0) paused this subscriber
      if (!locationInRange(groupId, objectId, sub.range)) continue;
      out.push({ to: subId, kind: 'object', frame });
    }
  }

  /**
   * E1/E3 scheduler (ON only): buffer the object in its group. Flush the pending buffer FIRST (as a
   * whole unit, in (priority, deadline) order — never mid-group/partial, per the E2-fix rejection of
   * deadline-pressure flushing) when either trigger fires: (1) a group boundary — the incoming
   * object's group differs from the buffered group, or (2) max-buffer-age (#211) — the buffer has
   * been open at least `maxBufferAgeMs`, so a low-rate/single-group track's tail can't sit forever
   * waiting for a boundary that may never come. Frames are pre-encoded (re-stamped with TRACK_ALIAS)
   * so ordering never changes a single byte on the wire.
   */
  private schedule(groupId: bigint, objectId: bigint, frame: Uint8Array, priority: number | undefined, deadlineMs: number | undefined, out: Outbound[]): void {
    const nowMs = this.now();
    const boundaryCrossed = this.pending.length > 0 && this.pending.groupId !== groupId;
    if (boundaryCrossed || this.pending.isStale(nowMs, this.maxBufferAgeMs)) this.flushPending(out);
    this.pending.push({ groupId, objectId, frame, priority, deadlineMs }, nowMs);
    // Bounded-window reordering: flush when the window fills, so delivery never depends on a
    // run-end flush. Group boundary and max-buffer-age remain the other two triggers; absent
    // hints retain arrival order (stable sorter).
    if (this.pending.length >= SCHEDULER_WINDOW_OBJECTS) this.flushPending(out);
  }

  /** Emit the scheduler's buffered group (if any) in (priority, deadline) order into `out`. */
  private flushPending(out: Outbound[]): void {
    for (const p of this.pending.drain()) {
      this.fanOut(p.frame, out, p.groupId, p.objectId);
      this.cacheObject(p.groupId, p.objectId, p.frame);
    }
  }

  /**
   * The max-buffer-age flush's STALL case (#211): a stream that stops sending new objects mid-group
   * never re-enters `schedule()`, so nothing re-checks staleness. The DO arms a timer/alarm off
   * `pendingBufferedAt` and calls this from it; `flushStale()` re-checks age against the relay's own
   * clock (`now`) and flushes only if still due (idempotent / safe to call speculatively — a no-op if
   * the buffer was already flushed by another trigger in the meantime, or isn't stale yet).
   */
  flushStale(): Outbound[] {
    const out: Outbound[] = [];
    if (this.schedulerEnabled && this.pending.isStale(this.now(), this.maxBufferAgeMs)) this.flushPending(out);
    return out;
  }

  /** When the currently pending group/window started buffering (relay clock), or null if nothing is
   * pending. The DO reads this to arm a `flushStale()` timer/alarm at `pendingBufferedAt + maxBufferAgeMs`. */
  get pendingBufferedAt(): number | null {
    return this.pending.bufferedSince;
  }

  /**
   * Emit the scheduler's buffered final group, in (priority, deadline) order. No-op when the
   * scheduler is OFF or nothing is pending. The DO calls this on publish_end so a closing publisher
   * never strands its final buffered group (fail-open: no drop). Tests call it to observe a group.
   */
  flush(): Outbound[] {
    const out: Outbound[] = [];
    if (this.schedulerEnabled) this.flushPending(out);
    return out;
  }

  /**
   * Rebuild publisher + subscriber registration after a Durable Object hibernation wake. The DO
   * reconstructs in-memory state from each surviving socket's serialized attachment ({sessionId, role})
   * and replays it here so fan-out resumes without re-handshaking. Emits NO replies/events (the
   * SUBSCRIBE_OK / REQUEST_OK already went out before hibernation). The late-joiner object cache is
   * intentionally not restored — it is best-effort and refills as new groups arrive. The restored
   * subscriber requestId is unknown (only echoed in the original SUBSCRIBE_OK) so a placeholder is
   * used; it does not affect fan-out, which keys purely on session id.
   */
  hydrate(sessions: Array<{ sessionId: string; role: 'publisher' | 'subscriber' }>): void {
    for (const s of sessions) {
      if (s.role === 'publisher') this.publisher = s.sessionId;
      else this.subscribers.set(s.sessionId, { requestId: 0n });
    }
  }

  /** Drop a session (publisher or subscriber) on disconnect; returns the metering events. */
  removeSession(sessionId: string): RelayEvent[] {
    const events: RelayEvent[] = [];
    if (this.subscribers.delete(sessionId)) events.push({ kind: 'unsubscribe', sessionId });
    if (this.publisher === sessionId) {
      this.publisher = null;
      this.publisherNamespace = null;
      events.push({ kind: 'publish_end', sessionId });
    }
    return events;
  }
}

/**
 * Resolve a decoded LOCATION_FILTER (#212 E5, §location-filters) into either an ABSOLUTE
 * `ResolvedRange` (or `undefined` for "no filter" / unfiltered) or a `{ relative: true }` marker for
 * the two forms this bounded-cache relay does not resolve: a lone StartGroup, or
 * StartGroup=StartObject=0 (both defined relative to `Largest Object`, which this relay does not track
 * independently of the last-N-groups cache it retains). Shared by `onFetch` and the SUBSCRIBE handler
 * — the resolution rules are identical for both message types (§location-filters applies the same
 * positional-field semantics to FETCH and SUBSCRIBE Location filters).
 */
function resolveLocationFilter(f: LocationFilter | undefined): { relative: true } | { relative: false; range?: ResolvedRange } {
  if (f === undefined || f.startGroup === undefined) return { relative: false, range: undefined };
  const isRelative = f.startObject === undefined || (f.startGroup === 0n && f.startObject === 0n && f.endGroupDelta === undefined);
  if (isRelative) return { relative: true };
  const start: MoqLocation = { group: f.startGroup, object: f.startObject! };
  let end: MoqLocation | undefined;
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
function locationInRange(g: bigint, o: bigint, range: ResolvedRange | undefined): boolean {
  if (range === undefined) return true;
  if (g < range.start.group || (g === range.start.group && o < range.start.object)) return false;
  if (range.end === undefined) return true;
  if (g > range.end.group) return false;
  return !(g === range.end.group && !range.endGroupOpen && o > range.end.object);
}

/** Read the first varint of a control payload (the Request ID of request-type messages), or null. */
function readFirstVarint(payload: Uint8Array): bigint | null {
  try {
    const b0 = payload[0];
    let lead = 0;
    let probe = b0;
    while (lead < 8 && probe & 0x80) {
      lead++;
      probe = (probe << 1) & 0xff;
    }
    if (lead === 8) {
      let v = 0n;
      for (let i = 1; i <= 8; i++) v = (v << 8n) | BigInt(payload[i]);
      return v;
    }
    const n = lead + 1;
    let v = BigInt(b0 & (0xff >> n));
    for (let i = 1; i < n; i++) v = (v << 8n) | BigInt(payload[i]);
    return v;
  } catch {
    return null;
  }
}
