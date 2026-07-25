/**
 * Unit tests for the non-Worker MoQ interop client (tools/moq-client).
 *
 * The crypto tests are not self-consistency checks — they assert against the RFC 9001 Appendix A
 * test vectors verbatim. That matters more here than usual: the ALPN measurement this client exists
 * to produce is only trustworthy if the packet protection is provably the real thing, so an
 * independent, published expected value is the receipt. A round-trip test would have passed even if
 * the whole key schedule were wrong in a self-consistent way.
 */

import { describe, expect, it } from 'vitest';
import {
  hkdfExpandLabel,
  hkdfExtract,
  initialKeys,
  quicVarint,
  readQuicVarint,
  buildInitialPacket,
  openServerInitial,
} from '../src/quic-crypto.ts';
import { buildClientHello, classifyServerFlight, encodeAlpnExtension } from '../src/tls-hello.ts';
import { classifyFrames, parseFrames } from '../src/quic-alpn.ts';
import { classifyRequestError, makeProbePayload, percentiles, readProbeTimestamp } from '../src/session.ts';
import { MOQ_ALPN_CANDIDATES, resolveTarget } from '../src/targets.ts';
import { redact } from '../cli.ts';

// RFC 9001 Appendix A.1 — "Keys" — the client Initial DCID used for every published vector below.
const RFC9001_DCID = Buffer.from('8394c8f03e515708', 'hex');

describe('QUIC initial keys — RFC 9001 Appendix A.1 vectors', () => {
  it('derives the published initial_secret', () => {
    const salt = Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex');
    expect(hkdfExtract(salt, RFC9001_DCID).toString('hex')).toBe(
      '7db5df06e7a69e432496adedb00851923595221596ae2ae9fb8115c1e9ed0a44',
    );
  });

  it('derives the published client_initial_secret', () => {
    const salt = Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex');
    const initial = hkdfExtract(salt, RFC9001_DCID);
    expect(hkdfExpandLabel(initial, 'client in', 32).toString('hex')).toBe(
      'c00cf151ca5be075ed0ebfb5c80323c42d6b7db67881289af4008f1f6c357aea',
    );
  });

  it('derives the published client key, iv and hp', () => {
    const { client } = initialKeys(RFC9001_DCID);
    expect(client.key.toString('hex')).toBe('1f369613dd76d5467730efcbe3b1a22d');
    expect(client.iv.toString('hex')).toBe('fa044b2f42a3fd3b46fb255c');
    expect(client.hp.toString('hex')).toBe('9f50449e04a0e810283a1e9933adedd2');
  });

  it('derives the published server key, iv and hp', () => {
    const { server } = initialKeys(RFC9001_DCID);
    expect(server.key.toString('hex')).toBe('cf3a5331653c364c88f0f379b6067e37');
    expect(server.iv.toString('hex')).toBe('0ac1493ca1905853b0bba03e');
    expect(server.hp.toString('hex')).toBe('c206b8d9b9f0f37644430b490eeaa314');
  });
});

describe('QUIC varints — RFC 9000 §16', () => {
  it.each([0, 1, 63, 64, 16383, 16384, 1073741823])('round-trips %i', (v) => {
    expect(readQuicVarint(quicVarint(v), 0).value).toBe(v);
  });

  it('uses the RFC-specified encoded lengths', () => {
    expect(quicVarint(37).length).toBe(1);
    expect(quicVarint(15293).length).toBe(2);
    expect(quicVarint(494878333).length).toBe(4);
  });

  it('decodes the RFC §A.1 sample encodings', () => {
    expect(readQuicVarint(Buffer.from('7bbd', 'hex'), 0).value).toBe(15293);
    expect(readQuicVarint(Buffer.from('25', 'hex'), 0).value).toBe(37);
  });

  it('refuses a truncated varint rather than returning a wrong number', () => {
    expect(() => readQuicVarint(Buffer.from('bd', 'hex'), 0)).toThrow(/truncated/);
  });
});

describe('ALPN extension encoding — RFC 7301 §3.1', () => {
  it('encodes a single protocol as len-prefixed inside a u16 block', () => {
    // 0x0003 list length, 0x02 name length, "h3"
    expect(encodeAlpnExtension(['h3']).toString('hex')).toBe('000302' + Buffer.from('h3').toString('hex'));
  });

  it('encodes every offered protocol in order, so the offer is exactly what we claim', () => {
    const hex = encodeAlpnExtension(['moqt-19', 'moqt-18']).toString('hex');
    expect(hex).toContain(Buffer.from('moqt-19').toString('hex'));
    expect(hex).toContain(Buffer.from('moqt-18').toString('hex'));
    expect(hex.indexOf(Buffer.from('moqt-19').toString('hex'))).toBeLessThan(
      hex.indexOf(Buffer.from('moqt-18').toString('hex')),
    );
  });

  it('rejects an empty list and an over-long identifier', () => {
    expect(() => encodeAlpnExtension([])).toThrow(/must not be empty/);
    expect(() => encodeAlpnExtension(['x'.repeat(256)])).toThrow(/invalid ALPN/);
  });
});

