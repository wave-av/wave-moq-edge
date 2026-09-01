/**
 * MoQ Transport wire codec — draft-ietf-moq-transport-20 (2026-08-31), uplevel of draft-18 (#212 E0/E1).
 *
 * Spec-grounded serialization for the relay-relevant subset of the IETF MoQ Transport wire format.
 * Constants and field layouts read VERBATIM from the moq-wg/moq-transport GitHub source, base tag
 * `draft-ietf-moq-transport-18` plus the -19/-20 deltas this epic's E1 phase applies (not inferred).
 * This module is PURE: bytes in / structs out, no I/O, no platform calls — so it is hermetically
 * unit-testable (see __tests__/moq-wire.test.ts) and transport-independent. The relay (moq-relay.ts)
 * drives it; the Durable Object binds it to a WebSocket today (CF Workers has no WebTransport
 * *server* API yet) — the codec is the part that is portable to WebTransport/QUIC the moment that lands.
 *
 * Wire facts used here, with draft-18 section refs (still current at -20 unless noted):
 *   §1.4.1  varint: a leading-1-bits length prefix (NOT RFC 9000's 2-bit prefix) — 1..9 byte sizes.
 *   §1.4.2  Track Namespace: a tuple = count(i) followed by N length-prefixed byte fields.
 *   §10     control framing on a bidi request stream: Type(i) + Length(16) + Payload.
 *   §10     control type codes: SETUP=0x2F00, SUBSCRIBE=0x3, SUBSCRIBE_OK=0x4, REQUEST_ERROR=0x5,
 *           PUBLISH_NAMESPACE=0x6, REQUEST_OK=0x7, GOAWAY=0x10.
 *   §11     object model: OBJECT_DATAGRAM + SUBGROUP_HEADER; Object Status 0x0/0x3/0x4.
 *
 * draft-19/-20 deltas applied in E1 (#212):
 *   - PUBLISH_BLOCKED renamed PUBLISH_SKIPPED (naming only — no codec existed for it here yet).
 *   - "Message Payload" renamed "Message Body" in the control-framing docs (naming only).
 *   - GOAWAY (§message-goaway, draft-19 #1623) drops its Request ID field — it is carried on the
 *     control stream and needs no per-message id.
 *   - SETUP gains the MAX_REQUEST_UPDATES option (draft-19 #1613) and REQUEST_ERROR gains the
 *     TOO_MANY_REQUEST_UPDATES code. Codec surface only in this phase — enforcement lands in E6.
 */

// Byte cursor primitives (Writer/Reader) live in `moq-wire-primitives.ts` (#212 file-size
// follow-up) — imported here for use by frameControl/parseControl and every message codec below;
// re-exported in the "byte cursor primitives" section further down so `from './moq-wire'` keeps
// working unchanged for every existing external importer.
import { Reader, Writer } from './moq-wire-primitives.ts';

// ── draft-20 constants (base draft-18, uplevel per #212 E0/E1) ─────────────────────────────────────

export const MOQ_DRAFT_VERSION = 20;
/**
 * §3.1 — ALPN-only version negotiation (no integer version in SETUP) for a NATIVE QUIC/WebTransport
 * binding. This relay runs over a single CF Workers WebSocket today (no WebTransport-server API), so
 * this constant is NOT read by any accept/reject path in moq-relay.ts / moq-session-do.ts — there is
 * no TLS ALPN on the wire to negotiate over WS, and message *bodies* are unchanged by the E0 bump (see
 * README "Spec compliance" + PR #212-E0/E1 body for the deploy-safety note: because it is a single
 * hardcoded string with no accept-set here, relay + moq-client (both in this repo) must ship together
 * — one Worker deploy flips both atomically). `MOQ_DRAFT_SUPPORTED` in wrangler.toml is the actual
 * additive negotiation-range advertisement and keeps 18 in the set (see wrangler.toml).
 */
export const MOQ_ALPN = 'moqt-20';

