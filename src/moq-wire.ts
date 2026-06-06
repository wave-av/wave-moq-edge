/**
 * MoQ Transport wire codec — draft-ietf-moq-transport-18 (2026-05-12).
 *
 * Spec-grounded serialization for the relay-relevant subset of the IETF MoQ Transport wire format.
 * Constants and field layouts read VERBATIM from the moq-wg/moq-transport GitHub source at tag
 * `draft-ietf-moq-transport-18` (not inferred). This module is PURE: bytes in / structs out, no
 * I/O, no platform calls — so it is hermetically unit-testable (see __tests__/moq-wire.test.ts) and
 * transport-independent. The relay (moq-relay.ts) drives it; the Durable Object binds it to a
 * WebSocket today (CF Workers has no WebTransport *server* API yet) — the codec is the part that is
 * portable to WebTransport/QUIC the moment that lands.
 *
 * Wire facts used here, with draft-18 section refs:
 *   §1.4.1  varint: a leading-1-bits length prefix (NOT RFC 9000's 2-bit prefix) — 1..9 byte sizes.
 *   §1.4.2  Track Namespace: a tuple = count(i) followed by N length-prefixed byte fields.
 *   §10     control framing on a bidi request stream: Type(i) + Length(16) + Payload.
 *   §10     control type codes: SETUP=0x2F00, SUBSCRIBE=0x3, SUBSCRIBE_OK=0x4, REQUEST_ERROR=0x5,
 *           PUBLISH_NAMESPACE=0x6, REQUEST_OK=0x7, GOAWAY=0x10.
 *   §11     object model: OBJECT_DATAGRAM + SUBGROUP_HEADER; Object Status 0x0/0x3/0x4.
 */

// ── draft-18 constants (verbatim from the tagged moq-wg/moq-transport markdown) ────────────────────

export const MOQ_DRAFT_VERSION = 18;
export const MOQ_ALPN = 'moqt-18'; // §3.1 — ALPN-only version negotiation (no integer version in SETUP)

