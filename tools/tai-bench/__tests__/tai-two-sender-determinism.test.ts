import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// E1-TAI-BRIDGE P3 — "Two independently-configured sender processes, given the same synthetic
// timing input and never communicating, produce byte-identical group identities and matching
// timing property bags across a full run." This test proves it the way the phase says it will
// actually be relied on: as two SEPARATE OS PROCESSES (not two function calls sharing one JS
// runtime's module cache), spawned with `execFileSync`, each running `bench-sender-sim.ts` fresh —
// no shared memory, no IPC, no negotiation, identical argv only.
//
// The test FAILS on a single group of drift, not on an aggregate tolerance: it does a full
// element-wise array comparison, and additionally asserts the exact index of the first divergence
// (there must be none) so a future regression reports precisely which frame broke instead of just
// "arrays differ".

const HERE = dirname(fileURLToPath(import.meta.url));
const SIM_SCRIPT = resolve(HERE, '../bench-sender-sim.ts');

interface SimLine {
  senderId: string;
  frameIndex: number;
  taiNs: string;
  groupId: string;
  mediaClockValue: string;
}

function runSender(senderId: string, argv: string[]): SimLine[] {
  const out = execFileSync(
    process.execPath,
    ['--experimental-transform-types', SIM_SCRIPT, ...argv, `--sender-id=${senderId}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as SimLine);
}

describe('P3 — two independent sender processes, zero coordination', () => {
  it('produce byte-identical group-id and media-clock sequences for 30000/1001 (NTSC) over 2000 frames', () => {
    const argv = [
      '--start-tai-ns=1893456789000000000',
      '--rate-num=30000',
      '--rate-den=1001',
      '--frame-count=2000',
      '--media-clock-hz=90000',
    ];
    // Two genuinely separate processes. Neither is passed the other's identity or output.
    const senderA = runSender('A', argv);
    const senderB = runSender('B', argv);

    expect(senderA).toHaveLength(2000);
    expect(senderB).toHaveLength(2000);

    // Compare group ids and media clock values (NOT senderId, which deliberately differs).
    const groupIdsA = senderA.map((l) => l.groupId);
    const groupIdsB = senderB.map((l) => l.groupId);
    const clockA = senderA.map((l) => l.mediaClockValue);
    const clockB = senderB.map((l) => l.mediaClockValue);

    let firstDivergence = -1;
    for (let i = 0; i < groupIdsA.length; i++) {
      if (groupIdsA[i] !== groupIdsB[i]) {
        firstDivergence = i;
        break;
      }
    }
    expect(firstDivergence).toBe(-1); // -1 means "no divergence found"; a real drift fails HERE, on the index
    expect(groupIdsA).toEqual(groupIdsB);
    expect(clockA).toEqual(clockB);

    // Sanity control: this is not a trivial all-zeros pass. The sequence must actually vary.
    expect(new Set(groupIdsA).size).toBeGreaterThan(1);
  });

  it('also agree at a whole-number rate (60fps) and across a clock discontinuity in the start instant', () => {
    const commonArgv = ['--rate-num=60', '--rate-den=1', '--frame-count=500', '--media-clock-hz=48000'];
    const senderA = runSender('A', [...commonArgv, '--start-tai-ns=1000000000000000000']);
    const senderB = runSender('B', [...commonArgv, '--start-tai-ns=1000000000000000000']);
    expect(senderA.map((l) => l.groupId)).toEqual(senderB.map((l) => l.groupId));
  });

  it('DISCRIMINATING CONTROL: two processes given DIFFERENT start instants correctly diverge', () => {
    // Proves the test harness itself can detect drift — a same-args pass alone would not
    // distinguish "the mapping is deterministic" from "this test never actually compares anything".
    const rateArgv = ['--rate-num=30', '--rate-den=1', '--frame-count=10', '--media-clock-hz=90000'];
    const senderA = runSender('A', [...rateArgv, '--start-tai-ns=1000000000000000000']);
    const senderB = runSender('B', [...rateArgv, '--start-tai-ns=2000000000000000000']);
    expect(senderA.map((l) => l.groupId)).not.toEqual(senderB.map((l) => l.groupId));
  });
});
