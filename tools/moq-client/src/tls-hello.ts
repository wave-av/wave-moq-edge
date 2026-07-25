/**
 * TLS 1.3 ClientHello construction and server-flight parsing, for the QUIC ALPN prober.
 *
 * Scope note: this builds a REAL, spec-conformant ClientHello (RFC 8446 §4.1.2) with a caller-chosen
 * ALPN list (RFC 7301) and the QUIC transport-parameters extension (RFC 9001 §8.2), and reads back
 * only what is legible in the Initial packet space: the ServerHello message type and the
 * HelloRetryRequest sentinel. It deliberately does NOT implement the key schedule, so it can never
 * complete a handshake, never sends application data, and never evaluates a certificate — there is no
 * verification step here to weaken.
 */

import { randomBytes } from 'node:crypto';
import { quicVarint } from './quic-crypto.ts';

/** RFC 8446 §4.1.3 — the fixed sentinel value of ServerHello.random for a HelloRetryRequest. */
const HRR_RANDOM = Buffer.from('cf21ad74e59a6111be1d8c021e65b891c2a21167abb8c5e079e09e2c8a8339c', 'hex');

function ext(type: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type >> 8, type & 0xff, body.length >> 8, body.length & 0xff]), body]);
}

function u16Block(body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([body.length >> 8, body.length & 0xff]), body]);
}

/** RFC 9000 §18 — a transport parameter is an (id, length, value) varint triple. */
function tp(id: number, value: Buffer): Buffer {
  return Buffer.concat([quicVarint(id), quicVarint(value.length), value]);
}

/** RFC 7301 §3.1 — ProtocolNameList: a u16-length block of length-prefixed protocol names. */
export function encodeAlpnExtension(alpns: string[]): Buffer {
  if (alpns.length === 0) throw new RangeError('ALPN list must not be empty');
  return u16Block(
    Buffer.concat(
      alpns.map((a) => {
        const b = Buffer.from(a, 'ascii');
        if (b.length === 0 || b.length > 255) throw new RangeError(`invalid ALPN identifier: "${a}"`);
        return Buffer.concat([Buffer.from([b.length]), b]);
      }),
    ),
  );
}

export interface ClientHelloOpts {
  sni: string;
  alpns: string[];
  /** Source Connection ID — MUST be echoed in initial_source_connection_id (RFC 9000 §7.3). */
  scid: Buffer;
  /** Raw 32-byte X25519 public key for the key_share extension. */
  x25519PublicKey: Buffer;
}

export function buildClientHello(o: ClientHelloOpts): Buffer {
  const sniBody = u16Block(Buffer.concat([Buffer.from([0x00]), u16Block(Buffer.from(o.sni, 'ascii'))]));

  const extensions = Buffer.concat([
    ext(0x0000, sniBody), // server_name
    ext(0x000a, u16Block(Buffer.from([0x00, 0x1d, 0x00, 0x17]))), // supported_groups: x25519, secp256r1
    ext(0x000d, u16Block(Buffer.from([0x04, 0x03, 0x08, 0x04, 0x04, 0x01]))), // signature_algorithms
    ext(0x002b, Buffer.from([0x02, 0x03, 0x04])), // supported_versions: TLS 1.3
    ext(0x0033, u16Block(Buffer.concat([Buffer.from([0x00, 0x1d]), u16Block(o.x25519PublicKey)]))), // key_share
    ext(0x0010, encodeAlpnExtension(o.alpns)), // ALPN — the payload this whole tool exists to vary
    ext(
      0x0039, // quic_transport_parameters
      Buffer.concat([
        tp(0x01, quicVarint(30000)), // max_idle_timeout
        tp(0x04, quicVarint(1048576)), // initial_max_data
        tp(0x05, quicVarint(262144)), // initial_max_stream_data_bidi_local
        tp(0x06, quicVarint(262144)), // initial_max_stream_data_bidi_remote
        tp(0x07, quicVarint(262144)), // initial_max_stream_data_uni
        tp(0x08, quicVarint(16)), // initial_max_streams_bidi
        tp(0x09, quicVarint(16)), // initial_max_streams_uni
        tp(0x0f, o.scid), // initial_source_connection_id
      ]),
    ),
  ]);

  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // legacy_version = TLS 1.2
    randomBytes(32),
    Buffer.from([0x00]), // legacy_session_id — MUST be empty over QUIC (RFC 9001 §8.4)
    u16Block(Buffer.from([0x13, 0x01, 0x13, 0x02, 0x13, 0x03])), // AES-128-GCM / AES-256-GCM / ChaCha20
    Buffer.from([0x01, 0x00]), // legacy_compression_methods = null
    u16Block(extensions),
  ]);

  return Buffer.concat([
    Buffer.from([0x01, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ]);
}

export type ServerHelloKind = 'server-hello' | 'hello-retry-request' | 'other';

/** Classify the first TLS handshake message in a CRYPTO frame without deriving handshake keys. */
export function classifyServerFlight(crypto: Buffer): { kind: ServerHelloKind; handshakeType: number } {
  if (crypto.length === 0) return { kind: 'other', handshakeType: -1 };
  const handshakeType = crypto[0];
  if (handshakeType !== 0x02) return { kind: 'other', handshakeType };
  const random = crypto.subarray(6, 38);
  return { kind: random.equals(HRR_RANDOM) ? 'hello-retry-request' : 'server-hello', handshakeType };
}
