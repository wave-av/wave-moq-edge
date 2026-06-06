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
  parseControl,
  decodeSetup,
  encodeSetup,
  decodeSubscribe,
  encodeSubscribeOk,
  decodePublishNamespace,
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
}

interface Subscriber {
  requestId: bigint;
}

/** The single Track Alias this relay stamps on forwarded objects (one track per DO). */
const TRACK_ALIAS = 1n;

export class MoqRelay {
  private publisher: string | null = null;
  private publisherNamespace: string[] | null = null;
  private subscribers = new Map<string, Subscriber>();
  private lastGroupId: bigint | null = null;

  /** Whether a publisher session is currently attached. */
  get hasPublisher(): boolean {
    return this.publisher !== null;
  }
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Handle one inbound control frame from `sessionId`. Returns the control replies to send back and
   * any metering events. Unknown / unsupported control types yield a REQUEST_ERROR(NOT_SUPPORTED).
   */
  onControl(sessionId: string, frame: Uint8Array): { replies: Outbound[]; events: RelayEvent[] } {
    const replies: Outbound[] = [];
    const events: RelayEvent[] = [];
    let type: number;
    let payload: Uint8Array;
    try {
      ({ type, payload } = parseControl(frame));
    } catch {
      return { replies, events }; // malformed framing — ignore (a strict server would reset)
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
      case MOQ_MSG.SUBSCRIBE: {
        const m = decodeSubscribe(payload);
        this.subscribers.set(sessionId, { requestId: m.requestId });
        replies.push({ to: sessionId, kind: 'control', frame: encodeSubscribeOk({ requestId: m.requestId, expires: 0n }) });
        events.push({ kind: 'subscribe', sessionId });
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
    return { replies, events };
  }

  /**
   * Handle one inbound OBJECT frame from `sessionId` (only the attached publisher's objects fan out).
   * Returns the per-subscriber object frames + metering events. The forwarded object is re-stamped
   * with this relay's TRACK_ALIAS so every subscriber sees a consistent alias.
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
    events.push({ kind: 'object_received', sessionId, bytes: obj.payload.length });
    if (this.lastGroupId !== null && obj.groupId !== this.lastGroupId) {
      events.push({ kind: 'group_complete', sessionId });
    }
    this.lastGroupId = obj.groupId;
    return { events, fanout };
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
