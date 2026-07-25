/**
 * QUIC v1 Initial-space packet protection — RFC 9000 §16/§17 + RFC 9001 §5.
 *
 * This is the crypto substrate for the ALPN prober (see quic-alpn.ts for the WHY). It implements
 * exactly the subset needed to send a client Initial packet and decrypt the server's Initial reply:
 * the TLS 1.3 HKDF ladder, the fixed-salt initial key derivation, QUIC varints, AEAD packet
 * protection and header protection. Nothing here is a security boundary — the Initial keys are
 * derived from a PUBLIC salt and a connection ID that travels in the clear, exactly as the RFC
 * specifies. Initial-space confidentiality is not a property QUIC claims.
 */

import { createHmac, createCipheriv, createDecipheriv } from 'node:crypto';

/** RFC 9001 §5.2 — QUIC v1 initial salt (verbatim from the RFC). */
const INITIAL_SALT = Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex');
export const QUIC_V1 = 0x00000001;
const AUTH_TAG_LEN = 16; // AEAD_AES_128_GCM full tag — RFC 9001 §5.3 forbids truncation.

// ── HKDF (RFC 5869) + TLS 1.3 HKDF-Expand-Label (RFC 8446 §7.1) ────────────────────────────────────

export function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac('sha256', salt).update(ikm).digest();
}

/** Single-round HKDF-Expand — every output here is <= 32 bytes, so one HMAC round suffices. */
export function hkdfExpandLabel(secret: Buffer, label: string, length: number): Buffer {
  const full = Buffer.from(`tls13 ${label}`, 'ascii');
  const info = Buffer.concat([
    Buffer.from([(length >> 8) & 0xff, length & 0xff]),
    Buffer.from([full.length]),
    full,
    Buffer.from([0x00]), // zero-length context
  ]);
  return createHmac('sha256', secret)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest()
    .subarray(0, length);
}

export interface PacketKeys {
  key: Buffer; // AEAD_AES_128_GCM
  iv: Buffer;
  hp: Buffer; // header-protection key
}

/** RFC 9001 §5.2 — both directions' Initial keys derive from the client's original DCID. */
export function initialKeys(dcid: Buffer): { client: PacketKeys; server: PacketKeys } {
  const initialSecret = hkdfExtract(INITIAL_SALT, dcid);
  const side = (label: string): PacketKeys => {
    const s = hkdfExpandLabel(initialSecret, label, 32);
    return {
      key: hkdfExpandLabel(s, 'quic key', 16),
      iv: hkdfExpandLabel(s, 'quic iv', 12),
      hp: hkdfExpandLabel(s, 'quic hp', 16),
    };
  };
  return { client: side('client in'), server: side('server in') };
}

// ── RFC 9000 §16 — variable-length integers (2-bit prefix; NOT the MoQ varint in src/moq-wire.ts) ──

export function quicVarint(value: number): Buffer {
  if (value < 0x40) return Buffer.from([value]);
  if (value < 0x4000) return Buffer.from([0x40 | (value >> 8), value & 0xff]);
  if (value < 0x40000000) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value >>> 0);
    b[0] |= 0x80;
    return b;
  }
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(value));
  b[0] |= 0xc0;
  return b;
}

export function readQuicVarint(buf: Buffer, off: number): { value: number; next: number } {
  if (off >= buf.length) throw new RangeError('varint past end of buffer');
  const len = 1 << (buf[off] >> 6);
  if (off + len > buf.length) throw new RangeError('varint truncated');
  let v = buf[off] & 0x3f;
  for (let i = 1; i < len; i++) v = v * 256 + buf[off + i];
  return { value: v, next: off + len };
}

// ── packet protection (RFC 9001 §5.3 AEAD, §5.4 header protection) ────────────────────────────────

export function aeadNonce(iv: Buffer, packetNumber: number): Buffer {
  const nonce = Buffer.from(iv);
  const pn = Buffer.alloc(8);
  pn.writeBigUInt64BE(BigInt(packetNumber));
  for (let i = 0; i < 8; i++) nonce[nonce.length - 8 + i] ^= pn[i];
  return nonce;
}

/**
 * RFC 9001 §5.4.3 mandates AES-ECB over a 16-byte ciphertext sample for AES-based header protection.
 * ECB is correct and required here: it is applied to a single block of already-encrypted material to
 * derive a five-byte mask, never to plaintext, so the usual ECB structure-leak does not apply.
 * (semgrep/lint ECB warnings on this line are expected and are a false positive for this use.)
 */
export function headerMask(hp: Buffer, sample: Buffer): Buffer {
  const c = createCipheriv('aes-128-ecb', hp, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(sample), c.final()]);
}

