/**
 * QUIC ALPN prober — offers a configurable ALPN list and reports what the peer accepted or refused.
 *
 * WHY THIS EXISTS, AND WHY IT IS HAND-ROLLED
 * ------------------------------------------
 * Every third-party MoQ interop receipt is blocked on one missing thing: a *client* that can offer a
 * chosen ALPN list over native QUIC and report what the peer did with it. No Node runtime available
 * to this repo ships a QUIC client (`node:quic` is not compiled into any installed Node, including
 * v26), and every userland Node WebTransport binding hard-codes ALPN `h3` — which makes it
 * structurally unable to answer "does this relay still offer moqt-18 now that moqt-19 exists?",
 * because over WebTransport the MoQ draft version is negotiated in SETUP, not in ALPN. The ALPN
 * question can only be answered by speaking raw QUIC.
 *
 * Answering it does NOT require a full QUIC stack. ALPN is settled in the very first flight, and the
 * QUIC *Initial* packet space is protected with keys derived from a PUBLIC, spec-fixed salt and the
 * client-chosen Destination Connection ID (RFC 9001 §5.2). So with node:crypto and node:dgram alone a
 * client can send a real Initial carrying a real TLS 1.3 ClientHello, and fully decrypt the server's
 * Initial reply.
 *
 * WHAT WE CAN AND CANNOT OBSERVE — stated precisely, because the receipt depends on it
 * ------------------------------------------------------------------------------------
 * The *negotiated* ALPN travels in EncryptedExtensions, in the Handshake packet space, which requires
 * the full TLS key schedule to read. We do not implement that.
 * The *refusal* travels in the Initial space and is fully legible: a server with no overlapping ALPN
 * MUST abort with TLS alert 120 `no_application_protocol` (RFC 7301 §3.2), which QUIC carries as
 * CONNECTION_CLOSE with transport error 0x0178 (CRYPTO_ERROR 0x0100 + 120) (RFC 9001 §4.8).
 *
 * Hence: probe exactly ONE ALPN at a time. With a single-element offer the inference is total.
 *   CONNECTION_CLOSE 0x0178  → that ALPN was REFUSED (nothing else could have been chosen).
 *   ServerHello, no alert    → that ALPN was ACCEPTED (it was the only thing on offer).
 * A joint multi-ALPN probe is also supported, but it reports accept/refuse only as a SET and
 * deliberately refuses to name a winner it cannot read. Naming one would be a guess, and replacing
 * guesses with observations is the entire point of this instrument.
 *
 * The `h3` control probe is the methodological backbone: h3 is supported by any QUIC server worth
 * probing, so an h3 ACCEPT on this same code path proves both that the endpoint is live and that the
 * prober works. A moqt-* refusal is a finding about the relay ONLY when the control passed beside it.
 *
 * No TLS verification is weakened: no handshake is completed, no application data is sent, and no
 * certificate is ever accepted.
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { buildInitialPacket, initialKeys, openServerInitial, readQuicVarint } from './quic-crypto.ts';
import { buildClientHello, classifyServerFlight } from './tls-hello.ts';

/** RFC 9001 §4.8 — TLS alerts ride as CRYPTO_ERROR (0x0100) + the alert description. */
const CRYPTO_ERROR_BASE = 0x0100;
const ALERT_NO_APPLICATION_PROTOCOL = 120;
const ALERT_HANDSHAKE_FAILURE = 40;

export type ServerFrame =
  | { kind: 'crypto'; offset: number; data: Buffer }
  | { kind: 'connection_close'; errorCode: number; reason: string }
  | { kind: 'ack' }
  | { kind: 'other'; type: number };

