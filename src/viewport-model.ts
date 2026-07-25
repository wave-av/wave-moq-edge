/**
 * Multi-viewport track model — the PTP↔MoQ timing seam and the per-viewport track descriptors.
 *
 * WHAT THIS IS. A source rig produces up to 16 concurrent virtual camera viewports plus per-viewport
 * pose/intrinsics, and we carry them over MoQ. MoQ Transport is deliberately media-agnostic: it has
 * Groups and Objects and **no timestamps at all** (draft-18 §11, draft-19 §2.1–2.4 — there is no time
 * field anywhere in the object model). Meanwhile a professional source rig is PTP-locked to
 * SMPTE ST 2059-2 with sub-microsecond accuracy. Mapping one onto the other is an unclaimed protocol
 * surface, and this module is WAVE's concrete proposal for it.
 *
 * This file is PURE (no I/O, no platform calls), exactly like moq-wire.ts and moq-relay.ts, so the
 * whole model is hermetically testable — see __tests__/viewport-track-model.test.ts.
 *
 * ── THE MAPPING, IN ONE PARAGRAPH ────────────────────────────────────────────────────────────────
 * Every track of a rig shares ONE rig-wide **grid rate** R_grid (a rational, e.g. 60/1 or 60000/1001)
 * and ONE **group size** G_grid in grid slots. For a capture instant t (TAI nanoseconds since the PTP
 * epoch, 1970-01-01T00:00:00 TAI):
 *
 *     F     = round(t_TAI_ns · R_num / (R_den · 1e9))     // grid frame index — exact rational math
 *     Group = floor(F / G_grid)
 *     Object= F mod G_grid
 *
 * ROUND, not FLOOR — and this is not a detail. A grid slot boundary is at a non-integer nanosecond for
 * every rate that does not divide 1e9, and 60/1 is already one of them: 1e9/60 = 16,666,666.67 ns. A
 * PTP timestamp is an integer of nanoseconds, so the capture instant nominally AT slot 2 quantizes to
 * 33,333,333 ns — which is 0.33 ns BELOW the true boundary, and `floor` therefore files it in slot 1.
 * One third of a nanosecond of quantization becomes a whole-frame error. `round` files a timestamp
 * within ±half a slot (±8.3 ms at 60p) into the slot it was captured for, which is the right tolerance
 * for a genlocked source whose jitter is sub-microsecond — four orders of margin. This was caught by
 * the hermetic test, not by reasoning; see __tests__/viewport-track-model.test.ts.
 *
 * The EXACT capture instant travels alongside, as an Object Property (`CAPTURE_TAI_NS`), because
 * Group/Object recover only the *slot*, never the timestamp. That split is the whole design:
 *   • Group/Object give **alignment and ordering** — derived, stateless, requiring zero coordination.
 *   • The Object Property gives **the timestamp** — exact, sub-microsecond, relay-forwarded verbatim.
 *
 * The load-bearing consequence: two encoders that have never exchanged a byte, both PTP-locked, both
 * told the same (R_grid, G_grid), emit **identical Group IDs for the same instant**. Group boundaries
 * therefore align across all 16 viewports for free, so a viewport switch lands on a common boundary
 * and a subscriber can splice without a resync heuristic. It also means the mapping survives a relay
 * restart, a late joiner and a FETCH, none of which carry session state.
 *
 * Deriving from the FRAME INDEX rather than from wall time is not cosmetic. The tempting shortcut is
 * `Group = floor(t / T_GROUP)` with T_GROUP held as a nanosecond constant. For Group ID alone that is
 * algebraically identical UNDER EXACT RATIONAL ARITHMETIC — but no implementation does exact rational
 * arithmetic on a constant. At 60000/1001 the frame duration is 16,683,333.333… ns; materialize it as
 * 16,683,333 ns and you accrue 1/3 ns per frame, slipping a WHOLE frame after ~5.0e7 frames ≈ 9.7 days
 * of continuous run — the length of a venue installation, not of a lab session. The frame-index form
 * has no such constant: it divides once, from the timestamp, and is exact for every rational rate and
 * every run length. (Proved numerically in the test.)
 *
 * ── FAILURE MODES (stated, not hidden) — see docs/2026-07-25-multi-viewport-track-model.md §7 ─────
 *   1. UTC instead of TAI. A leap second inserted in a UTC-derived clock replays one second of frame
 *      indices → duplicate Group/Object IDs, which MoQ reads as retransmission. TAI has no leap
 *      seconds; the catalog MUST declare `timescale: "TAI"` and a UTC-derived source is rejected.
 *   2. Grandmaster step backwards. Group IDs would regress; MoQ expects them non-decreasing. Handled
 *      by `ClockGuard` below: clamp forward, flag `CLOCK_STATE = DISCONTINUITY` on the object.
 *   3. Grandmaster step forwards. Leaves a Group ID GAP. Benign — MoQ tolerates gaps — but the guard
 *      still flags it so a subscriber does not read the gap as loss.
 *   4. Rate heterogeneity. A 20 fps canvas track and a 60 fps viewport track have different native
 *      frame indices. Solved by deriving EVERY track from the shared grid: a 20 fps track emits one
 *      object every 3 grid slots, so its Object IDs are sparse (0,3,6,9,12) and its group boundaries
 *      still coincide exactly with the 60 fps tracks'. The constraint this imposes is real and is
 *      enforced, not assumed: a track rate must divide the grid into a WHOLE number of objects per
 *      group, so on a 60/1 grid with 15-slot groups a 15 fps track (3.75 objects/group) is REJECTED
 *      by `objectsPerGroup` in viewport-catalog.ts. Pick 20 fps, or change the group size.
 *   5. PTP lost → free-run. The mapping silently becomes a fiction. `CLOCK_STATE` carries
 *      LOCKED/HOLDOVER/FREERUN so a subscriber can tell, rather than trusting a number.
 *   6. Absolute-TAI Group IDs are LARGE. At 250 ms groups a 2026 instant gives Group ≈ 7.14e9, which
 *      is < 2^33 and so needs a 5-byte draft-18 varint (7 value bits per byte). A session-relative ID
 *      over a 4-hour show peaks at 4·3600/0.25 = 57,600 < 2^17 and fits in 3 bytes. The absolute form
 *      therefore costs 2 extra bytes per object: 16 tracks × 60 fps × 2 B = 1,920 B/s against a
 *      160 Mbps (20 MB/s) rig, i.e. ~1e-4 of the wire, or 0.0096%. Paid deliberately, for
 *      statelessness — a session-relative ID needs an epoch that a relay must hold and a late joiner
 *      must fetch, and that epoch is exactly the state this design exists to avoid.
 *      `groupEpochTaiNs` remains the escape hatch; 0 (the default) means absolute TAI.
 */

