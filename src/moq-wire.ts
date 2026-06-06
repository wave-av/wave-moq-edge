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

/** Control message type codes — draft-18 §10. */
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
  TRACK_STATUS: 0xd,
} as const;

/** Object Status codes — draft-18 §10 ("Object Status"). */
export const MOQ_OBJECT_STATUS = {
  NORMAL: 0x0,
  END_OF_GROUP: 0x3,
  END_OF_TRACK: 0x4,
} as const;

/** REQUEST_ERROR codes — draft-18 §15.10 (subset the relay emits). */
export const MOQ_ERROR = {
  INTERNAL_ERROR: 0x0,
  UNAUTHORIZED: 0x1,
  TIMEOUT: 0x2,
  NOT_SUPPORTED: 0x3,
  DOES_NOT_EXIST: 0x10,
  INVALID_RANGE: 0x11,
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
    const v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
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
