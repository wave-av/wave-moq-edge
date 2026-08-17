import { describe, it, expect } from 'vitest';
import { MoqRelay } from '../src/moq-relay';
import {
  MOQ_OBJECT_STATUS,
  encodeSubscribe,
  encodePublishNamespace,
  decodeObject,
  type MoqObject,
} from '../src/moq-wire';

/**
 * E2 A/B arena — run the SAME synthetic load through the relay in BOTH modes (flag OFF = FIFO,
 * flag ON = deadline scheduler with priority/deadline hints injected) and receipt the comparison:
 * per-object CPU latency (time inside `onDecodedObject`), per-object DELIVERY latency (submit → the
 * call that fans it out), reorder count (inversions vs the canonical (priority, deadline) order),
 * and drop count. Deterministic: no RNG, fixed LCG payloads, fixed arrival sequence.
 *
 * The scheduler's structural trade is visible in the numbers: it reorders a scrambled arrival into
 * (priority, deadline) order (reorder 0) but pays a one-group buffering delay (delivery latency ≈
 * half a group of arrival time). FIFO delivers immediately but cannot reorder (reorder > 0 on a
 * scrambled arrival). Both must deliver the full set (drop 0).
 */

const NS = ['wave', 'cam-1'];

/** Deterministic LCG-filled payload — reproducible across runs. */
function makePayload(group: number, object: number, size: number): Uint8Array {
  const p = new Uint8Array(size);
  let s = (group * 2654435761 + object * 40503 + 1) >>> 0;
  for (let i = 0; i < size; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    p[i] = (s >>> 16) & 0xff;
  }
  return p;
}