/** Control message type codes — draft-18 §10 (verbatim from the tagged moq-wg/moq-transport source). */
export const MOQ_MSG = {
  SETUP: 0x2f00, // also the unidirectional control stream type
  GOAWAY: 0x10,
  SUBSCRIBE: 0x3,
  SUBSCRIBE_OK: 0x4,
  REQUEST_ERROR: 0x5,
  PUBLISH_NAMESPACE: 0x6, // formerly ANNOUNCE (renamed in an earlier draft)
  REQUEST_OK: 0x7,
  REQUEST_UPDATE: 0x2,
  PUBLISH: 0x1d,
  PUBLISH_DONE: 0xb,
  FETCH: 0x16,
  FETCH_OK: 0x18,
  TRACK_STATUS: 0xd,
  SUBSCRIBE_NAMESPACE: 0x50, // subscriber announces interest in a namespace prefix
  NAMESPACE: 0x8, // sent on the SUBSCRIBE_NAMESPACE response stream
  NAMESPACE_DONE: 0xe,
  // draft-19 #1779 renamed PUBLISH_BLOCKED → PUBLISH_SKIPPED (draft-20 §message-publish-skipped).
  // Constant only in E1 — it answers a SUBSCRIBE_TRACKS (E5 scope), so no encode/decode pair yet.
  PUBLISH_SKIPPED: 0xf,
  // draft-20 #1820 (§ps-notify) — a NEW message, not renamed/moved from an earlier draft. Publisher-
  // initiated, unilateral (no REQUEST_OK/REQUEST_ERROR reply), sent on a subscription's bidi Request
  // stream. Codec lives in moq-wire-publish.ts (#212 E4) — see that file's header.
  PUBLISH_STATE_NOTIFY: 0x22,
} as const;

/** Data-stream header type codes (§11) — distinct number space from control types. */
export const MOQ_STREAM = {
  FETCH_HEADER: 0x5, // unidirectional stream carrying fetched objects
  SUBGROUP_BASE: 0x10, // SUBGROUP_HEADER type byte = SUBGROUP_BASE | flags (see SUBGROUP_FLAG)
} as const;

/** SUBGROUP_HEADER type-byte flag bits — draft-18 §subgroup-header. */
export const SUBGROUP_FLAG = {
  PROPERTIES: 0x01, // per-object Object Properties present
  SUBGROUP_ID_SHIFT: 1, // bits 1-2 = Subgroup ID mode (0=absent/0, 1=absent/first-obj-id, 2=explicit)
  END_OF_GROUP: 0x08, // stream FIN implies largest Object in Group
  DEFAULT_PRIORITY: 0x20, // when set, Publisher Priority field omitted
  FIRST_OBJECT: 0x40, // first object in stream is the publisher's first in the subgroup
} as const;

/** Subgroup ID encoding mode (SUBGROUP_FLAG bits 1-2). 3 is reserved/invalid (PROTOCOL_VIOLATION). */
export const SUBGROUP_ID_MODE = { ZERO: 0, FIRST_OBJECT_ID: 1, EXPLICIT: 2 } as const;

/** Object Status codes — draft-18 §10 ("Object Status"). */
export const MOQ_OBJECT_STATUS = {
  NORMAL: 0x0,
  END_OF_GROUP: 0x3,
  END_OF_TRACK: 0x4,
} as const;

/** REQUEST_ERROR codes — draft-18 IANA table (subset the relay emits). */
export const MOQ_ERROR = {
  INTERNAL_ERROR: 0x0,
  UNAUTHORIZED: 0x1,
  TIMEOUT: 0x2,
  NOT_SUPPORTED: 0x3,
  MALFORMED_AUTH_TOKEN: 0x4,
  EXPIRED_AUTH_TOKEN: 0x5,
  GOING_AWAY: 0x6,
  EXCESSIVE_LOAD: 0x9,
  DOES_NOT_EXIST: 0x10,
  INVALID_RANGE: 0x11,
  UNINTERESTED: 0x20,
} as const;