export function seal(keys: PacketKeys, packetNumber: number, header: Buffer, payload: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-gcm', keys.key, aeadNonce(keys.iv, packetNumber), {
    authTagLength: AUTH_TAG_LEN,
  });
  cipher.setAAD(header);
  return Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
}

/** Returns null when the AEAD tag does not verify (wrong keys / not our packet) — never throws. */
export function open(keys: PacketKeys, packetNumber: number, header: Buffer, body: Buffer): Buffer | null {
  if (body.length < AUTH_TAG_LEN) return null;
  const tag = body.subarray(body.length - AUTH_TAG_LEN);
  const ct = body.subarray(0, body.length - AUTH_TAG_LEN);
  try {
    const d = createDecipheriv('aes-128-gcm', keys.key, aeadNonce(keys.iv, packetNumber), {
      authTagLength: AUTH_TAG_LEN,
    });
    d.setAAD(header);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    return null;
  }
}

export interface InitialPacketOpts {
  dcid: Buffer;
  scid: Buffer;
  cryptoData: Buffer;
  keys: PacketKeys;
  packetNumber: number;
  datagramSize?: number;
}

/** Build one protected client Initial, padded to the RFC 9000 §14.1 anti-amplification minimum. */
export function buildInitialPacket(o: InitialPacketOpts): Buffer {
  const size = o.datagramSize ?? 1200;
  const pnLen = 4;
  const cryptoFrame = Buffer.concat([
    Buffer.from([0x06]), // CRYPTO frame
    quicVarint(0), // offset
    quicVarint(o.cryptoData.length),
    o.cryptoData,
  ]);

  const headerLen = 1 + 4 + 1 + o.dcid.length + 1 + o.scid.length + 1 + 2 + pnLen;
  const payloadLen = size - headerLen - AUTH_TAG_LEN;
  if (payloadLen < cryptoFrame.length) throw new RangeError('ClientHello does not fit in one Initial packet');
  const payload = Buffer.concat([cryptoFrame, Buffer.alloc(payloadLen - cryptoFrame.length)]); // PADDING

  const lengthField = payloadLen + pnLen + AUTH_TAG_LEN;
  const pnBuf = Buffer.alloc(4);
  pnBuf.writeUInt32BE(o.packetNumber);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(QUIC_V1);

  const header = Buffer.concat([
    Buffer.from([0xc0 | (pnLen - 1)]), // long header | fixed bit | Initial | pn length
    version,
    Buffer.from([o.dcid.length]),
    o.dcid,
    Buffer.from([o.scid.length]),
    o.scid,
    quicVarint(0), // token length
    Buffer.from([0x40 | ((lengthField >> 8) & 0x3f), lengthField & 0xff]), // 2-byte varint
    pnBuf,
  ]);

  const packet = Buffer.concat([header, seal(o.keys, o.packetNumber, header, payload)]);
  const pnOffset = header.length - pnLen;
  const mask = headerMask(o.keys.hp, packet.subarray(pnOffset + 4, pnOffset + 20));
  packet[0] ^= mask[0] & 0x0f; // long header: mask the low 4 bits
  for (let i = 0; i < pnLen; i++) packet[pnOffset + i] ^= mask[1 + i];
  return packet;
}

/**
 * Un-protect and decrypt one server Initial packet starting at `off`.
 * Returns the decrypted frame payload and the offset of the next coalesced packet.
 */
export function openServerInitial(
  dgram: Buffer,
  off: number,
  keys: PacketKeys,
): { plaintext: Buffer; next: number } | null {
  let p = off + 1 + 4; // first byte + version
  if (p >= dgram.length) return null;
  const dcidLen = dgram[p++];
  p += dcidLen;
  if (p >= dgram.length) return null;
  const scidLen = dgram[p++];
  p += scidLen;
  let tok: { value: number; next: number };
  let len: { value: number; next: number };
  try {
    tok = readQuicVarint(dgram, p);
    len = readQuicVarint(dgram, tok.next + tok.value);
  } catch {
    return null;
  }
  const pnOffset = len.next;
  const packetEnd = pnOffset + len.value;
  if (packetEnd > dgram.length || pnOffset + 20 > dgram.length) return null;

  const mask = headerMask(keys.hp, dgram.subarray(pnOffset + 4, pnOffset + 20));
  const first = dgram[off] ^ (mask[0] & 0x0f);
  const pnLen = (first & 0x03) + 1;

  const header = Buffer.from(dgram.subarray(off, pnOffset + pnLen));
  header[0] = first;
  let pn = 0;
  for (let i = 0; i < pnLen; i++) {
    header[header.length - pnLen + i] ^= mask[1 + i];
    pn = pn * 256 + header[header.length - pnLen + i];
  }

  const plaintext = open(keys, pn, header, dgram.subarray(pnOffset + pnLen, packetEnd));
  return plaintext ? { plaintext, next: packetEnd } : null;
}
