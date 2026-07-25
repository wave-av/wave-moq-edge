/**
 * Multi-viewport track model — hermetic tests.
 *
 * G3.5 PROVEN HERMETIC. Everything here runs in-process against the PURE relay core
 * (`MoqRelay` → `MoqTrackSet` → `ViewportTrackSet`) with no network, no Durable Object, no socket.
 * It proves the MODEL and the CODEC, not a deployment: nothing in this file is a live receipt.
 *
 * What it proves:
 *   1. The catalog enumerates 16 viewport tracks + 1 canvas track with REAL selectionParams.
 *   2. The PTP↔MoQ mapping is exact, invertible, and aligns group boundaries across mixed rates.
 *   3. The mapping's stated failure modes actually behave as documented (clock step, rate that does
 *      not divide the grid, UTC timescale, non-integer-ns frame duration).
 *   4. N viewport tracks drive through the existing relay path and a subscriber that holds only
 *      canvas + 2 viewports receives exactly those tracks' objects, in ascending (group, object)
 *      order, with per-viewport metadata intact after the relay's decode/re-encode round trip.
 *   5. Per-track byte attribution matches what the publisher sent, to the byte.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeSetup,
  encodePublishNamespace,
  encodeSubscribe,
  encodeObject,
  decodeObject,
  Writer,
  MOQ_ROLE,
} from '../src/moq-wire';
import {
  CANVAS_TRACK_NAME,
  CLOCK_STATE,
  ClockGuard,
  DEFAULT_TIMING_GRID,
  RECOMMENDED_MAX_CONCURRENT_SUBSCRIPTIONS,
  SUBSCRIPTION_INTENT,
  VIEWPORT_ROLE,
  frameIndexFromTai,
  groupDurationNs,
  locationFromTai,
  parseViewportTrackName,
  rigAggregateBitrate,
  subscribedBitrate,
  subscriberPriorityFor,
  taiNsFromLocation,
  viewportTrackName,
  type RigDescriptor,
  type TimingGrid,
  type ViewportDescriptor,
} from '../src/viewport-model';
import { buildViewportCatalog, objectsPerGroup, rigTrackNames, type ViewportCatalogTrack } from '../src/viewport-catalog';
import { ViewportTrackSet, readViewportObject } from '../src/viewport-tracks';
import { decodeViewportProperties, encodeViewportProperties } from '../src/viewport-properties';

// ── the MVP rig: 8x1080p60 + 2x2160p60 active, 16 slots declared, 4x4 canvas ──────────────────────

const BITRATE_1080P60 = 10_000_000; // publisher-declared contribution rate
const BITRATE_2160P60 = 40_000_000;
const CANVAS_BITRATE = 2_500_000;

function mvpViewports(): ViewportDescriptor[] {
  return Array.from({ length: 16 }, (_, id) => {
    const uhd = id === 0 || id === 1; // the two 2160p60 hero cameras
    const active = id < 10; // MVP commit: 8x1080p60 + 2x2160p60 = 10 of 16 slots live
    return {
      id,
      role: id < 2 ? VIEWPORT_ROLE.FOLLOW : VIEWPORT_ROLE.FIXED,
      width: uhd ? 3840 : 1920,
      height: uhd ? 2160 : 1080,
      rate: { num: 60, den: 1 },
      codec: uhd ? 'hvc1.2.4.L153.B0' : 'avc1.640033',
      mimeType: 'video/mp4',
      bitrate: uhd ? BITRATE_2160P60 : BITRATE_1080P60,
      pose: { position: [id * 0.5, 1.6, -2], orientation: [0, 0, 0, 1] },
      intrinsics: { fx: uhd ? 3200 : 1600, fy: uhd ? 3200 : 1600, cx: uhd ? 1920 : 960, cy: uhd ? 1080 : 540 },
      canvasTile: { row: Math.floor(id / 4), col: id % 4 },
      active,
    } satisfies ViewportDescriptor;
  });
}

function mvpRig(grid: TimingGrid = DEFAULT_TIMING_GRID): RigDescriptor {
  return {
    namespace: ['wave', 'tenant-demo', 'event-demo'],
    rigId: 'rig-mvp-16',
    grid,
    viewports: mvpViewports(),
    canvas: {
      rows: 4,
      cols: 4,
      width: 1920,
      height: 1080,
      // 20 fps: 60/20 = 3 grid slots per canvas frame → exactly 5 objects per 15-slot group.
      rate: { num: 20, den: 1 },
      codec: 'avc1.640028',
      mimeType: 'video/mp4',
      bitrate: CANVAS_BITRATE,
    },
  };
}

/** A TAI instant that is an exact group boundary: 1.785e18 ns / 250 ms = group 7,140,000,000. */
const T0_TAI_NS = 1_785_000_000_000_000_000n;