/** Exact rational frame rate. 60/1 for 60p; 60000/1001 for 59.94p. */
export interface RationalRate {
  num: number;
  den: number;
}

/** Nanoseconds in one second — the unit of the PTP/TAI timestamps we accept. */
export const NS_PER_SECOND = 1_000_000_000n;

/**
 * The rig-wide timing grid. Every track of a rig — 2160p60 viewport, 1080p60 viewport, 15 fps canvas
 * mosaic — derives Group and Object IDs from THIS grid, never from its own capture rate.
 */
export interface TimingGrid {
  /** Grid rate: the highest rate on the rig (every other track's rate must divide it). */
  rate: RationalRate;
  /** Group size in grid slots. 15 slots at 60/1 = 250 ms groups. */
  framesPerGroup: number;
  /** Timescale declaration. Only 'TAI' is legal — see failure mode 1. */
  timescale: 'TAI';
  /** 0 = Group IDs are absolute TAI-derived (the default, and what we recommend). */
  groupEpochTaiNs: bigint;
}

/** The MVP grid: 60/1, 15-slot (250 ms) groups, absolute TAI. */
export const DEFAULT_TIMING_GRID: TimingGrid = {
  rate: { num: 60, den: 1 },
  framesPerGroup: 15,
  timescale: 'TAI',
  groupEpochTaiNs: 0n,
};

/** A resolved MoQ location plus the grid frame index it came from. */
export interface GridLocation {
  frameIndex: bigint;
  groupId: bigint;
  objectId: bigint;
}

function assertGrid(grid: TimingGrid): void {
  if (grid.timescale !== 'TAI') throw new RangeError('timing grid MUST be on the TAI timescale (leap seconds break Group ID monotonicity)');
  if (!Number.isInteger(grid.framesPerGroup) || grid.framesPerGroup <= 0) throw new RangeError('framesPerGroup must be a positive integer');
  if (!Number.isInteger(grid.rate.num) || !Number.isInteger(grid.rate.den) || grid.rate.num <= 0 || grid.rate.den <= 0) {
    throw new RangeError('rate must be a positive integer ratio');
  }
}

/**
 * Grid frame index for a TAI instant: F = round(t · R_num / (R_den · 1e9)), computed as
 * floor((2·t·R_num + R_den·1e9) / (2·R_den·1e9)) — exact rational bigint arithmetic, no float, so it
 * is bit-identical on every implementation that follows the formula. See the header for why ROUND.
 */