describe('ClientHello', () => {
  const hello = (alpns: string[]): Buffer =>
    buildClientHello({
      sni: 'relay.example',
      alpns,
      scid: Buffer.alloc(8, 7),
      x25519PublicKey: Buffer.alloc(32, 9),
    });

  it('is a handshake message of type client_hello with a consistent length prefix', () => {
    const ch = hello(['moqt-18']);
    expect(ch[0]).toBe(0x01);
    expect((ch[1] << 16) | (ch[2] << 8) | ch[3]).toBe(ch.length - 4);
  });

  it('carries an empty legacy_session_id, as QUIC requires (RFC 9001 §8.4)', () => {
    expect(hello(['h3'])[38]).toBe(0x00); // 4 header + 2 version + 32 random
  });

  it('carries the requested ALPN bytes', () => {
    expect(hello(['moqt-16']).toString('hex')).toContain(Buffer.from('moqt-16').toString('hex'));
  });

  it('does not leak an ALPN that was not offered', () => {
    expect(hello(['moqt-16']).toString('hex')).not.toContain(Buffer.from('moqt-18').toString('hex'));
  });
});

describe('server flight classification', () => {
  it('identifies a ServerHello', () => {
    const sh = Buffer.concat([Buffer.from([0x02, 0, 0, 70]), Buffer.from([0x03, 0x03]), Buffer.alloc(32, 1)]);
    expect(classifyServerFlight(sh).kind).toBe('server-hello');
  });

  it('identifies a HelloRetryRequest by its sentinel random, not as a real ServerHello', () => {
    const hrr = Buffer.concat([
      Buffer.from([0x02, 0, 0, 70]),
      Buffer.from([0x03, 0x03]),
      Buffer.from('cf21ad74e59a6111be1d8c021e65b891c2a21167abb8c5e079e09e2c8a8339c', 'hex'),
    ]);
    expect(classifyServerFlight(hrr).kind).toBe('hello-retry-request');
  });
});

describe('frame parsing and ALPN verdicts', () => {
  it('parses a CRYPTO frame', () => {
    const f = parseFrames(Buffer.from([0x06, 0x00, 0x03, 0xaa, 0xbb, 0xcc]));
    expect(f).toEqual([{ kind: 'crypto', offset: 0, data: Buffer.from([0xaa, 0xbb, 0xcc]) }]);
  });

  it('skips PADDING and PING without mis-parsing what follows', () => {
    const f = parseFrames(Buffer.from([0x00, 0x00, 0x01, 0x06, 0x00, 0x01, 0x02]));
    expect(f).toEqual([{ kind: 'crypto', offset: 0, data: Buffer.from([0x02]) }]);
  });

  it('reads a CONNECTION_CLOSE reason phrase', () => {
    // 0x1c, error 0x178 (2-byte varint 0x4178), frame type 0, reason "no"
    const buf = Buffer.concat([Buffer.from([0x1c, 0x41, 0x78, 0x00, 0x02]), Buffer.from('no')]);
    expect(parseFrames(buf)).toEqual([{ kind: 'connection_close', errorCode: 0x178, reason: 'no' }]);
  });

  it('calls alert 120 a REFUSAL — the negative receipt this tool exists to produce', () => {
    const v = classifyFrames([{ kind: 'connection_close', errorCode: 0x178, reason: '' }]);
    expect(v?.outcome).toBe('refused');
    expect(v?.alert).toBe(120);
    expect(v?.evidence).toContain('no_application_protocol');
  });

  it('calls a ServerHello an ACCEPTANCE', () => {
    const sh = Buffer.concat([Buffer.from([0x02, 0, 0, 70]), Buffer.from([0x03, 0x03]), Buffer.alloc(32, 1)]);
    expect(classifyFrames([{ kind: 'crypto', offset: 0, data: sh }])?.outcome).toBe('accepted');
  });

  it('does NOT call handshake_failure a refusal — a different alert is a different finding', () => {
    expect(classifyFrames([{ kind: 'connection_close', errorCode: 0x128, reason: '' }])?.outcome).toBe(
      'handshake-failure',
    );
  });

  it('returns no verdict from an ACK-only flight instead of guessing', () => {
    expect(classifyFrames([{ kind: 'ack' }])).toBeNull();
  });
});

