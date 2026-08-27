#!/usr/bin/env node --experimental-transform-types
/**
 * Deterministic synthetic ST 2110 sender simulator — E1-TAI-BRIDGE P3.
 *
 * Run standalone as its OWN OS PROCESS (not imported as a library) so the P3 determinism test can
 * spawn TWO of these as genuinely independent processes that never share memory, never communicate,
 * and never negotiate — the strongest form of "zero coordination" available without real hardware.
 * Each process reads the SAME synthetic timing input from argv, computes the group-id sequence with
 * `groupIdForInstant` (a pure function — see tai-group-mapping.ts), and prints one JSON line per
 * frame to stdout. Two runs with identical argv MUST print byte-identical output.
 *
 * Usage:
 *   node --experimental-transform-types tools/tai-bench/bench-sender-sim.ts \
 *     --start-tai-ns=1893456000000000000 --rate-num=30000 --rate-den=1001 \
 *     --frame-count=2000 --media-clock-hz=90000 --sender-id=A
 */
import { groupIdForInstant, mediaClockValue, rational, framePeriodNs } from '../../src/tai-group-mapping.ts';

function argValue(name: string, argv: string[]): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

function main(): void {
  const argv = process.argv.slice(2);
  const startTaiNs = BigInt(argValue('start-tai-ns', argv) ?? '1893456000000000000');
  const rateNum = BigInt(argValue('rate-num', argv) ?? '30000');
  const rateDen = BigInt(argValue('rate-den', argv) ?? '1001');
  const frameCount = Number(argValue('frame-count', argv) ?? '2000');
  const mediaClockHz = BigInt(argValue('media-clock-hz', argv) ?? '90000');
  const senderId = argValue('sender-id', argv) ?? 'unknown';

  const frameRate = rational(rateNum, rateDen);
  const period = framePeriodNs(frameRate);

  for (let i = 0; i < frameCount; i++) {
    const frameIndex = BigInt(i);
    // Exact instant of frame i: startTaiNs + i * period, computed with the SAME exact-rational
    // arithmetic the mapping uses internally — no float ever enters this loop.
    const taiNs = startTaiNs + (frameIndex * period.numerator) / period.denominator;
    const groupId = groupIdForInstant(taiNs, frameRate);
    const clockTicks = mediaClockValue(frameIndex, mediaClockHz, frameRate);
    process.stdout.write(
      `${JSON.stringify({ senderId, frameIndex: i, taiNs: taiNs.toString(), groupId: groupId.toString(), mediaClockValue: clockTicks.toString() })}\n`,
    );
  }
}

main();
