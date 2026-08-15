import { describe, it, expect } from 'vitest';
import { MoqRelay } from '../src/moq-relay';
import {
  MOQ_OBJECT_STATUS,
  SUBGROUP_ID_MODE,
  encodeObject,
  decodeObject,
  encodeSubscribe,
  encodePublishNamespace,
  encodeSubgroupStream,
  decodeSubgroupStream,
  type SubgroupHeader,
} from '../src/moq-wire';

/**
 * E0 baseline for the moq-deadline-scheduler epic: measure the relay's BEFORE-state without
 * changing its behavior. Three receipts:
 *   1. FIFO — delivery order == arrival order, no reorder/drop, FIFO cache eviction.
 *   2. dead priority byte — priority round-trips on the subgroup wire but is absent from the
 *      object forward path (`decodeObject`/`encodeObject`), i.e. zero relay consumers.
 *   3. per-object forward latency — p50/p95/mean/max of `onObject` (decode + encode + fan-out +
 *      cache append) across fan-out sizes, timed with `performance.now()` (monotonic, µs precision).
 *
 * Deterministic: fixed synthetic sequence (no RNG), fixed payload sizes, warmup before timing.
 */

const NS = ['wave', 'cam-1'];

/** Deterministic LCG-filled payload — reproducible across runs, ~uniform byte distribution. */
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

describe('E0 baseline: FIFO forward path', () => {
  it('delivery order == arrival order, no reorder/drop, FIFO cache eviction', () => {
    const relay = new MoqRelay();
    const SUBSCRIBERS = 4;
    attach(relay, SUBSCRIBERS);

    const GROUPS = 20;
    const OBJ_PER_GROUP = 32;
    const received = new Map<string, Array<{ group: number; object: number }>>();
    for (let i = 0; i < SUBSCRIBERS; i++) received.set(`s${i}`, []);

    const expected: Array<{ group: number; object: number }> = [];
    for (let g = 0; g < GROUPS; g++) {
      for (let o = 0; o < OBJ_PER_GROUP; o++) {
        expected.push({ group: g, object: o });
        const frame = encodeObject({
          trackAlias: 99n,
          groupId: BigInt(g),
          objectId: BigInt(o),
          status: MOQ_OBJECT_STATUS.NORMAL,
          payload: makePayload(g, o, 256),
        });
        const { fanout } = relay.onObject('pub', frame);
        expect(fanout).toHaveLength(SUBSCRIBERS);
        for (const f of fanout) {
          const d = decodeObject(f.frame);
          received.get(f.to)!.push({ group: Number(d.groupId), object: Number(d.objectId) });
        }
      }
    }

    // every subscriber received every object, in arrival order (FIFO), no reorder/drop
    for (const seq of received.values()) {
      expect(seq.length).toBe(GROUPS * OBJ_PER_GROUP);
      expect(seq).toEqual(expected);
    }

    // late-joiner cache: last maxCachedGroups groups (default 3), oldest evicted first (FIFO shift)
    expect(relay.cachedObjectCount).toBe(OBJ_PER_GROUP * 3);

    console.log(
      `E0-BASELINE FIFO: sent=${GROUPS * OBJ_PER_GROUP} groups=${GROUPS} objects/group=${OBJ_PER_GROUP} subscribers=${SUBSCRIBERS} reorder=0 drop=0 (delivery==arrival, ${SUBSCRIBERS}/${SUBSCRIBERS} subscribers identical)`
    );
  });

  it('priority byte lives on the subgroup wire but is dead on the object forward path', () => {
    // (1) priority is a real wire field: it round-trips through subgroup-stream encode/decode
    const hdr: SubgroupHeader = {
      trackAlias: 1n,
      groupId: 7n,
      subgroupId: 3n,
      idMode: SUBGROUP_ID_MODE.EXPLICIT,
      priority: 200,
      defaultPriority: false,
      endOfGroup: false,
      firstObject: true,
    };
    const subObjs = [{ objectId: 0n, status: MOQ_OBJECT_STATUS.NORMAL, payload: new Uint8Array([1, 2, 3]) }];
    expect(decodeSubgroupStream(encodeSubgroupStream(hdr, subObjs)).header.priority).toBe(200);

    // (2) but the relay forward path never sees it: decodeObject yields a MoqObject with NO priority key
    const relay = new MoqRelay();
    attach(relay, 1);
    const frame = encodeObject({
      trackAlias: 99n,
      groupId: 0n,
      objectId: 0n,
      status: MOQ_OBJECT_STATUS.NORMAL,
      payload: new Uint8Array([9]),
    });
    const { fanout } = relay.onObject('pub', frame);
    expect(fanout[0].kind).toBe('object');
    const decoded = decodeObject(fanout[0].frame) as unknown as Record<string, unknown>;
    expect('priority' in decoded).toBe(false);
    expect(Object.keys(decoded)).toEqual(['trackAlias', 'groupId', 'objectId', 'status', 'payload']);

    console.log(
      'E0-BASELINE PRIORITY: encodeSubgroupStream/decodeSubgroupStream round-trip priority=200 (wire-visible); relay forward path decodeObject -> MoqObject has NO priority key (dead byte)'
    );
  });
});

describe('E0 baseline: per-object forward latency', () => {
  it('prints p50/p95/mean/max across fan-out sizes', () => {
    const PAYLOAD_BYTES = 1000;
    const OBJ_PER_GROUP = 64;
    const WARMUP = 10000;
    const MEASURE = 20000;

    // pre-encode distinct object frames (publisher-side work, OUTSIDE the timed region)
    const frames: Uint8Array[] = [];
    for (let i = 0; i < MEASURE; i++) {
      const g = Math.floor(i / OBJ_PER_GROUP);
      const o = i % OBJ_PER_GROUP;
      frames.push(
        encodeObject({
          trackAlias: 99n,
          groupId: BigInt(g),
          objectId: BigInt(o),
          status: MOQ_OBJECT_STATUS.NORMAL,
          payload: makePayload(g, o, PAYLOAD_BYTES),
        })
      );
    }

    const rows: string[] = [];
    for (const subs of [1, 10, 100]) {
      const relay = new MoqRelay();
      attach(relay, subs);

      for (let i = 0; i < WARMUP; i++) relay.onObject('pub', frames[i % MEASURE]);

      const lat: number[] = new Array(MEASURE);
      let fanoutTotal = 0;
      for (let i = 0; i < MEASURE; i++) {
        const t0 = performance.now();
        const { fanout } = relay.onObject('pub', frames[i]);
        const t1 = performance.now();
        lat[i] = (t1 - t0) * 1000; // µs
        fanoutTotal += fanout.length;
      }

      // correctness during the measured run: every object fanned out to every subscriber (no drop)
      expect(fanoutTotal).toBe(MEASURE * subs);

      const sorted = [...lat].sort((a, b) => a - b);
      const us = (x: number) => x.toFixed(3);
      const p50 = pct(sorted, 0.5);
      const p95 = pct(sorted, 0.95);
      const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      const max = sorted[sorted.length - 1];
      expect(sorted).toHaveLength(MEASURE);
      expect(p95).toBeGreaterThanOrEqual(p50);

      rows.push(
        `E0-BASELINE LATENCY subscribers=${subs} payload=${PAYLOAD_BYTES}B objects=${MEASURE} p50=${us(p50)}us p95=${us(p95)}us mean=${us(mean)}us max=${us(max)}us`
      );
    }
    for (const r of rows) console.log(r);
  });
});