export function frameIndexFromTai(taiNs: bigint, grid: TimingGrid = DEFAULT_TIMING_GRID): bigint {
  assertGrid(grid);
  const t = taiNs - grid.groupEpochTaiNs;
  if (t < 0n) throw new RangeError('capture instant precedes the declared group epoch');
  const den = BigInt(grid.rate.den) * NS_PER_SECOND;
  return (2n * t * BigInt(grid.rate.num) + den) / (2n * den);
}

/** Inverse: the NOMINAL TAI instant of grid slot F (its leading edge, floored to whole nanoseconds).
 *  Round-trips `frameIndexFromTai` exactly: the nominal instant is within half a slot of itself. */
export function taiNsFromFrameIndex(frameIndex: bigint, grid: TimingGrid = DEFAULT_TIMING_GRID): bigint {
  assertGrid(grid);
  return grid.groupEpochTaiNs + (frameIndex * BigInt(grid.rate.den) * NS_PER_SECOND) / BigInt(grid.rate.num);
}

/** THE MAPPING. A PTP capture instant → the MoQ (Group ID, Object ID) that carries it. */
export function locationFromTai(taiNs: bigint, grid: TimingGrid = DEFAULT_TIMING_GRID): GridLocation {
  const frameIndex = frameIndexFromTai(taiNs, grid);
  const g = BigInt(grid.framesPerGroup);
  return { frameIndex, groupId: frameIndex / g, objectId: frameIndex % g };
}

/** Inverse of the slot half of the mapping: (Group, Object) → the grid slot's leading-edge TAI. */
export function taiNsFromLocation(groupId: bigint, objectId: bigint, grid: TimingGrid = DEFAULT_TIMING_GRID): bigint {
  assertGrid(grid);
  if (objectId >= BigInt(grid.framesPerGroup)) throw new RangeError('objectId exceeds the group size');
  return taiNsFromFrameIndex(groupId * BigInt(grid.framesPerGroup) + objectId, grid);
}

/** Group duration in nanoseconds (exact rational). 15 slots at 60/1 → 250,000,000 ns. */
export function groupDurationNs(grid: TimingGrid = DEFAULT_TIMING_GRID): bigint {
  assertGrid(grid);
  return (BigInt(grid.framesPerGroup) * BigInt(grid.rate.den) * NS_PER_SECOND) / BigInt(grid.rate.num);
}

// ── clock state ────────────────────────────────────────────────────────────────────────────────────

/** Reported PTP servo state, carried per-object so a subscriber never has to trust a bare number. */
export const CLOCK_STATE = {
  /** PTP servo locked to the grandmaster; the mapping is authoritative. */
  LOCKED: 0,
  /** Grandmaster lost, oscillator holdover; the mapping is drifting but still monotonic. */
  HOLDOVER: 1,
  /** No usable reference; Group IDs are a local fiction and MUST NOT be cross-correlated. */
  FREERUN: 2,
  /** This object follows a clock step; the Group ID was clamped (see ClockGuard). */
  DISCONTINUITY: 3,
} as const;
export type ClockState = (typeof CLOCK_STATE)[keyof typeof CLOCK_STATE];

/**
 * Enforces the one invariant MoQ needs from a PTP-derived mapping: **Group IDs never go backwards**.
 *
 * A grandmaster step backwards would otherwise regress the frame index, producing Group/Object IDs a
 * relay has already seen — which MoQ reads as retransmission, not as new media. The guard clamps to
 * the next slot after the highest one already emitted and flags DISCONTINUITY on that object. A
 * forward step needs no clamp: it just leaves a Group ID gap, which MoQ tolerates, but is still
 * flagged so a subscriber does not misread the gap as packet loss.
 */
export class ClockGuard {
  private lastFrameIndex: bigint | null = null;

  constructor(private readonly grid: TimingGrid = DEFAULT_TIMING_GRID) {}

  /**
   * Map a capture instant, clamping monotonically. `servo` is what the PTP stack reports;
   * the returned `clockState` is that, upgraded to DISCONTINUITY when this object crossed a step.
   */
  next(taiNs: bigint, servo: ClockState = CLOCK_STATE.LOCKED): GridLocation & { clockState: ClockState; clamped: boolean } {
    const raw = frameIndexFromTai(taiNs, this.grid);
    let frameIndex = raw;
    let clamped = false;
    let clockState: ClockState = servo;

    if (this.lastFrameIndex !== null) {
      if (raw <= this.lastFrameIndex) {
        // Backward or stalled step — clamp forward so Group/Object IDs stay strictly increasing.
        frameIndex = this.lastFrameIndex + 1n;
        clamped = true;
        clockState = CLOCK_STATE.DISCONTINUITY;
      } else if (raw > this.lastFrameIndex + 1n) {
        // Forward jump. A gap of one or two slots is ordinary jitter/drop; a large jump is a step.
        if (raw - this.lastFrameIndex > BigInt(this.grid.framesPerGroup)) clockState = CLOCK_STATE.DISCONTINUITY;
      }
    }
    this.lastFrameIndex = frameIndex;
    const g = BigInt(this.grid.framesPerGroup);
    return { frameIndex, groupId: frameIndex / g, objectId: frameIndex % g, clockState, clamped };
  }
}