/** RFC 9000 §19 — parse the Initial-space frame subset that carries an ALPN verdict. */
export function parseFrames(buf: Buffer): ServerFrame[] {
  const out: ServerFrame[] = [];
  let i = 0;
  while (i < buf.length) {
    const t = buf[i];
    if (t === 0x00 || t === 0x01) {
      i++; // PADDING / PING
      continue;
    }
    if (t === 0x02 || t === 0x03) {
      // ACK / ACK_ECN
      i++;
      const largest = readQuicVarint(buf, i);
      const delay = readQuicVarint(buf, largest.next);
      const count = readQuicVarint(buf, delay.next);
      let p = readQuicVarint(buf, count.next).next; // first ack range
      for (let r = 0; r < count.value; r++) p = readQuicVarint(buf, readQuicVarint(buf, p).next).next;
      if (t === 0x03) for (let e = 0; e < 3; e++) p = readQuicVarint(buf, p).next; // ECN counts
      i = p;
      out.push({ kind: 'ack' });
      continue;
    }
    if (t === 0x06) {
      // CRYPTO
      i++;
      const offset = readQuicVarint(buf, i);
      const length = readQuicVarint(buf, offset.next);
      out.push({
        kind: 'crypto',
        offset: offset.value,
        data: Buffer.from(buf.subarray(length.next, length.next + length.value)),
      });
      i = length.next + length.value;
      continue;
    }
    if (t === 0x1c || t === 0x1d) {
      // CONNECTION_CLOSE (transport / application)
      i++;
      const code = readQuicVarint(buf, i);
      let p = code.next;
      if (t === 0x1c) p = readQuicVarint(buf, p).next; // offending frame type
      const rl = readQuicVarint(buf, p);
      out.push({
        kind: 'connection_close',
        errorCode: code.value,
        reason: buf.subarray(rl.next, rl.next + rl.value).toString('utf8'),
      });
      i = rl.next + rl.value;
      continue;
    }
    out.push({ kind: 'other', type: t });
    break; // unknown frame — stop rather than mis-parse the rest
  }
  return out;
}

export type AlpnOutcome =
  | 'accepted'
  | 'refused'
  | 'handshake-failure'
  | 'unreachable'
  | 'version-negotiation'
  | 'retry-exhausted'
  | 'protocol-error';

export interface AlpnProbeResult {
  host: string;
  port: number;
  sni: string;
  offered: string[];
  /** The single ALPN this probe isolates, or null for a joint (multi-ALPN) offer. */
  isolated: string | null;
  outcome: AlpnOutcome;
  /** The exact wire observation the outcome was read from — never an inference beyond it. */
  evidence: string;
  transportErrorCode?: number;
  tlsAlert?: number;
  closeReason?: string;
  rttMs: number | null;
  retried: boolean;
  observedAt: string;
}

export interface ProbeOpts {
  host: string;
  port?: number;
  sni?: string;
  timeoutMs?: number;
}

interface Verdict {
  outcome: AlpnOutcome;
  evidence: string;
  alert?: number;
  code?: number;
  reason?: string;
}

