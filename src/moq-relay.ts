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
  MOQ_FETCH_TYPE,
  MOQ_OBJECT_STATUS,
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
  decodeObject,
  encodeObject,
  type MoqObject,
} from './moq-wire';

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

interface Subscriber {
  requestId: bigint;
}

/** One cached group: the forwarded object frames of a single Group ID, in arrival order. */
interface CachedGroup {
  groupId: bigint;
  objects: Array<{ objectId: bigint; frame: Uint8Array }>;
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

  // Monotonic object id for one-shot server-side injects ({@link injectObject}); single synthetic group.
  private injectedSeq = 0n;

  // Late-joiner cache: the last N groups of forwarded object frames, oldest-first (a small ring).
  private cache: CachedGroup[] = [];
  private readonly maxCachedGroups: number;

  constructor(opts: { cachedGroups?: number } = {}) {
    const n = opts.cachedGroups ?? DEFAULT_CACHED_GROUPS;
    this.maxCachedGroups = n > 0 ? n : 0;
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
        const m = decodeSubscribe(payload);
        this.subscribers.set(sessionId, { requestId: m.requestId });
        replies.push({ to: sessionId, kind: 'control', frame: encodeSubscribeOk({ requestId: m.requestId, expires: 0n }) });
        // Late-joiner replay: hand the new subscriber the cached recent groups so it can begin
        // decoding from a recent group boundary instead of waiting for the next one.
        for (const g of this.cache) for (const o of g.objects) objects.push({ to: sessionId, kind: 'object', frame: o.frame });
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
   * Serve a FETCH from the late-joiner cache. Standalone fetches replay every cached object whose
   * (group, object) location falls within [start, end] to the requester, preceded by FETCH_OK with the
   * largest available location. A fetch with nothing in range → REQUEST_ERROR(INVALID_RANGE). Joining
   * fetches aren't modeled (one track per DO) → REQUEST_ERROR(NOT_SUPPORTED).
   */
  private onFetch(sessionId: string, payload: Uint8Array, replies: Outbound[], objects: Outbound[]): void {
    const m = decodeFetch(payload);
    if (m.fetchType !== MOQ_FETCH_TYPE.STANDALONE || !m.standalone) {
      replies.push({ to: sessionId, kind: 'control', frame: encodeRequestError({ requestId: m.requestId, errorCode: MOQ_ERROR.NOT_SUPPORTED, reason: 'only standalone fetch' }) });
      return;
    }
    const { start, end } = m.standalone;
    const inRange = (g: bigint, o: bigint) => !(g < start.group || g > end.group || (g === start.group && o < start.object) || (g === end.group && end.object !== 0n && o > end.object));

    const matched: Array<{ frame: Uint8Array; group: bigint; object: bigint }> = [];
    for (const grp of this.cache) for (const o of grp.objects) if (inRange(grp.groupId, o.objectId)) matched.push({ frame: o.frame, group: grp.groupId, object: o.objectId });

    if (matched.length === 0) {
      replies.push({ to: sessionId, kind: 'control', frame: encodeRequestError({ requestId: m.requestId, errorCode: MOQ_ERROR.INVALID_RANGE, reason: 'range not in cache' }) });
      return;
    }
    const last = matched[matched.length - 1];
    replies.push({ to: sessionId, kind: 'control', frame: encodeFetchOk({ endOfTrack: false, end: { group: last.group, object: last.object } }) });
    for (const x of matched) objects.push({ to: sessionId, kind: 'object', frame: x.frame });
  }

  /**
   * Handle one inbound OBJECT frame from `sessionId` (only the attached publisher's objects fan out).
   * Returns the per-subscriber object frames + metering events. The forwarded object is re-stamped
   * with this relay's TRACK_ALIAS so every subscriber sees a consistent alias, and cached for late
   * joiners (last-N-groups ring).
   */
  onObject(sessionId: string, frame: Uint8Array): { fanout: Outbound[]; events: RelayEvent[] } {
    const fanout: Outbound[] = [];
    const events: RelayEvent[] = [];
    if (sessionId !== this.publisher) return { fanout, events }; // only the publisher may push objects

    let obj: MoqObject;
    try {
      obj = decodeObject(frame);
    } catch {
      return { fanout, events };
    }
    const forwarded = encodeObject({ ...obj, trackAlias: TRACK_ALIAS });
    for (const subId of this.subscribers.keys()) {
      fanout.push({ to: subId, kind: 'object', frame: forwarded });
    }
    this.cacheObject(obj.groupId, obj.objectId, forwarded);
    events.push({ kind: 'object_received', sessionId, bytes: obj.payload.length, payload: obj.payload });
    if (this.lastGroupId !== null && obj.groupId !== this.lastGroupId) {
      events.push({ kind: 'group_complete', sessionId });
    }
    this.lastGroupId = obj.groupId;
    return { events, fanout };
  }

  /**
   * One-shot server-side object inject (E-CONTROL control track). Unlike {@link onObject}, this does
   * NOT require an attached WS publisher session — the cloud (crest-edge) delivers a single control
   * Envelope as one MoQ OBJECT to every CURRENT subscriber (the device). It is intentionally NOT cached
   * for late joiners: a control command is point-in-time, and replaying a stale command to a device that
   * reconnects later would risk re-execution (delivery is best-effort to who's connected now; the caller
   * learns the delivered count and can surface "device offline" honestly rather than silently succeed).
   *
   * Objects carry a monotonically increasing objectId (single synthetic group 0) so a subscriber never
   * sees a duplicate (group, object) location. The payload is the raw Envelope JSON bytes.
   */
  injectObject(payload: Uint8Array): { fanout: Outbound[]; delivered: number } {
    const fanout: Outbound[] = [];
    const frame = encodeObject({
      trackAlias: TRACK_ALIAS,
      groupId: 0n,
      objectId: this.injectedSeq++,
      status: MOQ_OBJECT_STATUS.NORMAL,
      payload,
    });
    for (const subId of this.subscribers.keys()) {
      fanout.push({ to: subId, kind: 'object', frame });
    }
    return { fanout, delivered: fanout.length };
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
