/**
 * MoQ session client — publish and subscribe over any Transport, with an ordering and latency report.
 *
 * The wire codec is NOT reimplemented here. Every byte on the wire is produced and consumed by
 * `src/moq-wire.ts`, the repo's draft-18 codec, imported unmodified. That is deliberate: a client
 * with its own second copy of the codec would prove only that the copy agrees with itself, whereas
 * this one exercises the exact encoder the relay runs. If the codec is wrong, this client is wrong in
 * the same direction — which is the honest result for an interop instrument.
 *
 * Negative outcomes are first-class return values, never thrown-and-lost: connection refused, ALPN
 * mismatch, auth rejected and track-not-found each land in `SessionReport.outcome` with the wire
 * evidence that produced them. A failed interop attempt is a receipt, not an error to swallow.
 */

import {
  MOQ_MSG,
  MOQ_OBJECT_STATUS,
  MOQ_ROLE,
  MOQ_ALPN,
  MOQ_DRAFT_VERSION,
  WS_KIND,
  decodeObject,
  decodeRequestError,
  decodeSetup,
  decodeSubscribeOk,
  encodeObject,
  encodePublishNamespace,
  encodeSetup,
  encodeSubscribe,
  parseControl,
  tagFrame,
  untagFrame,
} from '../../../src/moq-wire.ts';
import type { Transport } from './transport.ts';

export type SessionOutcome =
  | 'ok'
  | 'connection-refused'
  | 'alpn-mismatch'
  | 'auth-rejected'
  | 'track-not-found'
  | 'setup-rejected'
  | 'timeout'
  | 'transport-error';