/**
 * Session Termination error codes — draft-20 §iana-session-termination. A DIFFERENT IANA table from
 * `MOQ_ERROR` (REQUEST_ERROR codes, above): these close the whole session rather than fail one
 * request, so their code space and values are independent (e.g. INTERNAL_ERROR is 0x0 in MOQ_ERROR
 * but 0x1 here). TOO_MANY_REQUEST_UPDATES (draft-19 #1613, code 0x1B) is added here — NOT to
 * MOQ_ERROR — because the spec's own table places it under session termination: a peer that sends a
 * REQUEST_UPDATE past the MAX_REQUEST_UPDATES setup-option credit closes the *session*, not just that
 * request. Only the one code this phase needs is modeled; the rest of the table is future scope.
 */
export const MOQ_SESSION_ERROR = {
  TOO_MANY_REQUEST_UPDATES: 0x1b,
} as const;

/** Role values for the SETUP ROLE option — Publisher / Subscriber / PubSub. */
export const MOQ_ROLE = { PUBLISHER: 0, SUBSCRIBER: 1, PUBSUB: 2 } as const;

/**
 * Thrown by a decoder that detects a wire-level PROTOCOL_VIOLATION (draft-20 §session-termination,
 * error 0x3) — as distinct from a plain truncated/malformed-length `RangeError`. #212 E2 (#1774)
 * introduces the first violation class this codec can detect on its own: an OBJECT_DATAGRAM or
 * SUBGROUP_HEADER Type Flags byte with a set-but-undefined bit. Callers that only care "did this
 * frame parse" can still catch it as an `Error`; callers that need to distinguish a violation from
 * an ordinary truncation (e.g. to decide whether to log/report vs. silently drop) can check
 * `instanceof MoqProtocolViolationError` or `.name === 'MoqProtocolViolationError'`.
 */
export class MoqProtocolViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoqProtocolViolationError';
  }
}

// ── byte cursor primitives ─────────────────────────────────────────────────────────────────────
// Split into `moq-wire-primitives.ts` (#212 file-size follow-up, epic #212) once this module
// crossed the repo's file-size gate; the re-export below keeps every existing `from './moq-wire'`
// import (Writer, Reader) working unchanged. See that file's header for the byte-cursor/varint
// details (moved verbatim, no behavior change) — this file imports the same two classes at the
// top for use by frameControl/parseControl and every message codec below.
export * from './moq-wire-primitives.ts';

// ── control message framing (§10): Type(i) + Length(16) + Message Body ─────────────────────────────
// draft-19 renamed the framed payload from "Message Payload" to "Message Body" (naming only — the
// Type(i) + Length(16) + Body layout is byte-identical).

/** Frame a control message: Type(varint) + Length(16-bit) + Message Body. */
export function frameControl(type: number, body: Uint8Array): Uint8Array {
  if (body.length > 0xffff) throw new RangeError('control message body exceeds 16-bit length');
  return new Writer().varint(type).u16(body.length).raw(body).bytes();
}

/** Parse one framed control message → {type, payload} (payload = the Message Body). */
export function parseControl(bytes: Uint8Array): { type: number; payload: Uint8Array } {
  const r = new Reader(bytes);
  const type = r.varintNum();
  const len = r.u16();
  return { type, payload: r.raw(len) };
}

// ── relay-relevant messages ───────────────────────────────────────────────────────────────────────

export interface SetupMsg {
  role: number; // MOQ_ROLE.*
  maxSubscriptions: bigint;
  path?: string; // SETUP option PATH (0x01)
  /**
   * SETUP option MAX_REQUEST_UPDATES (0x08, draft-19 #1613) — max unacknowledged REQUEST_UPDATE
   * messages per request stream the sender will accept; 0/absent = unlimited. Codec surface only in
   * this phase (E1): the relay does not yet enforce the credit or emit TOO_MANY_REQUEST_UPDATES on
   * breach — that lands with the REQUEST_UPDATE codec itself in E6.
   */
  maxRequestUpdates?: bigint;
}
export function encodeSetup(m: SetupMsg): Uint8Array {
  const w = new Writer().varint(m.role).varint(m.maxSubscriptions);
  // Setup options as count + (code, length-prefixed value) pairs.
  const opts: Array<[number, Uint8Array]> = [];
  if (m.path !== undefined) opts.push([0x01, new TextEncoder().encode(m.path)]);
  if (m.maxRequestUpdates !== undefined) opts.push([0x08, new Writer().varint(m.maxRequestUpdates).bytes()]);
  w.varint(opts.length);
  for (const [code, val] of opts) w.varint(code).bytesLP(val);
  return frameControl(MOQ_MSG.SETUP, w.bytes());
}
export function decodeSetup(payload: Uint8Array): SetupMsg {
  const r = new Reader(payload);
  const role = r.varintNum();
  const maxSubscriptions = r.varint();
  const nOpts = r.varintNum();
  let path: string | undefined;
  let maxRequestUpdates: bigint | undefined;
  for (let i = 0; i < nOpts; i++) {
    const code = r.varintNum();
    const val = r.bytesLP();
    if (code === 0x01) path = new TextDecoder().decode(val);
    else if (code === 0x08) maxRequestUpdates = new Reader(val).varint();
  }
  return { role, maxSubscriptions, path, maxRequestUpdates };
}