/** Control message type codes — draft-18 §10 (verbatim from the tagged moq-wg/moq-transport source). */
export const MOQ_MSG = {
  SETUP: 0x2f00, // also the unidirectional control stream type
  GOAWAY: 0x10,
  SUBSCRIBE: 0x3,
  SUBSCRIBE_OK: 0x4,
  REQUEST_ERROR: 0x5,
  PUBLISH_NAMESPACE: 0x6, // was ANNOUNCE in ≤ draft-17
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

/** FETCH Fetch Type — draft-18 §message-fetch. */
export const MOQ_FETCH_TYPE = { STANDALONE: 0x1, RELATIVE_JOINING: 0x2, ABSOLUTE_JOINING: 0x3 } as const;

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

/** Role values for the SETUP ROLE option — Publisher / Subscriber / PubSub. */
export const MOQ_ROLE = { PUBLISHER: 0, SUBSCRIBER: 1, PUBSUB: 2 } as const;

// ── byte cursor primitives ─────────────────────────────────────────────────────────────────────

/** Growable big-endian byte writer. */
export class Writer {
  private buf: number[] = [];
  bytes(): Uint8Array {
    return new Uint8Array(this.buf);
  }
  u8(v: number): this {
    this.buf.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    this.buf.push((v >> 8) & 0xff, v & 0xff);
    return this;
  }
  raw(b: Uint8Array): this {
    for (const x of b) this.buf.push(x);
    return this;
  }
  /** draft-18 §1.4.1 leading-1-bits varint. Accepts number or bigint; range [0, 2^64). */
  varint(value: number | bigint): this {
    let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    if (v < 0n) throw new RangeError('varint must be non-negative');
    // Smallest size N whose capacity (7N bits for N≤8, 64 for N=9) holds v.
    let n = 9;
    for (let k = 1; k <= 8; k++) {
      if (v < 1n << BigInt(7 * k)) {
        n = k;
        break;
      }
    }
    if (n === 9 && v >= 1n << 64n) throw new RangeError('varint exceeds 2^64-1');
    const out = new Uint8Array(n);
    // Big-endian value into the N-byte field; top N bits of byte0 reserved for the prefix.
    let tmp = v;
    for (let i = n - 1; i >= 0; i--) {
      out[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }
    if (n <= 8) out[0] |= (0xff << (9 - n)) & 0xff; // (n-1) leading ones + terminating zero
    else out[0] = 0xff; // n === 9: all-ones first byte signals the 9-byte form
    return this.raw(out);
  }
  /** Length-prefixed byte string: varint(len) + bytes. */
  bytesLP(b: Uint8Array): this {
    return this.varint(b.length).raw(b);
  }
  /** UTF-8 string as a length-prefixed byte string. */
  strLP(s: string): this {
    return this.bytesLP(new TextEncoder().encode(s));
  }
  /** Track Namespace tuple (§1.4.2): count(i) + N length-prefixed fields. */
  tuple(fields: string[]): this {
    this.varint(fields.length);
    for (const f of fields) this.strLP(f);
    return this;
  }
}

/** Big-endian byte reader over a Uint8Array. */
export class Reader {
  private pos = 0;
  constructor(private readonly b: Uint8Array) {}
  get offset(): number {
    return this.pos;
  }
  get remaining(): number {
    return this.b.length - this.pos;
  }
  u8(): number {
    if (this.pos >= this.b.length) throw new RangeError('read past end (u8)');
    return this.b[this.pos++];
  }
  u16(): number {
    const hi = this.u8();
    const lo = this.u8();
    return (hi << 8) | lo;
  }
  raw(len: number): Uint8Array {
    if (this.pos + len > this.b.length) throw new RangeError('read past end (raw)');
    const out = this.b.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  /** draft-18 §1.4.1 leading-1-bits varint → bigint. */
  varint(): bigint {
    const b0 = this.u8();
    // Count leading 1 bits in b0.
    let lead = 0;
    let probe = b0;
    while (lead < 8 && probe & 0x80) {
      lead++;
      probe = (probe << 1) & 0xff;
    }
    if (lead === 8) {
      // 9-byte form: b0 is all prefix; value is the next 8 bytes big-endian.
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.u8());
      return v;
    }
    const n = lead + 1; // total byte count
    let v = BigInt(b0 & (0xff >> n)); // low (8-n) value bits of byte0
    for (let i = 1; i < n; i++) v = (v << 8n) | BigInt(this.u8());
    return v;
  }
  /** Read a varint as a JS number (throws if it would lose precision). */
  varintNum(): number {
    const v = this.varint();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('varint exceeds safe integer');
    return Number(v);
  }
  bytesLP(): Uint8Array {
    const len = this.varintNum();
    return this.raw(len);
  }
  strLP(): string {
    return new TextDecoder().decode(this.bytesLP());
  }
  tuple(): string[] {
    const count = this.varintNum();
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(this.strLP());
    return out;
  }
}

// ── control message framing (§10): Type(i) + Length(16) + Payload ─────────────────────────────────

/** Frame a control payload: Type(varint) + Length(16-bit) + Payload. */
export function frameControl(type: number, payload: Uint8Array): Uint8Array {
  if (payload.length > 0xffff) throw new RangeError('control payload exceeds 16-bit length');
  return new Writer().varint(type).u16(payload.length).raw(payload).bytes();
}

/** Parse one framed control message → {type, payload}. */
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
}
export function encodeSetup(m: SetupMsg): Uint8Array {
  const w = new Writer().varint(m.role).varint(m.maxSubscriptions);
  // Setup options as count + (code, length-prefixed value) pairs. Only PATH (0x01) when present.
  if (m.path !== undefined) w.varint(1).varint(0x01).strLP(m.path);
  else w.varint(0);
  return frameControl(MOQ_MSG.SETUP, w.bytes());
}
export function decodeSetup(payload: Uint8Array): SetupMsg {
  const r = new Reader(payload);
  const role = r.varintNum();
  const maxSubscriptions = r.varint();
  const nOpts = r.varintNum();
  let path: string | undefined;
  for (let i = 0; i < nOpts; i++) {
    const code = r.varintNum();
    const val = r.bytesLP();
    if (code === 0x01) path = new TextDecoder().decode(val);
  }
  return { role, maxSubscriptions, path };
}

export interface SubscribeMsg {
  requestId: bigint;
  trackNamespace: string[]; // tuple
  trackName: string;
}
export function encodeSubscribe(m: SubscribeMsg): Uint8Array {
  const w = new Writer().varint(m.requestId).tuple(m.trackNamespace).strLP(m.trackName);
  return frameControl(MOQ_MSG.SUBSCRIBE, w.bytes());
}
export function decodeSubscribe(payload: Uint8Array): SubscribeMsg {
  const r = new Reader(payload);
  return { requestId: r.varint(), trackNamespace: r.tuple(), trackName: r.strLP() };
}

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

/** A Group/Object location pair (§location). */
export interface MoqLocation {
  group: bigint;
  object: bigint;
}
export interface FetchMsg {
  requestId: bigint;
  fetchType: number; // MOQ_FETCH_TYPE.*
  // Present iff fetchType === STANDALONE:
  standalone?: { trackNamespace: string[]; trackName: string; start: MoqLocation; end: MoqLocation };
  // Present iff fetchType is a joining type:
  joining?: { joiningRequestId: bigint; joiningStart: bigint };
}
// FETCH (§message-fetch, 0x16) — pull past objects. RequestId(i) + FetchType(i) + variant + Params(0).
export function encodeFetch(m: FetchMsg): Uint8Array {
  const w = new Writer().varint(m.requestId).varint(m.fetchType);
  if (m.fetchType === MOQ_FETCH_TYPE.STANDALONE) {
    if (!m.standalone) throw new RangeError('standalone fetch requires standalone fields');
    const s = m.standalone;
    w.tuple(s.trackNamespace).strLP(s.trackName).varint(s.start.group).varint(s.start.object).varint(s.end.group).varint(s.end.object);
  } else {
    if (!m.joining) throw new RangeError('joining fetch requires joining fields');
    w.varint(m.joining.joiningRequestId).varint(m.joining.joiningStart);
  }
  w.varint(0); // 0 parameters
  return frameControl(MOQ_MSG.FETCH, w.bytes());
}
export function decodeFetch(payload: Uint8Array): FetchMsg {
  const r = new Reader(payload);
  const requestId = r.varint();
  const fetchType = r.varintNum();
  if (fetchType === MOQ_FETCH_TYPE.STANDALONE) {
    const trackNamespace = r.tuple();
    const trackName = r.strLP();
    const start: MoqLocation = { group: r.varint(), object: r.varint() };
    const end: MoqLocation = { group: r.varint(), object: r.varint() };
    return { requestId, fetchType, standalone: { trackNamespace, trackName, start, end } };
  }
  return { requestId, fetchType, joining: { joiningRequestId: r.varint(), joiningStart: r.varint() } };
}

export interface FetchOkMsg {
  endOfTrack: boolean;
  end: MoqLocation; // largest available group/object
}
// FETCH_OK (§message-fetch-ok, 0x18) — first response on the FETCH bidi stream. No Request ID (it is
// implied by the stream). EndOfTrack(8) + EndLocation(i,i) + Params(0) + TrackProps(empty).
export function encodeFetchOk(m: FetchOkMsg): Uint8Array {
  const w = new Writer().u8(m.endOfTrack ? 1 : 0).varint(m.end.group).varint(m.end.object).varint(0);
  return frameControl(MOQ_MSG.FETCH_OK, w.bytes());
}
export function decodeFetchOk(payload: Uint8Array): FetchOkMsg {
  const r = new Reader(payload);
  return { endOfTrack: r.u8() === 1, end: { group: r.varint(), object: r.varint() } };
}

export interface GoawayMsg {
  newSessionUri: string; // "" = reuse current URI (the only client-legal value)
  timeoutMs: bigint; // 0 = no specific timeout
  requestId?: bigint; // present only when carried on the control stream (our WS control envelope)
}
// GOAWAY (§message-goaway, 0x10) — graceful drain / migration signal. No reply expected.
export function encodeGoaway(m: GoawayMsg): Uint8Array {
  const w = new Writer().strLP(m.newSessionUri).varint(m.timeoutMs);
  if (m.requestId !== undefined) w.varint(m.requestId);
  return frameControl(MOQ_MSG.GOAWAY, w.bytes());
}
export function decodeGoaway(payload: Uint8Array): GoawayMsg {
  const r = new Reader(payload);
  const newSessionUri = r.strLP();
  const timeoutMs = r.varint();
  const requestId = r.remaining > 0 ? r.varint() : undefined;
  return { newSessionUri, timeoutMs, requestId };
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

// ── object data model (§11) — OBJECT_DATAGRAM form (one object per frame, ideal for a WS binding) ──

export interface MoqObject {
  trackAlias: bigint;
  groupId: bigint;
  objectId: bigint;
  status: number; // MOQ_OBJECT_STATUS.*
  payload: Uint8Array; // empty when status != NORMAL
}

/**
 * Encode one object as an OBJECT_DATAGRAM (§11.3.1). We always include an explicit Object Status and
 * a length-prefixed payload so the framing is self-describing on a message-oriented transport (WS).
 * Layout: TrackAlias(i) GroupId(i) ObjectId(i) Status(i) PayloadLen(i) Payload.
 */
export function encodeObject(o: MoqObject): Uint8Array {
  return new Writer()
    .varint(o.trackAlias)
    .varint(o.groupId)
    .varint(o.objectId)
    .varint(o.status)
    .bytesLP(o.status === MOQ_OBJECT_STATUS.NORMAL ? o.payload : new Uint8Array(0))
    .bytes();
}
export function decodeObject(bytes: Uint8Array): MoqObject {
  const r = new Reader(bytes);
  const trackAlias = r.varint();
  const groupId = r.varint();
  const objectId = r.varint();
  const status = r.varintNum();
  const payload = r.bytesLP();
  return { trackAlias, groupId, objectId, status, payload };
}

// ── SUBGROUP_HEADER multi-object stream (§subgroup-header) ──────────────────────────────────────────
//
// A subgroup carries MANY objects of one group on a single QUIC unidirectional stream (vs one object
// per OBJECT_DATAGRAM). On the WS binding we carry the whole subgroup as one tagged frame. The stream
// TYPE BYTE is a bitfield (SUBGROUP_BASE | flags); the header fields and per-object layout depend on
// those flags. Object IDs are DELTA-coded (first absolute, rest are deltas) per §subgroup-header.

export interface SubgroupObject {
  objectId: bigint;
  status: number; // MOQ_OBJECT_STATUS.* (only serialized when payload is empty)
  payload: Uint8Array;
}
export interface SubgroupHeader {
  trackAlias: bigint;
  groupId: bigint;
  subgroupId: bigint; // resolved value (see idMode for how it was encoded)
  idMode: number; // SUBGROUP_ID_MODE.* — how subgroupId is carried on the wire
  priority: number; // 0-255; ignored when defaultPriority is set
  defaultPriority: boolean; // omit the Priority field, inherit subscription priority
  endOfGroup: boolean;
  firstObject: boolean;
}

/** Compose the SUBGROUP_HEADER type byte from header flags. */
export function subgroupTypeByte(h: Pick<SubgroupHeader, 'idMode' | 'defaultPriority' | 'endOfGroup' | 'firstObject'>): number {
  if (h.idMode === 3) throw new RangeError('subgroup id mode 3 is reserved/invalid');
  let t = MOQ_STREAM.SUBGROUP_BASE;
  t |= (h.idMode & 0x3) << SUBGROUP_FLAG.SUBGROUP_ID_SHIFT;
  if (h.endOfGroup) t |= SUBGROUP_FLAG.END_OF_GROUP;
  if (h.defaultPriority) t |= SUBGROUP_FLAG.DEFAULT_PRIORITY;
  if (h.firstObject) t |= SUBGROUP_FLAG.FIRST_OBJECT;
  // NOTE: PROPERTIES (0x01) is not emitted — we never attach per-object extension headers.
  return t;
}

/** Is `typeByte` a valid SUBGROUP_HEADER stream type (bit 4 set, id-mode != 3)? */
export function isSubgroupType(typeByte: number): boolean {
  if ((typeByte & 0x10) === 0) return false; // bit 4 must be set
  if ((typeByte & 0xffffff80) !== 0) return false; // only the low 7 bits are defined here
  const idMode = (typeByte >> SUBGROUP_FLAG.SUBGROUP_ID_SHIFT) & 0x3;
  return idMode !== 3; // mode 3 is a PROTOCOL_VIOLATION
}

/** Encode a full subgroup (header + objects) as one frame. Object IDs are delta-coded from the first. */
export function encodeSubgroupStream(h: SubgroupHeader, objects: SubgroupObject[]): Uint8Array {
  const w = new Writer().varint(subgroupTypeByte(h)).varint(h.trackAlias).varint(h.groupId);
  if (h.idMode === SUBGROUP_ID_MODE.EXPLICIT) w.varint(h.subgroupId);
  if (!h.defaultPriority) w.u8(h.priority & 0xff);
  let prev: bigint | null = null;
  for (const o of objects) {
    const delta = prev === null ? o.objectId : o.objectId - prev;
    if (delta < 0n) throw new RangeError('subgroup object ids must be non-decreasing');
    prev = o.objectId;
    w.varint(delta);
    const isNormal = o.status === MOQ_OBJECT_STATUS.NORMAL && o.payload.length > 0;
    if (isNormal) {
      w.varint(o.payload.length).raw(o.payload);
    } else {
      w.varint(0).varint(o.status); // Object Status carried only when payload length is 0
    }
  }
  return w.bytes();
}

/** Decode a subgroup frame → header + objects. Resolves delta-coded object IDs to absolute. */
export function decodeSubgroupStream(bytes: Uint8Array): { header: SubgroupHeader; objects: SubgroupObject[] } {
  const r = new Reader(bytes);
  const typeByte = r.varintNum();
  if (!isSubgroupType(typeByte)) throw new RangeError(`not a subgroup stream type: 0x${typeByte.toString(16)}`);
  const properties = (typeByte & SUBGROUP_FLAG.PROPERTIES) !== 0;
  const idMode = (typeByte >> SUBGROUP_FLAG.SUBGROUP_ID_SHIFT) & 0x3;
  const endOfGroup = (typeByte & SUBGROUP_FLAG.END_OF_GROUP) !== 0;
  const defaultPriority = (typeByte & SUBGROUP_FLAG.DEFAULT_PRIORITY) !== 0;
  const firstObject = (typeByte & SUBGROUP_FLAG.FIRST_OBJECT) !== 0;

  const trackAlias = r.varint();
  const groupId = r.varint();
  let subgroupId = 0n;
  if (idMode === SUBGROUP_ID_MODE.EXPLICIT) subgroupId = r.varint();
  const priority = defaultPriority ? 0 : r.u8();

  const objects: SubgroupObject[] = [];
  let cur: bigint | null = null;
  while (r.remaining > 0) {
    const delta = r.varint();
    cur = cur === null ? delta : cur + delta;
    if (idMode === SUBGROUP_ID_MODE.FIRST_OBJECT_ID && objects.length === 0) subgroupId = cur;
    if (properties) skipObjectProperties(r); // we don't model extension headers; skip them faithfully
    const len = r.varintNum();
    if (len > 0) {
      objects.push({ objectId: cur, status: MOQ_OBJECT_STATUS.NORMAL, payload: r.raw(len) });
    } else {
      const status = r.varintNum();
      objects.push({ objectId: cur, status, payload: new Uint8Array(0) });
    }
  }
  return { header: { trackAlias, groupId, subgroupId, idMode, priority, defaultPriority, endOfGroup, firstObject }, objects };
}

/** Skip a per-object Object Properties block (a length-prefixed extension-header bag). */
function skipObjectProperties(r: Reader): void {
  const len = r.varintNum();
  r.raw(len);
}