/**
 * The capture instant a REAL 60p genlocked source stamps for grid slot `f`: the ideal instant
 * f * 1e9/60 ns, rounded to whole nanoseconds because PTP timestamps are integers. Note that this is
 * NOT an exact multiple of anything — 1e9/60 = 16,666,666.67 — which is precisely the quantization
 * that makes a floor-based mapping file every third frame in the wrong slot.
 */
function captureNs(f: number): bigint {
  return T0_TAI_NS + (BigInt(f) * 1_000_000_000n + 30n) / 60n;
}

// ── 1. catalog ────────────────────────────────────────────────────────────────────────────────────

describe('viewport catalog', () => {
  const rig = mvpRig();
  const cat = buildViewportCatalog(rig);

  it('enumerates 16 viewport tracks + 1 canvas track, canvas first', () => {
    expect(cat.tracks).toHaveLength(17);
    expect(cat.tracks[0].name).toBe(CANVAS_TRACK_NAME);
    expect(cat.tracks.slice(1).map((t) => t.name)).toEqual(Array.from({ length: 16 }, (_, i) => viewportTrackName(i)));
    expect(rigTrackNames(rig)).toEqual(cat.tracks.map((t) => t.name));
  });

  it('carries REAL selectionParams — no FIXTURE values anywhere', () => {
    const uhd = cat.tracks.find((t) => t.name === 'viewport-00') as ViewportCatalogTrack;
    expect(uhd.selectionParams).toEqual({
      codec: 'hvc1.2.4.L153.B0',
      mimeType: 'video/mp4',
      width: 3840,
      height: 2160,
      framerate: 60,
      bitrate: BITRATE_2160P60,
    });
    // The catalog.ts fixture is 1280x720@30 avc1.640028 — assert we are NOT emitting it for viewports.
    for (const t of cat.tracks.slice(1)) {
      expect(t.selectionParams.width).not.toBe(1280);
      expect(t.selectionParams.framerate).toBe(60);
    }
    expect(JSON.stringify(cat)).not.toContain('FIXTURE');
  });

  it('publishes the timing grid a client needs to interpret Group and Object IDs', () => {
    expect(cat['wave-rig'].timing.timescale).toBe('TAI');
    expect(cat['wave-rig'].timing.gridRate).toEqual({ num: 60, den: 1 });
    expect(cat['wave-rig'].timing.framesPerGroup).toBe(15);
    expect(cat['wave-rig'].timing.groupDurationNs).toBe('250000000');
    expect(cat['wave-rig'].timing.groupEpochTaiNs).toBe('0');
  });

  it('maps every viewport to a distinct canvas tile, row-major, with no holes', () => {
    const order = cat['wave-rig'].canvas.tileOrder;
    expect(order).toHaveLength(16);
    expect(order).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(new Set(order).size).toBe(16);
  });

  it('gives each viewport its OWN altGroup — renditions are alternates, other cameras are not', () => {
    const groups = cat.tracks.slice(1).map((t) => t.altGroup);
    expect(new Set(groups).size).toBe(16);
    // …while renderGroup binds the whole rig together for presentation.
    expect(new Set(cat.tracks.map((t) => t.renderGroup))).toEqual(new Set([1]));
  });

  it('declares each track’s objects-per-group from the SHARED grid, not its own rate', () => {
    expect(objectsPerGroup({ num: 60, den: 1 }, rig)).toBe(15); // a 60 fps viewport
    expect(objectsPerGroup({ num: 20, den: 1 }, rig)).toBe(5); // the 20 fps canvas
    expect(cat.tracks[0]['wave-viewport']?.objectsPerGroup).toBe(5);
    expect(cat.tracks[1]['wave-viewport']?.objectsPerGroup).toBe(15);
  });

  it('rejects a rate that does not divide the grid into whole objects per group (failure mode 4)', () => {
    // 15 fps against a 60/1 grid with 15-slot groups = 3.75 objects per group — not expressible.
    expect(() => objectsPerGroup({ num: 15, den: 1 }, rig)).toThrow(/whole objects per group/);
  });

  it('rejects a rig whose viewports collide on a canvas tile', () => {
    const bad = mvpRig();
    bad.viewports[5].canvasTile = { ...bad.viewports[4].canvasTile };
    expect(() => buildViewportCatalog(bad)).toThrow(/duplicate canvas tile/);
  });
});