// SubscribeMsg / encodeSubscribe / decodeSubscribe moved to `moq-wire-subscribe.ts` (#212 E5) — see
// this file's re-export comment below for why (file-size gate, matches the E2/E3/E4 split pattern).

export interface SubscribeOkMsg {
  requestId: bigint;
  expires: bigint; // ms; 0 = no expiry
}
export function encodeSubscribeOk(m: SubscribeOkMsg): Uint8Array {
  const w = new Writer().varint(m.requestId).varint(m.expires);
  return frameControl(MOQ_MSG.SUBSCRIBE_OK, w.bytes());
}
export function decodeSubscribeOk(payload: Uint8Array): SubscribeOkMsg {
  const r = new Reader(payload);
  return { requestId: r.varint(), expires: r.varint() };
}

export interface RequestOkMsg {
  requestId: bigint;
}
// REQUEST_OK (§10.5) — generic success for request-type messages. Relay-minimal: requestId only
// (the spec's optional Largest-Object / Track-Properties trailers are not modeled — relay subset).
export function encodeRequestOk(m: RequestOkMsg): Uint8Array {
  return frameControl(MOQ_MSG.REQUEST_OK, new Writer().varint(m.requestId).bytes());
}
export function decodeRequestOk(payload: Uint8Array): RequestOkMsg {
  return { requestId: new Reader(payload).varint() };
}

export interface PublishNamespaceMsg {
  requestId: bigint;
  trackNamespace: string[]; // tuple — the namespace the publisher offers
}
// PUBLISH_NAMESPACE (§10.15, was ANNOUNCE) — RequestId(i) + TrackNamespace(tuple) + Params(0).
export function encodePublishNamespace(m: PublishNamespaceMsg): Uint8Array {
  const w = new Writer().varint(m.requestId).tuple(m.trackNamespace).varint(0); // 0 parameters
  return frameControl(MOQ_MSG.PUBLISH_NAMESPACE, w.bytes());
}
export function decodePublishNamespace(payload: Uint8Array): PublishNamespaceMsg {
  const r = new Reader(payload);
  return { requestId: r.varint(), trackNamespace: r.tuple() };
}

export interface RequestErrorMsg {
  requestId: bigint;
  errorCode: number;
  reason: string;
}
export function encodeRequestError(m: RequestErrorMsg): Uint8Array {
  const w = new Writer().varint(m.requestId).varint(m.errorCode).strLP(m.reason);
  return frameControl(MOQ_MSG.REQUEST_ERROR, w.bytes());
}
export function decodeRequestError(payload: Uint8Array): RequestErrorMsg {
  const r = new Reader(payload);
  return { requestId: r.varint(), errorCode: r.varintNum(), reason: r.strLP() };
}

// ── full draft-18 request message set (relay-relevant) ──────────────────────────────────────────────