function attach(relay: MoqRelay, subs: number): void {
  relay.onControl('pub', encodePublishNamespace({ requestId: 1n, trackNamespace: NS }));
  for (let i = 0; i < subs; i++) {
    relay.onControl(`s${i}`, encodeSubscribe({ requestId: BigInt(i + 2), trackNamespace: NS, trackName: 'v' }));
  }
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

interface Item {
  group: number;
  object: number;
  priority: number;
  deadlineMs: number;
}

type ScenarioName = 'deadline-arrival' | 'priority-scrambled';

/**
 * Build the arrival-ordered load. `deadline-arrival`: arrival already in (priority, deadline) order
 * (control — scheduler shows pure overhead). `priority-scrambled`: arrival is the REVERSE of schedule
 * order (highest-priority object arrives last) — FIFO cannot reorder, the scheduler can.
 */
function buildLoad(
  scenario: ScenarioName,
  groups: number,
  objsPerGroup: number,
  payloadBytes: number,
): { items: Item[]; objs: MoqObject[] } {
  const items: Item[] = [];
  for (let g = 0; g < groups; g++) {
    for (let o = 0; o < objsPerGroup; o++) {
      let priority: number;
      let deadline: number;
      if (scenario === 'deadline-arrival') {
        priority = o; // arrival == schedule order
        deadline = g * objsPerGroup + o;
      } else {
        priority = objsPerGroup - 1 - o; // arrival reversed vs schedule order
        deadline = g * objsPerGroup + priority;
      }
      items.push({ group: g, object: o, priority, deadlineMs: deadline });
    }
  }
  const objs: MoqObject[] = items.map((it) => ({
    trackAlias: 99n,
    groupId: BigInt(it.group),
    objectId: BigInt(it.object),
    status: MOQ_OBJECT_STATUS.NORMAL,
    payload: makePayload(it.group, it.object, payloadBytes),
    priority: it.priority,
    deadlineMs: it.deadlineMs,
  }));
  return { items, objs };
}

interface Metrics {
  mode: 'fifo' | 'scheduler';
  scenario: ScenarioName;
  total: number;
  delivered: number;
  drop: number;
  reorder: number;
  cpuP50: number;
  cpuP95: number;
  cpuMean: number;
  cpuMax: number;
  delP50: number;
  delP95: number;
  delMean: number;
  delMax: number;
}

/** Inversion count of `delivered` vs the canonical (priority, deadline) order within one group. */
function groupReorder(delivered: Item[], canonical: Item[]): number {
  const pos = new Map<number, number>();
  canonical.forEach((c, i) => pos.set(c.object, i));
  const seq = delivered.map((d) => pos.get(d.object)!);
  let inv = 0;
  for (let i = 0; i < seq.length; i++) {
    for (let j = i + 1; j < seq.length; j++) if (seq[i] > seq[j]) inv++;
  }
  return inv;
}

function runMode(
  mode: 'fifo' | 'scheduler',
  scenario: ScenarioName,
  groups: number,
  objsPerGroup: number,
  subs: number,
  payloadBytes: number,
): Metrics {
  const { items, objs } = buildLoad(scenario, groups, objsPerGroup, payloadBytes);
  const itemByKey = new Map<string, Item>();
  const indexByKey = new Map<string, number>();
  items.forEach((it, i) => {
    const key = `${it.group}:${it.object}`;
    itemByKey.set(key, it);
    indexByKey.set(key, i);
  });

  // Warm the JIT on a throwaway relay (same code paths, no measured objects reused).
  const warm = new MoqRelay({ scheduler: mode === 'scheduler' });
  attach(warm, subs);
  const WARMUP = 512;
  for (let i = 0; i < WARMUP; i++) warm.onDecodedObject(objs[i % objs.length]);
  warm.flush();

  const relay = new MoqRelay({ scheduler: mode === 'scheduler' });
  attach(relay, subs);

  const cpu: number[] = new Array(objs.length);
  const submitTime: number[] = new Array(objs.length);
  const delivery: number[] = new Array(objs.length);
  const deliveredByGroup = new Map<number, Item[]>();
  const firstSubmit = new Array<number>(groups).fill(-1);
  const lastEmit = new Array<number>(groups).fill(-1);

  const recordEmit = (fanout: { frame: Uint8Array }[], emitTime: number): void => {
    const seen = new Set<string>();
    for (const f of fanout) {
      const d = decodeObject(f.frame);
      const key = `${d.groupId}:${d.objectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = itemByKey.get(key);
      const idx = indexByKey.get(key);
      if (item === undefined || idx === undefined) continue;
      const list = deliveredByGroup.get(item.group) ?? [];
      list.push(item);
      deliveredByGroup.set(item.group, list);
      delivery[idx] = (emitTime - submitTime[idx]) * 1000; // µs
      lastEmit[item.group] = Math.max(lastEmit[item.group], emitTime);
    }
  };

  for (let i = 0; i < objs.length; i++) {
    const t0 = performance.now();
    const r = relay.onDecodedObject(objs[i]);
    const t1 = performance.now();
    submitTime[i] = t0;
    cpu[i] = (t1 - t0) * 1000;
    if (firstSubmit[Number(objs[i].groupId)] < 0) firstSubmit[Number(objs[i].groupId)] = t0;
    recordEmit(r.fanout, t1);
  }
  const flush = relay.flush();
  const tf = performance.now();
  recordEmit(flush, tf);

  // reorder = sum of within-group inversions vs canonical (priority, deadline) order
  let reorder = 0;
  let delivered = 0;
  for (let g = 0; g < groups; g++) {
    const canonical = items.filter((it) => it.group === g).sort((a, b) => a.priority - b.priority || a.deadlineMs - b.deadlineMs);
    const list = deliveredByGroup.get(g) ?? [];
    delivered += list.length;
    reorder += groupReorder(list, canonical);
  }

  const cpuSorted = [...cpu].sort((a, b) => a - b);
  const delSorted = [...delivery].sort((a, b) => a - b);
  const gc = new Array<number>();
  for (let g = 0; g < groups; g++) {
    if (firstSubmit[g] >= 0 && lastEmit[g] >= 0) gc.push((lastEmit[g] - firstSubmit[g]) * 1000);
  }
  const gcSorted = [...gc].sort((a, b) => a - b);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  return {
    mode,
    scenario,
    total: objs.length,
    delivered,
    drop: objs.length - delivered,
    reorder,
    cpuP50: pct(cpuSorted, 0.5),
    cpuP95: pct(cpuSorted, 0.95),
    cpuMean: mean(cpuSorted),
    cpuMax: cpuSorted[cpuSorted.length - 1],
    delP50: pct(delSorted, 0.5),
    delP95: pct(delSorted, 0.95),
    delMean: mean(delSorted),
    delMax: delSorted[delSorted.length - 1],
    gcP50: pct(gcSorted, 0.5),
    gcP95: pct(gcSorted, 0.95),
    gcMean: mean(gcSorted),
  };
}

const us = (x: number) => x.toFixed(3);

describe('E2 arena: scheduler vs FIFO under load', () => {
  it('runs the same load in both modes and prints the A/B receipt', () => {
    const GROUPS = 100;
    const M = 64;
    const SUBS = 4;
    const PAYLOAD = 256;
    const scenarios: ScenarioName[] = ['deadline-arrival', 'priority-scrambled'];
    const rows: string[] = [];

    for (const scenario of scenarios) {
      const fifo = runMode('fifo', scenario, GROUPS, M, SUBS, PAYLOAD);
      const sched = runMode('scheduler', scenario, GROUPS, M, SUBS, PAYLOAD);

      // Correctness gates: full set delivered in both modes (no drop); scheduler never reorders.
      expect(fifo.drop).toBe(0);
      expect(sched.drop).toBe(0);
      expect(fifo.delivered).toBe(GROUPS * M);
      expect(sched.delivered).toBe(GROUPS * M);
      expect(sched.reorder).toBe(0);
      if (scenario === 'priority-scrambled') {
        expect(sched.reorder).toBeLessThan(fifo.reorder); // the point of the scheduler
      } else {
        expect(fifo.reorder).toBe(0); // control: arrival already sorted
      }

      const line = (m: Metrics) =>
        `E2-ARENA scenario=${m.scenario} mode=${m.mode.toUpperCase()} groups=${GROUPS} objects/group=${M} subscribers=${SUBS} total=${m.total} delivered=${m.delivered} drop=${m.drop} reorder=${m.reorder}`;
      const lat = (m: Metrics) =>
        `E2-ARENA scenario=${m.scenario} mode=${m.mode.toUpperCase()} cpu p50=${us(m.cpuP50)}us p95=${us(m.cpuP95)}us mean=${us(m.cpuMean)}us max=${us(m.cpuMax)}us | delivery p50=${us(m.delP50)}us p95=${us(m.delP95)}us mean=${us(m.delMean)}us max=${us(m.delMax)}us | group-completion p50=${us(m.gcP50)}us p95=${us(m.gcP95)}us mean=${us(m.gcMean)}us`;

      rows.push(line(fifo), line(sched), lat(fifo), lat(sched));
    }

    for (const r of rows) console.log(r);
  });
});