// ── 2. the arithmetic that justifies the canvas track ─────────────────────────────────────────────

describe('topology arithmetic', () => {
  const rig = mvpRig();

  it('8x1080p60 + 2x2160p60 = 160 Mbps aggregate; the canvas surveys it for 2.5 Mbps', () => {
    expect(rigAggregateBitrate(rig)).toBe(8 * BITRATE_1080P60 + 2 * BITRATE_2160P60);
    expect(rigAggregateBitrate(rig)).toBe(160_000_000);
    // The canvas is 1.5625% of the rig — a 64x cheaper way to see all 16 viewports.
    expect(rig.canvas.bitrate / rigAggregateBitrate(rig)).toBeCloseTo(0.015625, 6);
    expect(rigAggregateBitrate(rig) / rig.canvas.bitrate).toBe(64);
  });

  it('survey-then-solo costs 52.5 Mbps against 162.5 Mbps for naive all-16 — 3.1x', () => {
    const plan = [
      { viewportId: 'canvas' as const, intent: SUBSCRIPTION_INTENT.CANVAS },
      { viewportId: 0, intent: SUBSCRIPTION_INTENT.HERO }, // 2160p60
      { viewportId: 4, intent: SUBSCRIPTION_INTENT.SECONDARY }, // 1080p60
    ];
    const chosen = subscribedBitrate(rig, plan);
    expect(chosen).toBe(CANVAS_BITRATE + BITRATE_2160P60 + BITRATE_1080P60);
    expect(chosen).toBe(52_500_000);
    const naive = rigAggregateBitrate(rig) + rig.canvas.bitrate;
    expect(naive).toBe(162_500_000);
    expect(naive / chosen).toBeCloseTo(3.095, 3);
    // …and it holds 3 subscriptions, under the measured many-track ceiling.
    expect(plan.length).toBeLessThanOrEqual(RECOMMENDED_MAX_CONCURRENT_SUBSCRIPTIONS);
  });

  it('prioritises the viewport the user is looking at over one they are not', () => {
    // Lower value = higher priority (draft-18 section 7).
    expect(subscriberPriorityFor(SUBSCRIPTION_INTENT.CANVAS)).toBeLessThan(subscriberPriorityFor(SUBSCRIPTION_INTENT.HERO));
    expect(subscriberPriorityFor(SUBSCRIPTION_INTENT.HERO)).toBeLessThan(subscriberPriorityFor(SUBSCRIPTION_INTENT.SECONDARY));
    expect(subscriberPriorityFor(SUBSCRIPTION_INTENT.SECONDARY)).toBeLessThan(subscriberPriorityFor(SUBSCRIPTION_INTENT.PREWARM));
  });
});

// ── 3. the PTP <-> MoQ timing seam ────────────────────────────────────────────────────────────────