export interface SubscribeNamespaceMsg {
  requestId: bigint;
  trackNamespacePrefix: string[]; // tuple — the namespace prefix the subscriber is interested in
}
// SUBSCRIBE_NAMESPACE (§message-subscribe-ns, 0x50) — RequestId(i) + Prefix(tuple) + Params(0).
// Ack is the generic REQUEST_OK (0x7); the relay then streams NAMESPACE/NAMESPACE_DONE matches.
export function encodeSubscribeNamespace(m: SubscribeNamespaceMsg): Uint8Array {
  const w = new Writer().varint(m.requestId).tuple(m.trackNamespacePrefix).varint(0);
  return frameControl(MOQ_MSG.SUBSCRIBE_NAMESPACE, w.bytes());
}
export function decodeSubscribeNamespace(payload: Uint8Array): SubscribeNamespaceMsg {
  const r = new Reader(payload);
  return { requestId: r.varint(), trackNamespacePrefix: r.tuple() };
}

export interface PublishMsg {
  requestId: bigint;
  trackNamespace: string[]; // tuple
  trackName: string;
  trackAlias: bigint;
}
// PUBLISH (§message-publish, 0x1D) — publisher-initiated push (vs subscriber-pull SUBSCRIBE).
// RequestId(i) + TrackNamespace(tuple) + TrackName(strLP) + TrackAlias(i) + Params(0) + TrackProps(empty).
// Ack is REQUEST_OK (0x7). We model the relay-relevant head; trailing Track Properties are tolerated.
export function encodePublish(m: PublishMsg): Uint8Array {
  const w = new Writer()
    .varint(m.requestId)
    .tuple(m.trackNamespace)
    .strLP(m.trackName)
    .varint(m.trackAlias)
    .varint(0); // 0 parameters; no Track Properties trailer
  return frameControl(MOQ_MSG.PUBLISH, w.bytes());
}
export function decodePublish(payload: Uint8Array): PublishMsg {
  const r = new Reader(payload);
  return { requestId: r.varint(), trackNamespace: r.tuple(), trackName: r.strLP(), trackAlias: r.varint() };
}

export interface TrackStatusMsg {
  requestId: bigint;
  trackNamespace: string[]; // tuple
  trackName: string;
}
// TRACK_STATUS (§message-track-status, 0xD) — "format identical to SUBSCRIBE". Liveness query.
// Reply is REQUEST_OK (0x7, aliased TRACK_STATUS_OK) on success, REQUEST_ERROR otherwise.
export function encodeTrackStatus(m: TrackStatusMsg): Uint8Array {
  const w = new Writer().varint(m.requestId).tuple(m.trackNamespace).strLP(m.trackName).varint(0);
  return frameControl(MOQ_MSG.TRACK_STATUS, w.bytes());
}
export function decodeTrackStatus(payload: Uint8Array): TrackStatusMsg {
  const r = new Reader(payload);
  return { requestId: r.varint(), trackNamespace: r.tuple(), trackName: r.strLP() };
}

export interface GoawayMsg {
  newSessionUri: string; // "" = reuse current URI (the only client-legal value)
  timeoutMs: bigint; // 0 = no specific timeout
}
// GOAWAY (§message-goaway, 0x10) — graceful drain / migration signal. No reply expected.
// draft-19 #1623 drops the Request ID field: GOAWAY is carried on the control stream (or a request
// stream) and needs no per-message id there, so the wire body is NewSessionUri(strLP) + Timeout(i)
// only. This also removes the WS-envelope trailing-varint special-case decodeGoaway used to carry —
// there is no longer an optional trailing field to detect via `r.remaining`.
export function encodeGoaway(m: GoawayMsg): Uint8Array {
  const w = new Writer().strLP(m.newSessionUri).varint(m.timeoutMs);
  return frameControl(MOQ_MSG.GOAWAY, w.bytes());
}
export function decodeGoaway(payload: Uint8Array): GoawayMsg {
  const r = new Reader(payload);
  const newSessionUri = r.strLP();
  const timeoutMs = r.varint();
  return { newSessionUri, timeoutMs };
}

// ── WebSocket transport envelope ──────────────────────────────────────────────────────────────────
//
// MoQ separates control (a bidi stream) from data (unidi streams / datagrams) by QUIC STREAM. CF
// Workers has no WebTransport *server* API yet, so the relay binds to a single WebSocket today. To
// keep the control/data split on one message-oriented socket we prepend a 1-byte kind tag to every
// frame. This envelope is the ONLY non-spec byte on the wire; strip it and the body is exact draft-18.
// It drops away unchanged when a WebTransport-server binding lands (control→stream, object→datagram).
export const WS_KIND = { CONTROL: 0x00, OBJECT: 0x01 } as const;

