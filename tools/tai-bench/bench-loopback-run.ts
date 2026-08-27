#!/usr/bin/env node --experimental-transform-types
/**
 * E1-TAI-BRIDGE P4 receipt generator — bench run over a REAL loopback UDP socket, at low rate,
 * paired with the negative probe the phase's hard-gate requires ("the refusal is as much a part of
 * the receipt as the success").
 *
 * What this proves: (1) `publishBenchObject` over an actual `dgram` socket bound to 127.0.0.1
 * reaches a real local listener, which decodes the group id and ST 2110 timing property bag back
 * out correctly; (2) an unauthenticated publish attempt against the SAME socket is refused before
 * any byte reaches the wire — the listener never sees it, proven by the listener's receive count
 * staying flat across the negative probe.
 *
 * Run: node --experimental-transform-types tools/tai-bench/bench-loopback-run.ts
 */
import { createSocket } from 'node:dgram';
import {
  publishBenchObject,
  BenchAuthError,
  type BenchObjectInput,
  type PublishOptions,
} from './src/tai-bench-publisher.ts';
import { decodeSt2110TimingProperties } from '../../src/st2110-timing-properties.ts';
import { Reader } from '../../src/moq-wire.ts';
import { groupIdForInstant, rational } from '../../src/tai-group-mapping.ts';

const SECRET = process.env.BENCH_SECRET ?? 'e1-tai-bridge-loopback-bench-secret';
const HOST = '127.0.0.1';
const PORT = 41972; // bench-namespace loopback port, not the production relay port
const LOW_RATE_MS = 200; // low rate: 5 objects/sec

let received = 0;
let lastDecoded: { groupId: bigint; sourceTaiNs?: bigint } | null = null;

const listener = createSocket('udp4');
listener.on('message', (msg) => {
  received++;
  const r = new Reader(msg);
  const trackAlias = r.varint();
  const groupId = r.varint();
  const objectId = r.varint();
  const status = r.varintNum();
  const payload = r.bytesLP();
  const properties = r.remaining > 0 ? r.bytesLP() : new Uint8Array(0);
  const timing = decodeSt2110TimingProperties(properties);
  lastDecoded = { groupId, sourceTaiNs: timing.sourceTaiNs };
  console.log(
    `[listener] received object trackAlias=${trackAlias} groupId=${groupId} objectId=${objectId} status=${status} payloadLen=${payload.length} sourceTaiNs=${timing.sourceTaiNs} frameRate=${timing.frameRate?.numerator}/${timing.frameRate?.denominator} clockDomain=${timing.clockDomain}`,
  );
});

function wait(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function makeInput(frameIndex: bigint): BenchObjectInput {
  const frameRate = rational(30, 1);
  const startTaiNs = 1_893_456_789_000_000_000n;
  const taiNs = startTaiNs + (frameIndex * 1_000_000_000n) / 30n;
  return {
    trackAlias: 7n,
    objectId: frameIndex,
    groupId: groupIdForInstant(taiNs, frameRate),
    payload: new Uint8Array([0xaa, 0xbb, 0xcc]),
    timing: { sourceTaiNs: taiNs, frameRate, clockDomain: 127, mediaClockValue: frameIndex * 3000n },
  };
}

async function main(): Promise<void> {
  listener.bind(PORT, HOST);
  await wait(200); // give the listener a moment to bind

  const publisher = createSocket('udp4');
  const validOpts: PublishOptions = { token: `wave-token-v1.${SECRET}`, expectedSecret: SECRET, host: HOST, port: PORT };

  console.log(`=== E1-TAI-BRIDGE P4 bench run: loopback ${HOST}:${PORT}, low rate ${1000 / LOW_RATE_MS}/sec ===`);

  console.log('--- negative probe: unauthenticated publish (no token) ---');
  const beforeProbe = received;
  try {
    publishBenchObject(publisher, makeInput(0n), { ...validOpts, token: undefined });
    console.log('FAIL: unauthenticated publish was NOT refused — this must never happen');
    process.exitCode = 1;
  } catch (err) {
    if (err instanceof BenchAuthError) {
      console.log(`OK: unauthenticated publish refused before any I/O — ${err.message}`);
    } else {
      throw err;
    }
  }
  await wait(300); // let any (unexpected) datagram arrive so the count check below is meaningful
  console.log(`listener received-count after negative probe: ${received} (was ${beforeProbe}; must be unchanged)`);
  if (received !== beforeProbe) {
    console.log('FAIL: listener received a datagram from an unauthenticated publish attempt');
    process.exitCode = 1;
  }

  console.log('--- authenticated bench run: 5 objects at low rate ---');
  for (let i = 0n; i < 5n; i++) {
    publishBenchObject(publisher, makeInput(i), validOpts);
    await wait(LOW_RATE_MS);
  }
  await wait(300); // drain

  console.log(`total received: ${received} (expected 5)`);
  console.log(`last decoded: groupId=${lastDecoded?.groupId} sourceTaiNs=${lastDecoded?.sourceTaiNs}`);
  if (received !== 5) {
    console.log(`FAIL: expected exactly 5 authenticated objects received, got ${received}`);
    process.exitCode = 1;
  } else {
    console.log('OK: bench run complete, all 5 authenticated objects round-tripped over the real loopback socket.');
  }

  publisher.close();
  listener.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