describe('PTP to MoQ mapping', () => {
  it('maps a TAI instant to (Group, Object) and back, exactly', () => {
    const loc = locationFromTai(T0_TAI_NS);
    expect(loc.groupId).toBe(7_140_000_000n);
    expect(loc.objectId).toBe(0n);
    expect(taiNsFromLocation(loc.groupId, loc.objectId)).toBe(T0_TAI_NS);
    expect(groupDurationNs()).toBe(250_000_000n);
  });

  it('advances one Object per frame and rolls to the next Group after 15', () => {
    for (let i = 0; i < 15; i++) {
      const loc = locationFromTai(captureNs(i));
      expect(loc.groupId).toBe(7_140_000_000n);
      expect(loc.objectId).toBe(BigInt(i));
    }
    const next = locationFromTai(T0_TAI_NS + 250_000_000n);
    expect(next.groupId).toBe(7_140_000_001n);
    expect(next.objectId).toBe(0n);
  });

  it('ROUNDS to the nearest slot — a floor-based mapping misfiles a quantized 60p timestamp', () => {
    // Slot 2's ideal instant is 33,333,333.33 ns; PTP stamps 33,333,333 — 0.33 ns SHORT of the
    // boundary. floor() files that in slot 1. round() files it in slot 2, where it belongs.
    const t2 = T0_TAI_NS + 33_333_333n;
    expect((33_333_333n * 60n) / 1_000_000_000n).toBe(1n); // what floor() would have said
    expect(locationFromTai(t2).objectId).toBe(2n); // what round() says
    // The tolerance is +/- half a slot = 8.33 ms, against sub-microsecond genlock jitter: 4 orders.
    expect(locationFromTai(T0_TAI_NS + 33_333_333n - 8_000_000n).objectId).toBe(2n);
    expect(locationFromTai(T0_TAI_NS + 33_333_333n + 8_000_000n).objectId).toBe(2n);
  });

  it('aligns group boundaries across mixed rates with ZERO coordination', () => {
    // A 60 fps viewport and a 20 fps canvas derive from the SAME grid, so the same instant lands in
    // the same Group for both — which is what lets a viewport switch splice on a common boundary.
    const t = T0_TAI_NS + 137_000_000n;
    const viewportLoc = locationFromTai(t);
    const canvasSlot = frameIndexFromTai(t) / 3n; // canvas emits every 3rd grid slot
    expect(viewportLoc.groupId).toBe(7_140_000_000n);
    expect(canvasSlot * 3n / 15n).toBe(viewportLoc.groupId);
  });

  it('two independent encoders derive IDENTICAL Group IDs for the same instant (statelessness)', () => {
    const encoderA = locationFromTai(T0_TAI_NS + 99_000_000n);
    const encoderB = locationFromTai(T0_TAI_NS + 99_000_000n);
    expect(encoderA).toEqual(encoderB);
    // No session state, no epoch exchange, no SETUP option: the grid is the entire agreement.
    expect(DEFAULT_TIMING_GRID.groupEpochTaiNs).toBe(0n);
  });

  it('is exact for 59.94 (60000/1001) — the rate a wall-clock T_FRAME constant gets wrong', () => {
    const grid: TimingGrid = { rate: { num: 60000, den: 1001 }, framesPerGroup: 15, timescale: 'TAI', groupEpochTaiNs: 0n };
    // Frame duration is 16,683,333.333... ns — NOT an integer number of nanoseconds.
    const exactNumer = 1001n * 1_000_000_000n;
    const exactDen = 60000n;
    expect(exactNumer % exactDen).not.toBe(0n);
    const truncatedFrameNs = exactNumer / exactDen; // 16,683,333 — what a naive constant holds
    expect(truncatedFrameNs).toBe(16_683_333n);
    // Error is 1/3 ns per frame. It slips a WHOLE frame after ~5.0e7 frames — about 9.7 days of
    // continuous run, i.e. the length of a live venue installation, not a lab session.
    const errorPerFrameThirdsNs = exactNumer * 3n / exactDen - truncatedFrameNs * 3n; // = 1 (in 1/3 ns)
    expect(errorPerFrameThirdsNs).toBe(1n);
    const framesToSlipOneFrame = truncatedFrameNs * 3n; // 50,049,999 frames
    const daysToSlip = Number(framesToSlipOneFrame) / (60000 / 1001) / 86400;
    expect(daysToSlip).toBeGreaterThan(9);
    expect(daysToSlip).toBeLessThan(10);
    // The frame-index form has no such constant, so it stays exact forever.
    const den = 1001n * 1_000_000_000n;
    expect(frameIndexFromTai(T0_TAI_NS, grid)).toBe((2n * T0_TAI_NS * 60000n + den) / (2n * den));
  });

  it('rejects a non-TAI timescale outright (failure mode 1: leap seconds duplicate Group IDs)', () => {
    const utc = { ...DEFAULT_TIMING_GRID, timescale: 'UTC' } as unknown as TimingGrid;
    expect(() => locationFromTai(T0_TAI_NS, utc)).toThrow(/TAI/);
  });
});