export function tagFrame(kind: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 1);
  out[0] = kind & 0xff;
  out.set(body, 1);
  return out;
}
export function untagFrame(bytes: Uint8Array): { kind: number; body: Uint8Array } {
  if (bytes.length < 1) throw new RangeError('empty WS frame');
  return { kind: bytes[0], body: bytes.subarray(1) };
}

// ── object data model (§11) — OBJECT_DATAGRAM + SUBGROUP_HEADER ────────────────────────────────────
// Split into `moq-wire-object.ts` (#212 E2) once this module crossed the repo's file-size gate; the
// re-export below keeps every existing `from './moq-wire'` import (MoqObject, encodeObject,
// decodeObject, SubgroupHeader, subgroupTypeByte, isSubgroupType, encodeSubgroupStream,
// decodeSubgroupStream, DATAGRAM_FLAG, claimsSubgroupType, assertValid*TypeByte, etc.) working
// unchanged. See that file's header for the E2 (#1774) strict-bitfield + datagram-type-byte details.
export * from './moq-wire-object.ts';

// ── FETCH + Message Parameters (§10.13, §5.1.2, §5.1.3) ─────────────────────────────────────────────
// Split into `moq-wire-fetch.ts` (#212 E3) for the same file-size-gate reason as moq-wire-object.ts
// above; the re-export below keeps every existing `from './moq-wire'` import (MoqLocation, FetchMsg,
// encodeFetch, decodeFetch, FetchOkMsg, encodeFetchOk, decodeFetchOk, MOQ_PARAM, LocationFilter,
// encodeLocationFilter, decodeLocationFilter, FillParameters, encodeFillParameters,
// decodeFillParameters) working unchanged. See that file's header for the E3 (#1673/#1809)
// fill-fetch-replaces-Joining-FETCH details.
export * from './moq-wire-fetch.ts';

// ── PUBLISH_STATE_NOTIFY (#ps-notify) ──────────────────────────────────────────────────────────────
// Split into `moq-wire-publish.ts` (#212 E4) — a NEW draft-20 message (#1820), so it never lived in
// this file to begin with; landing it in its own module from day one avoids growing this file further
// past the file-size gate. Re-export keeps a single `from './moq-wire'` import surface (matches E2/E3
// above): PublishStateNotifyMsg, encodePublishStateNotify, decodePublishStateNotify. See that file's
// header for the E4 wire-shape + Message Parameter details.
export * from './moq-wire-publish.ts';

// ── SUBSCRIBE + Location Filter (§message-subscribe-req, §5.1.2) ────────────────────────────────────
// Split into `moq-wire-subscribe.ts` (#212 E5) for the same file-size-gate reason as
// moq-wire-object.ts/moq-wire-fetch.ts/moq-wire-publish.ts above; the re-export below keeps every
// existing `from './moq-wire'` import (SubscribeMsg, encodeSubscribe, decodeSubscribe) working
// unchanged. See that file's header for the E5 range-filter (per-viewport) details.
export * from './moq-wire-subscribe.ts';

// ── REQUEST_UPDATE (§message-request-update) ─────────────────────────────────────────────────────
// New module from day one (#212 E6, same reasoning moq-wire-publish.ts used for PUBLISH_STATE_NOTIFY
// — landing REQUEST_UPDATE's codec here avoids growing this already-over-advisory file further). The
// REQUEST_UPDATE message TYPE CONSTANT itself has lived in MOQ_MSG since E1 (codec surface only, see
// SetupMsg's maxRequestUpdates doc above) — this phase adds the encode/decode pair + relay behavior.
// Re-export keeps a single `from './moq-wire'` import surface: RequestUpdateMsg, encodeRequestUpdate,
// decodeRequestUpdate, REQUEST_UPDATE_PARAM. See that file's header for the E6 wire-shape + Message
// Parameter details and the Request-ID-correlation discrepancy note.
export * from './moq-wire-request-update.ts';