export function classifyFrames(frames: ServerFrame[]): Verdict | null {
  for (const f of frames) {
    if (f.kind === 'connection_close') {
      const alert =
        f.errorCode >= CRYPTO_ERROR_BASE && f.errorCode <= CRYPTO_ERROR_BASE + 255
          ? f.errorCode - CRYPTO_ERROR_BASE
          : undefined;
      const hex = `0x${f.errorCode.toString(16)}`;
      const tail = f.reason ? ` reason="${f.reason}"` : '';
      if (alert === ALERT_NO_APPLICATION_PROTOCOL) {
        return {
          outcome: 'refused',
          evidence: `CONNECTION_CLOSE ${hex} = CRYPTO_ERROR + TLS alert 120 no_application_protocol${tail}`,
          alert,
          code: f.errorCode,
          reason: f.reason,
        };
      }
      if (alert === ALERT_HANDSHAKE_FAILURE) {
        return {
          outcome: 'handshake-failure',
          evidence: `CONNECTION_CLOSE ${hex} = CRYPTO_ERROR + TLS alert 40 handshake_failure${tail}`,
          alert,
          code: f.errorCode,
          reason: f.reason,
        };
      }
      return {
        outcome: 'protocol-error',
        evidence: `CONNECTION_CLOSE ${hex}${alert !== undefined ? ` (TLS alert ${alert})` : ''}${tail}`,
        alert,
        code: f.errorCode,
        reason: f.reason,
      };
    }
    if (f.kind === 'crypto' && f.data.length > 0) {
      const { kind, handshakeType } = classifyServerFlight(f.data);
      if (kind === 'server-hello') {
        return {
          outcome: 'accepted',
          evidence: 'ServerHello returned with no TLS alert — the sole offered ALPN was selected',
        };
      }
      if (kind === 'hello-retry-request') {
        return {
          outcome: 'protocol-error',
          evidence: 'HelloRetryRequest (key_share group mismatch — not an ALPN result)',
        };
      }
      return {
        outcome: 'protocol-error',
        evidence: `unexpected TLS handshake message type 0x${handshakeType.toString(16)}`,
      };
    }
  }
  return null; // ACK/PADDING only — nothing conclusive
}

/**
 * Send one Initial carrying `alpns` and read the server's Initial reply.
 * `alpns.length === 1` is the mode that yields an unambiguous per-ALPN verdict.
 */
export async function probeAlpnOffer(alpns: string[], opts: ProbeOpts): Promise<AlpnProbeResult> {
  const port = opts.port ?? 443;
  const sni = opts.sni ?? opts.host;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const base = {
    host: opts.host,
    port,
    sni,
    offered: alpns,
    isolated: alpns.length === 1 ? alpns[0] : null,
    observedAt: new Date().toISOString(),
  };

  const { publicKey } = generateKeyPairSync('x25519');
  const x25519PublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

  // Annotated as the general Buffer type: a Retry reassigns this from a subarray of the reply.
  let dcid: Buffer = randomBytes(8);
  const scid = randomBytes(8);
  let retried = false;
  const started = process.hrtime.bigint();
  const sock: Socket = createSocket('udp4');

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const keys = initialKeys(dcid);
      const ch = buildClientHello({ sni, alpns, scid, x25519PublicKey });
      const packet = buildInitialPacket({ dcid, scid, cryptoData: ch, keys: keys.client, packetNumber: 0 });

      // Peers legitimately split the first flight across several datagrams (Cloudflare's edge, for
      // example, sends an ACK-only Initial first and the ServerHello/alert in a later datagram), so
      // keep reading until a verdict appears or the budget runs out. Stopping at the first datagram
      // would misreport a live peer as inconclusive.
      const collector = collectDatagrams(sock, timeoutMs);
      let rttMs: number | null = null;
      let sawAnything = false;
      let openFailed = false;
      let retryTarget: Buffer | null = null;

      await sendPacket(sock, packet, opts.host, port);

      for await (const reply of collector.stream()) {
        rttMs ??= Number(process.hrtime.bigint() - started) / 1e6;
        sawAnything = true;
        if (reply.length < 7) continue;

        if (reply.readUInt32BE(1) === 0) {
          collector.stop();
          return {
            ...base,
            outcome: 'version-negotiation',
            evidence: 'Version Negotiation packet — the peer does not offer QUIC v1',
            rttMs,
            retried,
          };
        }
        if (((reply[0] & 0x30) >> 4) === 0x03) {
          // Retry (RFC 9000 §17.2.5): adopt the Retry SCID as the new DCID and re-send once.
          const dcidLen = reply[5];
          const scidLen = reply[6 + dcidLen];
          retryTarget = Buffer.from(reply.subarray(7 + dcidLen, 7 + dcidLen + scidLen));
          collector.stop();
          break;
        }

        // Walk coalesced long-header packets; only the Initial space opens with these keys.
        const frames: ServerFrame[] = [];
        let off = 0;
        let opened = 0;
        while (off < reply.length && (reply[off] & 0x80) !== 0) {
          const pkt = openServerInitial(reply, off, keys.server);
          if (!pkt) break;
          opened++;
          frames.push(...parseFrames(pkt.plaintext));
          off = pkt.next;
        }
        if (opened === 0) {
          openFailed = true;
          continue;
        }
        const verdict = classifyFrames(frames);
        if (!verdict) continue; // ACK-only datagram — keep listening for the rest of the flight
        collector.stop();
        return {
          ...base,
          outcome: verdict.outcome,
          evidence: verdict.evidence,
          transportErrorCode: verdict.code,
          tlsAlert: verdict.alert,
          closeReason: verdict.reason,
          rttMs,
          retried,
        };
      }

      if (retryTarget) {
        dcid = retryTarget;
        retried = true;
        if (attempt === 1) {
          return { ...base, outcome: 'retry-exhausted', evidence: 'peer issued a second Retry packet', rttMs, retried };
        }
        continue;
      }
      if (!sawAnything) {
        return {
          ...base,
          outcome: 'unreachable',
          evidence: `no QUIC Initial response within ${timeoutMs} ms (UDP ${opts.host}:${port})`,
          rttMs: null,
          retried,
        };
      }
      return {
        ...base,
        outcome: 'protocol-error',
        evidence: openFailed
          ? 'peer replied but nothing opened with QUIC v1 Initial keys (not a QUIC v1 endpoint)'
          : `peer replied with ACK/PADDING only — no ServerHello and no alert within ${timeoutMs} ms`,
        rttMs,
        retried,
      };
    }
    return { ...base, outcome: 'retry-exhausted', evidence: 'retry loop exhausted', rttMs: null, retried };
  } finally {
    sock.close();
  }
}