export interface LatencyStats {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export interface OrderingStats {
  /** Objects received whose (group, object) id went backwards relative to the running maximum. */
  outOfOrder: number;
  /** Gaps in the objectId sequence within a group — objects the peer dropped or never sent. */
  missing: number;
  /** True when every object arrived in non-decreasing (group, object) order with no gaps. */
  monotonic: boolean;
}

export interface SessionReport {
  peer: string;
  transport: 'websocket' | 'webtransport';
  /** The ALPN the transport actually negotiated — null when the transport exposes none. */
  transportAlpn: string | null;
  /** The MoQ draft this client speaks, from the imported codec — not a hand-written constant. */
  moqDraft: number;
  moqAlpn: string;
  role: 'publisher' | 'subscriber';
  outcome: SessionOutcome;
  evidence: string;
  objects: number;
  bytes: number;
  ordering: OrderingStats;
  latency: LatencyStats;
  observedAt: string;
  /**
   * Raw per-object end-to-end latency samples (ms), subscriber role only. Optional and additive —
   * `latency` above remains the authoritative per-session percentile summary; this field exists so
   * a caller running many sessions can pool raw samples into one true cross-session percentile
   * distribution instead of averaging percentiles (which is not a valid operation).
   */
  rawLatencySamplesMs?: number[];
  /** Peer close code/reason when the session ended by a close rather than by completing. */
  closeCode?: number;
  closeReason?: string;
}

export function percentiles(samples: number[]): LatencyStats {
  if (samples.length === 0) return { count: 0, p50Ms: null, p95Ms: null, minMs: null, maxMs: null };
  const s = [...samples].sort((a, b) => a - b);
  // Nearest-rank percentile: for n samples the p-th is at ceil(p/100 * n), 1-indexed. No interpolation,
  // so every reported figure is a value that was actually measured rather than a synthesised average.
  const at = (p: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  return { count: s.length, p50Ms: at(50), p95Ms: at(95), minMs: s[0], maxMs: s[s.length - 1] };
}

/** Map a MoQ REQUEST_ERROR onto the negative-case taxonomy the interop report cares about. */
export function classifyRequestError(errorCode: number, reason: string): SessionOutcome {
  const r = reason.toLowerCase();
  if (/unauthor|forbidden|token|auth|expired|scope/.test(r)) return 'auth-rejected';
  if (/not.?found|unknown track|no such/.test(r)) return 'track-not-found';
  // draft-18 §10 error codes: 0x2 UNAUTHORIZED, 0x4 TRACK_DOES_NOT_EXIST in the relay subset.
  if (errorCode === 0x2) return 'auth-rejected';
  if (errorCode === 0x4) return 'track-not-found';
  return 'setup-rejected';
}

function tracked(kind: number, body: Uint8Array, transport: Transport): void {
  // WebSocket carries the 1-byte kind tag (src/moq-wire.ts §"WebSocket transport envelope").
  // WebTransport carries control and objects on separate QUIC streams, so no tag belongs on the wire.
  transport.send(transport.kind === 'websocket' ? tagFrame(kind, body) : body);
}

function untag(bytes: Uint8Array, transport: Transport): { kind: number; body: Uint8Array } {
  if (transport.kind === 'websocket') return untagFrame(bytes);
  // Without the envelope, a control message is identified by its framed type; anything else is data.
  try {
    const { type } = parseControl(bytes);
    const known = Object.values(MOQ_MSG).includes(type as never);
    return { kind: known ? WS_KIND.CONTROL : WS_KIND.OBJECT, body: bytes };
  } catch {
    return { kind: WS_KIND.OBJECT, body: bytes };
  }
}

export interface SubscribeOpts {
  transport: Transport;
  peer: string;
  namespace: string[];
  track: string;
  /** Stop after this many objects, or when `durationMs` elapses — whichever comes first. */
  maxObjects?: number;
  durationMs?: number;
  path?: string;
}

/**
 * SETUP → SUBSCRIBE → collect objects. Latency is measured from the publisher timestamp embedded in
 * each object payload when present (see `makeProbePayload`); objects without one are counted but
 * contribute no latency sample, so the percentile never silently reports clock skew as latency.
 */
export async function runSubscribe(o: SubscribeOpts): Promise<SessionReport> {
  const t = o.transport;
  const started = Date.now();
  const deadline = started + (o.durationMs ?? 10000);
  const base = {
    peer: o.peer,
    transport: t.kind,
    transportAlpn: t.alpn,
    moqDraft: MOQ_DRAFT_VERSION,
    moqAlpn: MOQ_ALPN,
    role: 'subscriber' as const,
    observedAt: new Date().toISOString(),
  };

  const latencies: number[] = [];
  let objects = 0;
  let bytes = 0;
  let outOfOrder = 0;
  let missing = 0;
  let lastGroup = -1n;
  let lastObject = -1n;

  const finish = (outcome: SessionOutcome, evidence: string, close?: { code: number; reason: string }): SessionReport => ({
    ...base,
    outcome,
    evidence,
    objects,
    bytes,
    ordering: { outOfOrder, missing, monotonic: outOfOrder === 0 && missing === 0 },
    latency: percentiles(latencies),
    rawLatencySamplesMs: latencies,
    closeCode: close?.code,
    closeReason: close?.reason,
  });

  tracked(WS_KIND.CONTROL, encodeSetup({ role: MOQ_ROLE.SUBSCRIBER, maxSubscriptions: 16n, path: o.path }), t);
  tracked(WS_KIND.CONTROL, encodeSubscribe({ requestId: 1n, trackNamespace: o.namespace, trackName: o.track }), t);

  let subscribed = false;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return finish(
        subscribed ? 'ok' : 'timeout',
        subscribed
          ? `collected ${objects} object(s) before the ${o.durationMs ?? 10000} ms window closed`
          : `no SUBSCRIBE_OK or REQUEST_ERROR within ${o.durationMs ?? 10000} ms`,
      );
    }

    const msg = await Promise.race([
      t.receive(),
      new Promise<'deadline'>((r) => setTimeout(() => r('deadline'), remaining)),
      t.closeInfo.then((c) => ({ closed: c })),
    ]);
    if (msg === 'deadline') continue;
    if (msg === null) return finish(subscribed ? 'ok' : 'transport-error', 'peer closed the transport');
    if (typeof msg === 'object' && 'closed' in msg) {
      const c = msg.closed;
      return finish(
        subscribed ? 'ok' : 'transport-error',
        `peer closed: code=${c.code}${c.reason ? ` reason="${c.reason}"` : ''}`,
        c,
      );
    }

    const { kind, body } = untag(msg, t);
    if (kind === WS_KIND.OBJECT) {
      const obj = decodeObject(body);
      objects++;
      bytes += obj.payload.length;
      if (obj.groupId < lastGroup || (obj.groupId === lastGroup && obj.objectId <= lastObject)) outOfOrder++;
      else if (obj.groupId === lastGroup && obj.objectId > lastObject + 1n) missing += Number(obj.objectId - lastObject - 1n);
      if (obj.groupId > lastGroup || (obj.groupId === lastGroup && obj.objectId > lastObject)) {
        lastGroup = obj.groupId;
        lastObject = obj.objectId;
      }
      const sent = readProbeTimestamp(obj.payload);
      if (sent !== null) latencies.push(Date.now() - sent);
      if (o.maxObjects && objects >= o.maxObjects) {
        return finish('ok', `received ${objects} object(s) from ${o.namespace.join('/')}/${o.track}`);
      }
      continue;
    }

    const { type, payload } = parseControl(body);
    if (type === MOQ_MSG.SUBSCRIBE_OK || type === MOQ_MSG.REQUEST_OK) {
      subscribed = true;
      if (type === MOQ_MSG.SUBSCRIBE_OK) decodeSubscribeOk(payload); // validate the shape on the wire
      continue;
    }
    if (type === MOQ_MSG.REQUEST_ERROR) {
      const e = decodeRequestError(payload);
      return finish(
        classifyRequestError(e.errorCode, e.reason),
        `REQUEST_ERROR code=0x${e.errorCode.toString(16)} reason="${e.reason}"`,
      );
    }
    if (type === MOQ_MSG.SETUP) {
      const s = decodeSetup(payload);
      base.transportAlpn ??= null;
      void s;
      continue;
    }
    if (type === MOQ_MSG.GOAWAY) return finish(subscribed ? 'ok' : 'setup-rejected', 'peer sent GOAWAY');
  }
}