describe('ClockGuard (failure modes 2 and 3)', () => {
  const frameNs = 16_666_667n;

  it('clamps a BACKWARD grandmaster step so Group/Object IDs never regress', () => {
    const g = new ClockGuard();
    const a = g.next(T0_TAI_NS + 5n * frameNs);
    expect(a.clamped).toBe(false);
    expect(a.clockState).toBe(CLOCK_STATE.LOCKED);
    // Grandmaster steps back 2 seconds.
    const b = g.next(T0_TAI_NS + 5n * frameNs - 2_000_000_000n);
    expect(b.clamped).toBe(true);
    expect(b.clockState).toBe(CLOCK_STATE.DISCONTINUITY);
    expect(b.frameIndex).toBe(a.frameIndex + 1n);
    // Strictly increasing, which is the invariant MoQ actually needs.
    expect(b.groupId * 15n + b.objectId).toBeGreaterThan(a.groupId * 15n + a.objectId);
  });

  it('flags a large FORWARD step but leaves the Group ID gap alone (gaps are legal)', () => {
    const g = new ClockGuard();
    const a = g.next(T0_TAI_NS);
    const b = g.next(T0_TAI_NS + 10_000_000_000n); // +10 s
    expect(b.clamped).toBe(false);
    expect(b.clockState).toBe(CLOCK_STATE.DISCONTINUITY);
    expect(b.groupId - a.groupId).toBe(40n); // 10 s / 250 ms
  });

  it('passes a HOLDOVER/FREERUN servo report straight through, so a subscriber can distrust it', () => {
    const g = new ClockGuard();
    expect(g.next(T0_TAI_NS, CLOCK_STATE.HOLDOVER).clockState).toBe(CLOCK_STATE.HOLDOVER);
    expect(g.next(T0_TAI_NS + frameNs, CLOCK_STATE.FREERUN).clockState).toBe(CLOCK_STATE.FREERUN);
  });
});

// ── 4. object properties round-trip ───────────────────────────────────────────────────────────────

describe('viewport object properties', () => {
  it('round-trips viewport identity, capture instant, clock state, pose and rig id', () => {
    const meta = {
      viewportId: 9,
      captureTaiNs: T0_TAI_NS + 12345n,
      clockState: CLOCK_STATE.LOCKED,
      pose: { position: [1.5, -2.25, 0.125] as [number, number, number], orientation: [0, 0.5, 0, 0.8660254] as [number, number, number, number] },
      intrinsics: { fx: 1600, fy: 1600, cx: 960, cy: 540 },
      rigId: 'rig-mvp-16',
    };
    const back = decodeViewportProperties(encodeViewportProperties(meta));
    expect(back.viewportId).toBe(9);
    expect(back.captureTaiNs).toBe(meta.captureTaiNs); // exact — nanoseconds, not milliseconds
    expect(back.rigId).toBe('rig-mvp-16');
    // Dyadic rationals are EXACT in float32; 0.8660254 is not, and lands within 6e-8 relative.
    expect(back.pose?.position).toEqual([1.5, -2.25, 0.125]);
    expect(back.pose?.orientation[3]).toBeCloseTo(0.8660254, 6);
    expect(back.intrinsics).toEqual(meta.intrinsics);
  });

  it('skips unknown property types instead of failing (fail-open on metadata)', () => {
    const known = encodeViewportProperties({ viewportId: 3 });
    // A property with an unregistered type code, correctly framed as (type varint, length-prefixed
    // value) — the shape a FUTURE property will have. Today's decoder must walk past it, not die.
    const unknown = new Writer().varint(0x3ffe).bytesLP(new Uint8Array([0xde, 0xad])).bytes();
    const merged = new Uint8Array(unknown.length + known.length);
    merged.set(unknown, 0);
    merged.set(known, unknown.length);
    expect(decodeViewportProperties(merged).viewportId).toBe(3);
  });

  it('a properties-free object encodes byte-identically to the pre-existing wire form', () => {
    const withUndef = encodeObject({ trackAlias: 1n, groupId: 2n, objectId: 3n, status: 0, payload: new Uint8Array([9, 9]) });
    const withEmpty = encodeObject({ trackAlias: 1n, groupId: 2n, objectId: 3n, status: 0, payload: new Uint8Array([9, 9]), properties: new Uint8Array(0) });
    expect(Array.from(withUndef)).toEqual(Array.from(withEmpty));
    expect(decodeObject(withUndef).properties).toBeUndefined();
  });
});