function sendPacket(sock: Socket, packet: Buffer, host: string, port: number): Promise<void> {
  return new Promise((resolve) => {
    sock.send(packet, port, host, () => resolve()); // a send error surfaces as a read timeout below
  });
}

interface DatagramCollector {
  stream: () => AsyncGenerator<Buffer>;
  stop: () => void;
}

/** Yield every UDP datagram that arrives within the budget, until `stop()` or the deadline. */
function collectDatagrams(sock: Socket, timeoutMs: number): DatagramCollector {
  const queue: Buffer[] = [];
  let waiter: (() => void) | null = null;
  let closed = false;

  const wake = (): void => {
    const w = waiter;
    waiter = null;
    w?.();
  };
  const onMessage = (msg: Buffer): void => {
    queue.push(msg);
    wake();
  };
  const onError = (): void => stop();
  const stop = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    sock.removeListener('message', onMessage);
    sock.removeListener('error', onError);
    wake();
  };
  const timer = setTimeout(stop, timeoutMs);
  sock.on('message', onMessage);
  sock.on('error', onError);

  async function* stream(): AsyncGenerator<Buffer> {
    for (;;) {
      while (queue.length > 0) yield queue.shift() as Buffer;
      if (closed) return;
      await new Promise<void>((r) => {
        waiter = r;
      });
    }
  }
  return { stream, stop };
}

/**
 * Probe each ALPN in isolation (the unambiguous mode), plus one joint offer of the whole list.
 * `control` ALPNs (default `h3`) prove the endpoint is a live QUIC server and that the prober works;
 * without a passing control, a refusal is not attributable to the peer.
 */
export async function probeAlpnMatrix(
  alpns: string[],
  opts: ProbeOpts & { joint?: boolean; control?: string[] },
): Promise<AlpnProbeResult[]> {
  const results: AlpnProbeResult[] = [];
  for (const a of [...(opts.control ?? ['h3']), ...alpns]) {
    results.push(await probeAlpnOffer([a], opts));
  }
  if (opts.joint !== false && alpns.length > 1) results.push(await probeAlpnOffer(alpns, opts));
  return results;
}