// ── viewport descriptors ───────────────────────────────────────────────────────────────────────────

/**
 * What a viewport is FOR. Drives the priority and delivery-timeout policy below, and is the value an
 * agent filters on (draft-19 `SUBSCRIBE_TRACKS` + a Track Property filter: "every track in this
 * namespace where role = follow-cam").
 */
export const VIEWPORT_ROLE = {
  /** The low-rate mosaic of every viewport — the navigation surface. Never shed. */
  CANVAS: 'canvas',
  /** A fixed virtual camera. */
  FIXED: 'fixed',
  /** A virtual camera that tracks a subject. */
  FOLLOW: 'follow',
  /** An operator- or agent-driven free camera. */
  FREE: 'free',
} as const;
export type ViewportRole = (typeof VIEWPORT_ROLE)[keyof typeof VIEWPORT_ROLE];

/** How a subscriber is currently using a track. This, not the role, is what wins under congestion. */
export const SUBSCRIPTION_INTENT = {
  /** The navigation surface. */
  CANVAS: 'canvas',
  /** The viewport on screen. */
  HERO: 'hero',
  /** A visible secondary (PiP / confidence monitor). */
  SECONDARY: 'secondary',
  /** Subscribed but not displayed — pre-warmed for a fast switch. */
  PREWARM: 'prewarm',
  /** Audio. */
  AUDIO: 'audio',
} as const;
export type SubscriptionIntent = (typeof SUBSCRIPTION_INTENT)[keyof typeof SUBSCRIPTION_INTENT];

/** Rig-relative extrinsics: position in metres + orientation as a unit quaternion (x,y,z,w). */
export interface ViewportPose {
  position: [number, number, number];
  orientation: [number, number, number, number];
}

/** Pinhole intrinsics in pixels. */
export interface ViewportIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

/** One virtual camera viewport and the encode it publishes. */
export interface ViewportDescriptor {
  /** Stable small integer, unique within the rig. Also the Object Property value and the tile key. */
  id: number;
  role: ViewportRole;
  width: number;
  height: number;
  /** Capture rate. MUST divide the grid rate (see failure mode 4). */
  rate: RationalRate;
  /** RFC 6381 codec string, e.g. 'avc1.640033'. */
  codec: string;
  mimeType: string;
  /** Target bitrate in bits/second — real, publisher-declared, not a fixture. */
  bitrate: number;
  /** Rig-relative extrinsics at declaration time; per-frame pose rides the Object Property. */
  pose: ViewportPose;
  intrinsics: ViewportIntrinsics;
  /** Position of this viewport in the canvas mosaic, row-major from the top-left. */
  canvasTile: { row: number; col: number };
  /** True once the source is actually producing this viewport (declared-but-idle slots are false). */
  active: boolean;
}

/** The canvas/proxy mosaic track: every viewport at low rate in one grid, for survey and navigation. */
export interface CanvasDescriptor {
  rows: number;
  cols: number;
  width: number;
  height: number;
  rate: RationalRate;
  codec: string;
  mimeType: string;
  bitrate: number;
}

/** A whole rig: the namespace tuple, the timing grid, the viewports, and the canvas. */
export interface RigDescriptor {
  /** MoQ Track Namespace tuple — one namespace per production, e.g. ['wave', tenant, event]. */
  namespace: string[];
  /** Stable rig identifier, used to build track names. */
  rigId: string;
  grid: TimingGrid;
  viewports: ViewportDescriptor[];
  canvas: CanvasDescriptor;
}

/** Track name for a viewport. Zero-padded so lexical order matches numeric order. */
export function viewportTrackName(viewportId: number): string {
  if (!Number.isInteger(viewportId) || viewportId < 0 || viewportId > 255) throw new RangeError('viewportId must be 0..255');
  return `viewport-${String(viewportId).padStart(2, '0')}`;
}

/** Track name for the canvas mosaic. */
export const CANVAS_TRACK_NAME = 'canvas';