describe('Initial packet protection round-trip', () => {
  it('seals a client Initial and opens it again with the matching keys', () => {
    const dcid = Buffer.alloc(8, 0x11);
    const scid = Buffer.alloc(8, 0x22);
    const keys = initialKeys(dcid);
    const crypto = Buffer.from('deadbeef'.repeat(8), 'hex');
    const packet = buildInitialPacket({ dcid, scid, cryptoData: crypto, keys: keys.client, packetNumber: 0 });

    expect(packet.length).toBe(1200); // RFC 9000 §14.1 anti-amplification minimum
    expect(packet[0] & 0xc0).toBe(0xc0); // long header + fixed bit survive header protection masking

    const opened = openServerInitial(packet, 0, keys.client);
    expect(opened).not.toBeNull();
    expect(parseFrames(opened!.plaintext)[0]).toEqual({ kind: 'crypto', offset: 0, data: crypto });
  });

  it('returns null rather than throwing when the AEAD tag does not verify', () => {
    const dcid = Buffer.alloc(8, 0x11);
    const keys = initialKeys(dcid);
    const packet = buildInitialPacket({
      dcid,
      scid: Buffer.alloc(8, 0x22),
      cryptoData: Buffer.alloc(16, 1),
      keys: keys.client,
      packetNumber: 0,
    });
    expect(openServerInitial(packet, 0, initialKeys(Buffer.alloc(8, 0x33)).client)).toBeNull();
  });

  it('refuses to build a packet whose ClientHello cannot fit', () => {
    const keys = initialKeys(Buffer.alloc(8));
    expect(() =>
      buildInitialPacket({
        dcid: Buffer.alloc(8),
        scid: Buffer.alloc(8),
        cryptoData: Buffer.alloc(4000),
        keys: keys.client,
        packetNumber: 0,
      }),
    ).toThrow(/does not fit/);
  });
});

describe('session reporting', () => {
  it('reports nearest-rank percentiles, so every figure is a measured sample', () => {
    const s = percentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(s).toMatchObject({ count: 10, p50Ms: 50, p95Ms: 100, minMs: 10, maxMs: 100 });
  });

  it('reports nulls rather than zeros when nothing was measured', () => {
    expect(percentiles([])).toEqual({ count: 0, p50Ms: null, p95Ms: null, minMs: null, maxMs: null });
  });

  it('round-trips a probe timestamp and ignores foreign payloads', () => {
    const before = Date.now();
    const ts = readProbeTimestamp(makeProbePayload(64));
    expect(ts).not.toBeNull();
    expect(ts!).toBeGreaterThanOrEqual(before);
    expect(readProbeTimestamp(new Uint8Array(64))).toBeNull(); // no magic -> not timed
    expect(readProbeTimestamp(new Uint8Array(4))).toBeNull(); // too short -> not timed
  });

  it('maps relay errors onto the negative-case taxonomy', () => {
    expect(classifyRequestError(0x2, '')).toBe('auth-rejected');
    expect(classifyRequestError(0x4, '')).toBe('track-not-found');
    expect(classifyRequestError(0x0, 'join token expired')).toBe('auth-rejected');
    expect(classifyRequestError(0x0, 'track not found')).toBe('track-not-found');
    expect(classifyRequestError(0x0, 'something else')).toBe('setup-rejected');
  });
});

describe('targets and credential hygiene', () => {
  it('offers moqt-19 and moqt-18 as candidates so the draft-19 question can be asked', () => {
    expect(MOQ_ALPN_CANDIDATES).toContain('moqt-19');
    expect(MOQ_ALPN_CANDIDATES).toContain('moqt-18');
  });

  it('resolves a built-in id and an ad-hoc host:port', () => {
    expect(resolveTarget('cf-interop').host).toBe('interop-relay.cloudflare.mediaoverquic.com');
    expect(resolveTarget('example.test:4433')).toMatchObject({ host: 'example.test', port: 4433 });
  });

  it('never prints a join token', () => {
    const out = redact('https://relay.example/v1/subscribe/ns/t?join=SECRET_TOKEN_VALUE&x=1');
    expect(out).not.toContain('SECRET_TOKEN_VALUE');
    expect(out).toContain('join=<redacted>');
    expect(out).toContain('x=1');
  });
});