export interface PublishOpts {
  transport: Transport;
  peer: string;
  namespace: string[];
  track: string;
  count: number;
  intervalMs: number;
  payloadBytes?: number;
  path?: string;
  /**
   * Fired synchronously right after PUBLISH_NAMESPACE is sent, before any object is emitted. Lets a
   * caller learn the track is announced (so a subscriber's publisher-not-found 404 can now resolve)
   * WITHOUT having also started the object stream. Optional; publishers that don't coordinate a
   * subscriber ignore it.
   */
  onAnnounced?: () => void;
  /**
   * Awaited AFTER announce and BEFORE the first object is sent. When provided, the object stream is
   * held until this resolves — so a coordinating caller can attach the subscriber first and every
   * emitted object is published into an already-attached subscriber. This is what makes the measured
   * end-to-end latency steady-state rather than an on-attach backlog burst (bench-sixteen-track:
   * publisher used to send from t=0 while the subscriber attached ~seconds later, and the relay then
   * delivered those early objects late, inflating p50/p95 ~50x over the true per-hop floor). Optional;
   * omitted → the stream starts immediately after announce, unchanged.
   */
  startSignal?: Promise<void>;
}

/** SETUP → PUBLISH_NAMESPACE → emit `count` timestamped objects on one group, in order. */
export async function runPublish(o: PublishOpts): Promise<SessionReport> {
  const t = o.transport;
  const base = {
    peer: o.peer,
    transport: t.kind,
    transportAlpn: t.alpn,
    moqDraft: MOQ_DRAFT_VERSION,
    moqAlpn: MOQ_ALPN,
    role: 'publisher' as const,
    observedAt: new Date().toISOString(),
  };

  tracked(WS_KIND.CONTROL, encodeSetup({ role: MOQ_ROLE.PUBLISHER, maxSubscriptions: 0n, path: o.path }), t);
  tracked(WS_KIND.CONTROL, encodePublishNamespace({ requestId: 1n, trackNamespace: o.namespace }), t);

  // Announced now, but not one object sent yet. A coordinating caller uses onAnnounced to release the
  // subscriber's attach, then resolves startSignal once attached — so the object stream below only
  // begins against an already-attached subscriber (steady-state latency, no on-attach backlog).
  o.onAnnounced?.();
  if (o.startSignal) await o.startSignal;

  let sent = 0;
  let bytes = 0;
  const sendLatencies: number[] = [];
  for (let i = 0; i < o.count; i++) {
    const closed = await Promise.race([
      t.closeInfo.then((c) => c),
      new Promise<null>((r) => setTimeout(() => r(null), 0)),
    ]);
    if (closed) {
      return {
        ...base,
        outcome: closed.code === 1008 || closed.code === 3401 ? 'auth-rejected' : 'transport-error',
        evidence: `peer closed mid-publish: code=${closed.code}${closed.reason ? ` reason="${closed.reason}"` : ''}`,
        objects: sent,
        bytes,
        ordering: { outOfOrder: 0, missing: 0, monotonic: true },
        latency: percentiles(sendLatencies),
        closeCode: closed.code,
        closeReason: closed.reason,
      };
    }

    const at = process.hrtime.bigint();
    const payload = makeProbePayload(o.payloadBytes ?? 64);
    const frame = encodeObject({
      trackAlias: 1n,
      groupId: 0n,
      objectId: BigInt(i),
      status: MOQ_OBJECT_STATUS.NORMAL,
      payload,
    });
    tracked(WS_KIND.OBJECT, frame, t);
    sendLatencies.push(Number(process.hrtime.bigint() - at) / 1e6);
    sent++;
    bytes += payload.length;
    if (o.intervalMs > 0 && i < o.count - 1) await new Promise((r) => setTimeout(r, o.intervalMs));
  }

  return {
    ...base,
    outcome: 'ok',
    evidence: `published ${sent} object(s) to ${o.namespace.join('/')}/${o.track}`,
    objects: sent,
    bytes,
    ordering: { outOfOrder: 0, missing: 0, monotonic: true },
    latency: percentiles(sendLatencies),
  };
}

const PROBE_MAGIC = 0x57415645; // "WAVE" — marks a payload that carries a send timestamp

/** Build an object payload whose first 12 bytes are a magic + a millisecond send timestamp. */
export function makeProbePayload(size: number): Uint8Array {
  const n = Math.max(12, size);
  const buf = new Uint8Array(n);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, PROBE_MAGIC);
  dv.setBigUint64(4, BigInt(Date.now()));
  return buf;
}

/** Read the send timestamp back, or null when the payload is not one of ours (so it is not timed). */
export function readProbeTimestamp(payload: Uint8Array): number | null {
  if (payload.length < 12) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (dv.getUint32(0) !== PROBE_MAGIC) return null;
  return Number(dv.getBigUint64(4));
}
