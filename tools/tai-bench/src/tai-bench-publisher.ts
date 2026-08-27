/**
 * TAI bench publisher — E1-TAI-BRIDGE P4: "Exercise the mapping over a real socket at low rate,
 * without turning the bench into an ingress path anyone can write through."
 *
 * SCOPE. This is a LOOPBACK-ONLY bench tool for locally exercising `groupIdForInstant` +
 * `encodeSt2110TimingProperties` over a real UDP socket, at low rate, in this build's
 * no-external-contact / no-prod-publish phase. It is explicitly NOT the production relay's publish
 * path (`moq-relay.ts` / `moq-join-verify.ts` / `wave-auth.ts` own that, with the gateway-issued
 * `wave-token-v1` bearer scheme this bench deliberately imitates the SHAPE of but does not attach
 * to). The named, honest gap: this bench's authorization is a local shared-secret gate, NOT a
 * gateway-verified JWT — wiring it to the real `moq-join-verify.ts` path is future work for
 * whichever phase turns this bench into a real ingress path. Until then, the fail-closed contract
 * below is what stands between "loopback bench" and "unauthenticated write anyone can reach".
 *
 * FAIL-CLOSED CONTRACT. `publishBenchObject` calls `requireBenchAuthToken` BEFORE constructing or
 * sending any bytes. A missing, malformed, or wrong-scope token throws synchronously and the
 * function returns without touching the socket — proven by `__tests__/tai-bench-auth.test.ts` via a
 * send-call counter on the underlying socket, not by code review.
 */
import { createSocket, type Socket } from 'node:dgram';
import { timingSafeEqual } from 'node:crypto';
import { Writer } from '../../../src/moq-wire.ts';
import type { St2110TimingMeta } from '../../../src/st2110-timing-properties.ts';
import { encodeSt2110TimingProperties } from '../../../src/st2110-timing-properties.ts';

/** The bearer scheme this bench imitates the shape of — same prefix wave-auth.ts's production
 *  gate expects (`wave-token-v1.<opaque>`), scoped to a bench-only literal so a real production
 *  token can never accidentally satisfy this local gate, and vice versa. */
export const BENCH_AUTH_SCOPE = 'moq:bench:tai-e1' as const;
const BENCH_TOKEN_PREFIX = 'wave-token-v1.';

export class BenchAuthError extends Error {
  constructor(detail: string) {
    super(`bench publish refused: ${detail}`);
    this.name = 'BenchAuthError';
  }
}

/**
 * Fail-closed bearer check: a well-formed `wave-token-v1.<opaque>` token whose opaque body
 * constant-time-equals the expected bench secret. Any other input — undefined, wrong prefix, wrong
 * body, wrong length — throws `BenchAuthError`. There is no code path in this function that returns
 * normally without either throwing or having verified equality.
 */
export function requireBenchAuthToken(token: string | undefined, expectedSecret: string): void {
  if (!token) throw new BenchAuthError('missing Authorization bearer token');
  if (!token.startsWith(BENCH_TOKEN_PREFIX)) throw new BenchAuthError('malformed bench token (wrong prefix)');
  const body = token.slice(BENCH_TOKEN_PREFIX.length);
  const a = Buffer.from(body, 'utf8');
  const b = Buffer.from(expectedSecret, 'utf8');
  // timingSafeEqual throws on length mismatch — treat that as "not equal", not a crash.
  const equal = a.length === b.length && timingSafeEqual(a, b);
  if (!equal) throw new BenchAuthError('bench token does not match the configured bench secret');
}

export interface BenchObjectInput {
  trackAlias: bigint;
  objectId: bigint;
  groupId: bigint;
  payload: Uint8Array;
  timing: St2110TimingMeta;
}

/** Encode a bench MoQ object datagram: standard OBJECT_DATAGRAM layout with the ST 2110 timing
 *  property bag attached (see moq-wire.ts `encodeObject` for the base layout this mirrors). */
export function encodeBenchObject(input: BenchObjectInput): Uint8Array {
  const properties = encodeSt2110TimingProperties(input.timing);
  const w = new Writer()
    .varint(input.trackAlias)
    .varint(input.groupId)
    .varint(input.objectId)
    .varint(0) // MOQ_OBJECT_STATUS.NORMAL
    .bytesLP(input.payload);
  if (properties.length > 0) w.bytesLP(properties);
  return w.bytes();
}

export interface PublishOptions {
  token: string | undefined;
  expectedSecret: string;
  host: string; // MUST be a loopback address — see assertLoopbackOnly
  port: number;
}

/** Refuse anything that is not unambiguously loopback. Defense in depth alongside the auth gate:
 *  even a validly-authorized bench MUST NOT be pointed at a non-loopback address by this function. */
export function assertLoopbackOnly(host: string): void {
  const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
  if (!LOOPBACK.has(host)) {
    throw new BenchAuthError(`refusing non-loopback bench target host=${JSON.stringify(host)}`);
  }
}

/**
 * Publish one bench object over a real UDP socket to a loopback address, at whatever rate the
 * caller drives this function at (the bench script below calls it in a low-rate loop). Auth and
 * loopback checks run BEFORE the socket is touched; either failing means `sock.send` is never
 * called, which is exactly what the negative test asserts via a call-count spy.
 */
export function publishBenchObject(sock: Pick<Socket, 'send'>, input: BenchObjectInput, opts: PublishOptions): void {
  requireBenchAuthToken(opts.token, opts.expectedSecret); // throws before any I/O
  assertLoopbackOnly(opts.host); // throws before any I/O
  const bytes = encodeBenchObject(input);
  sock.send(bytes, opts.port, opts.host);
}

/** Convenience factory — real dgram socket, for the bench CLI script (not used by unit tests, which
 *  inject a stub satisfying `Pick<Socket, 'send'>` so they never bind a real port). */
export function createBenchSocket(): Socket {
  return createSocket('udp4');
}