// ── 5. N viewport tracks through the real relay path ──────────────────────────────────────────────

describe('N viewport tracks through the relay (G3.5 PROVEN HERMETIC)', () => {
  const rig = mvpRig();
  const activeViewports = rig.viewports.filter((v) => v.active).map((v) => v.id);
  const PUB = 'pub-session';
  const SUB = 'sub-session';

  /** Payload for viewport `id` at grid slot `f` — deterministic, and its length is id-dependent so
   *  per-track byte attribution is distinguishable rather than uniform. */
  function payloadFor(id: number | 'canvas', f: number): Uint8Array {
    const n = id === 'canvas' ? 24 : 32 + id;
    const out = new Uint8Array(n);
    out.fill((f + (id === 'canvas' ? 200 : id)) & 0xff);
    return out;
  }

  function attach(vts: ViewportTrackSet): void {
    for (const name of vts.trackNames) {
      const src = name === CANVAS_TRACK_NAME ? ('canvas' as const) : (parseViewportTrackName(name) as number);
      vts.onControl(src, PUB, encodeSetup({ role: MOQ_ROLE.PUBLISHER, maxSubscriptions: 0n }));
      vts.onControl(src, PUB, encodePublishNamespace({ requestId: 1n, trackNamespace: rig.namespace }));
    }
  }

  function subscribe(vts: ViewportTrackSet, src: number | 'canvas', reqId: bigint) {
    return vts.onControl(src, SUB, encodeSubscribe({ requestId: reqId, trackNamespace: rig.namespace, trackName: ViewportTrackSet.trackNameFor(src) }));
  }

  /** Publish 3 groups (45 grid slots) across every active source; collect what SUB actually received. */
  function runRig(vts: ViewportTrackSet) {
    const received: Array<{ trackName: string; frame: Uint8Array }> = [];
    const publishedBytes = new Map<string, number>();

    for (let f = 0; f < 45; f++) {
      const t = captureNs(f); // what a genlocked 60p source actually stamps
      const sources: Array<number | 'canvas'> = [...activeViewports];
      if (f % 3 === 0) sources.push('canvas'); // 20 fps canvas = every 3rd grid slot
      for (const src of sources) {
        const payload = payloadFor(src, f);
        const v = src === 'canvas' ? undefined : rig.viewports.find((x) => x.id === src);
        const res = vts.publish(PUB, {
          source: src,
          captureTaiNs: t,
          payload,
          ...(v ? { pose: v.pose } : {}),
        });
        publishedBytes.set(res.trackName, (publishedBytes.get(res.trackName) ?? 0) + payload.length);
        for (const o of res.fanout) if (o.to === SUB) received.push({ trackName: res.trackName, frame: o.frame });
      }
    }
    return { received, publishedBytes };
  }

  it('delivers ONLY the subscribed tracks — 3 subscriptions, not 16', () => {
    const vts = new ViewportTrackSet(rig);
    attach(vts);
    subscribe(vts, 'canvas', 10n);
    subscribe(vts, 0, 11n);
    subscribe(vts, 8, 12n);

    const { received } = runRig(vts);
    const tracks = new Set(received.map((r) => r.trackName));
    expect([...tracks].sort()).toEqual([CANVAS_TRACK_NAME, 'viewport-00', 'viewport-08']);
    expect(tracks.size).toBeLessThanOrEqual(RECOMMENDED_MAX_CONCURRENT_SUBSCRIPTIONS);
    // 45 slots of viewport-00 + 45 of viewport-08 + 15 canvas frames (every 3rd slot).
    expect(received.filter((r) => r.trackName === 'viewport-00')).toHaveLength(45);
    expect(received.filter((r) => r.trackName === 'viewport-08')).toHaveLength(45);
    expect(received.filter((r) => r.trackName === CANVAS_TRACK_NAME)).toHaveLength(15);
    // …and nothing at all from the 8 unsubscribed active viewports.
    for (const id of activeViewports) {
      if (id === 0 || id === 8) continue;
      expect(received.some((r) => r.trackName === viewportTrackName(id))).toBe(false);
    }
  });

  it('delivers each track in strictly ascending (Group, Object) order', () => {
    const vts = new ViewportTrackSet(rig);
    attach(vts);
    subscribe(vts, 'canvas', 10n);
    subscribe(vts, 0, 11n);
    subscribe(vts, 8, 12n);
    const { received } = runRig(vts);

    for (const track of [CANVAS_TRACK_NAME, 'viewport-00', 'viewport-08']) {
      const seq = received.filter((r) => r.trackName === track).map((r) => readViewportObject(r.frame));
      expect(seq.length).toBeGreaterThan(0);
      for (let i = 1; i < seq.length; i++) {
        const prev = seq[i - 1];
        const cur = seq[i];
        const prevKey = prev.groupId * 15n + prev.objectId;
        const curKey = cur.groupId * 15n + cur.objectId;
        expect(curKey).toBeGreaterThan(prevKey);
      }
      // 3 groups of 250 ms, all starting at the SAME group id across every track.
      expect(seq[0].groupId).toBe(7_140_000_000n);
      expect(new Set(seq.map((s) => s.groupId.toString())).size).toBe(3);
    }
    // Group boundaries coincide across the 60 fps viewport and the 20 fps canvas.
    const canvasGroups = new Set(received.filter((r) => r.trackName === CANVAS_TRACK_NAME).map((r) => readViewportObject(r.frame).groupId.toString()));
    const vpGroups = new Set(received.filter((r) => r.trackName === 'viewport-00').map((r) => readViewportObject(r.frame).groupId.toString()));
    expect(canvasGroups).toEqual(vpGroups);
  });

  it('carries per-viewport metadata through the relay, unmodified', () => {
    const vts = new ViewportTrackSet(rig);
    attach(vts);
    subscribe(vts, 0, 11n);
    subscribe(vts, 8, 12n);
    const { received } = runRig(vts);

    for (const id of [0, 8]) {
      const src = rig.viewports.find((v) => v.id === id)!;
      const objs = received.filter((r) => r.trackName === viewportTrackName(id)).map((r) => readViewportObject(r.frame));
      for (const o of objs) {
        expect(o.meta.viewportId).toBe(id); // identity survives the relay's alias re-stamp
        expect(o.meta.rigId).toBe('rig-mvp-16');
        expect(o.meta.clockState).toBe(CLOCK_STATE.LOCKED);
        // POSE is float32 (28 B/object). ~1e-7 relative error: at a 100 m venue radius that is ~6 um
        // of position error — three orders below any camera-pose requirement, for half the bytes of
        // float64. The rounding is a DELIBERATE size/precision trade, so assert the bound, not equality.
        for (let axis = 0; axis < 3; axis++) {
          expect(o.meta.pose!.position[axis]).toBeCloseTo(src.pose.position[axis], 5);
          expect(Math.abs(o.meta.pose!.position[axis] - src.pose.position[axis])).toBeLessThan(Math.abs(src.pose.position[axis]) * 1e-6 + 1e-9);
        }
        // The exact PTP instant — the thing MoQ itself has no field for — recovered to the ns.
        expect(o.meta.captureTaiNs).toBeDefined();
        // The carried instant is within HALF a slot of its slot's nominal edge — the round-to-nearest
        // tolerance. That is the invariant a subscriber can rely on to re-derive the slot itself.
        const slotStart = taiNsFromLocation(o.groupId, o.objectId);
        const delta = o.meta.captureTaiNs! - slotStart;
        expect(delta > -8_333_334n && delta < 8_333_334n).toBe(true);
      }
      // The relay re-stamps a single consistent track alias on every forwarded object.
      const aliases = new Set(received.filter((r) => r.trackName === viewportTrackName(id)).map((r) => decodeObject(r.frame).trackAlias.toString()));
      expect(aliases).toEqual(new Set(['1']));
    }
  });

  it('attributes bytes per track, to the byte', () => {
    const vts = new ViewportTrackSet(rig);
    attach(vts);
    subscribe(vts, 0, 11n);

    const meteredBytes = new Map<string, number>();
    let expected00 = 0;
    for (let f = 0; f < 45; f++) {
      for (const id of activeViewports) {
        const payload = payloadFor(id, f);
        if (id === 0) expected00 += payload.length;
        const res = vts.publish(PUB, { source: id, captureTaiNs: captureNs(f), payload });
        for (const ev of res.events) {
          if (ev.kind === 'object_received') meteredBytes.set(res.trackName, (meteredBytes.get(res.trackName) ?? 0) + (ev.bytes ?? 0));
        }
      }
    }
    // Per-track metering is per-viewport metering — which is what makes a viewport a billable unit.
    expect(meteredBytes.get('viewport-00')).toBe(expected00);
    expect(meteredBytes.get('viewport-00')).toBe(45 * 32);
    expect(meteredBytes.get('viewport-09')).toBe(45 * (32 + 9));
    // Metering counts what the PUBLISHER sent, independent of who subscribed.
    expect(meteredBytes.size).toBe(activeViewports.length);
  });

  it('switches viewports: a mid-stream SUBSCRIBE replays the cached recent groups immediately', () => {
    const vts = new ViewportTrackSet(rig);
    attach(vts);
    subscribe(vts, 'canvas', 10n);
    subscribe(vts, 0, 11n);

    for (let f = 0; f < 45; f++) {
      for (const id of activeViewports) vts.publish(PUB, { source: id, captureTaiNs: captureNs(f), payload: payloadFor(id, f) });
    }
    // Operator solos viewport 3, which the client was NOT subscribed to.
    const res = subscribe(vts, 3, 13n);
    expect(res.objects.length).toBeGreaterThan(0);
    const first = readViewportObject(res.objects[0].frame);
    expect(first.meta.viewportId).toBe(3);
    // The replay starts at a GROUP boundary, so the client can decode without waiting for the next
    // one — the switch costs a cache replay, not a group of latency.
    expect(first.objectId).toBe(0n);
    // Relay retains the last 3 groups by default; the newest cached group is the one in flight.
    const groups = new Set(res.objects.map((o) => readViewportObject(o.frame).groupId.toString()));
    expect(groups.size).toBe(3);
    expect([...groups]).toContain('7140000002');
  });

  it('applies the delivery policy: canvas outranks hero outranks prewarm, with matching timeouts', () => {
    const vts = new ViewportTrackSet(rig);
    const policy = vts.deliveryPolicy([
      { source: 'canvas', intent: SUBSCRIPTION_INTENT.CANVAS },
      { source: 0, intent: SUBSCRIPTION_INTENT.HERO },
      { source: 4, intent: SUBSCRIPTION_INTENT.SECONDARY },
      { source: 8, intent: SUBSCRIPTION_INTENT.PREWARM },
    ]);
    expect(policy.map((p) => p.trackName)).toEqual([CANVAS_TRACK_NAME, 'viewport-00', 'viewport-04', 'viewport-08']);
    expect(policy.map((p) => p.subscriberPriority)).toEqual([0, 16, 32, 128]);
    // The prewarm track cannot survive even two frame times of queueing — it sheds first, by design.
    expect(policy.map((p) => p.deliveryTimeoutMs)).toEqual([500, 100, 100, 33]);
  });
});