/** Parse a viewport track name back to its id, or null if the name is not a viewport track. */
export function parseViewportTrackName(name: string): number | null {
  const m = /^viewport-(\d{2})$/.exec(name);
  return m ? Number(m[1]) : null;
}

// ── priority and delivery policy ───────────────────────────────────────────────────────────────────

/**
 * Subscriber Priority (draft-18 §7 / draft-19 §7.2): one byte, **lower value = higher priority**.
 * The scheduler picks lowest Subscriber Priority first, then lowest Publisher Priority, then the
 * longest-waiting stream. The whole point of the ladder below is one sentence from the brief: a
 * viewport the user is looking at must beat one they are not.
 *
 * CANVAS is deliberately the single highest-priority video on the session. It is the navigation
 * surface — lose it and the operator cannot even find the viewport they want — and it is ~1.6% of the
 * rig's bitrate, so protecting it is nearly free. PREWARM sits far below everything visible so that
 * congestion sheds speculative subscriptions first, which is exactly the tail we want dropped.
 */
export const SUBSCRIBER_PRIORITY: Record<SubscriptionIntent, number> = {
  [SUBSCRIPTION_INTENT.CANVAS]: 0,
  [SUBSCRIPTION_INTENT.AUDIO]: 8,
  [SUBSCRIPTION_INTENT.HERO]: 16,
  [SUBSCRIPTION_INTENT.SECONDARY]: 32,
  [SUBSCRIPTION_INTENT.PREWARM]: 128,
};

export function subscriberPriorityFor(intent: SubscriptionIntent): number {
  return SUBSCRIBER_PRIORITY[intent];
}

/**
 * SUBGROUP_DELIVERY_TIMEOUT per intent, in milliseconds (draft-18 §8 / §10.2.3; draft-19 makes
 * delivery timeout both a Track and an Object Property). The timeout — not a bitrate ladder — is the
 * adaptation mechanism here: the relay drops a stale subgroup instead of buffering it, so a congested
 * link degrades by shedding the tail rather than by growing latency.
 *
 * The values are keyed to the 250 ms group: PREWARM at 33 ms cannot survive even one frame time of
 * queueing and is therefore the first thing shed; HERO gets 100 ms (~6 frames of 60p) so a brief
 * congestion event does not visibly stall the on-screen viewport; CANVAS gets 500 ms — two full
 * groups — because a late canvas frame is still useful for navigation and losing it is worse than
 * showing it late.
 */
export const DELIVERY_TIMEOUT_MS: Record<SubscriptionIntent, number> = {
  [SUBSCRIPTION_INTENT.CANVAS]: 500,
  [SUBSCRIPTION_INTENT.AUDIO]: 250,
  [SUBSCRIPTION_INTENT.HERO]: 100,
  [SUBSCRIPTION_INTENT.SECONDARY]: 100,
  [SUBSCRIPTION_INTENT.PREWARM]: 33,
};

export function deliveryTimeoutMsFor(intent: SubscriptionIntent): number {
  return DELIVERY_TIMEOUT_MS[intent];
}

/**
 * Recommended ceiling on concurrent media subscriptions per session: canvas + hero + secondary
 * (+ audio). NOT 16.
 *
 * This is a measured limit, not a taste preference: published many-track MoQ measurement finds
 * aggregate throughput peaking at N=5 tracks — not 10, not 25 — with tracks desynchronising at the
 * relay beyond that (arXiv:2412.07889). A client that subscribes to all 16 viewports is therefore
 * asking for the failure mode the canvas track exists to prevent. Sixteen-way fan-out is a property
 * of the RELAY, not of the client.
 */
export const RECOMMENDED_MAX_CONCURRENT_SUBSCRIPTIONS = 4;

/** Aggregate declared bitrate of every ACTIVE viewport (bits/second) — the rig's full egress. */
export function rigAggregateBitrate(rig: RigDescriptor): number {
  return rig.viewports.filter((v) => v.active).reduce((n, v) => n + v.bitrate, 0);
}

/**
 * Bitrate a client actually carries for a given set of intents — the number that justifies the canvas
 * track. Survey-then-solo costs canvas + hero + secondary; naive all-16 costs the full aggregate.
 */
export function subscribedBitrate(rig: RigDescriptor, plan: Array<{ viewportId: number | 'canvas'; intent: SubscriptionIntent }>): number {
  let total = 0;
  for (const p of plan) {
    if (p.viewportId === 'canvas') {
      total += rig.canvas.bitrate;
      continue;
    }
    const v = rig.viewports.find((x) => x.id === p.viewportId);
    if (v) total += v.bitrate;
  }
  return total;
}
