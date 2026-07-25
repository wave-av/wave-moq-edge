/**
 * ViewportTrackSet — the rig's tracks bound to the relay path we actually run.
 *
 * TOPOLOGY, decided: **N independent MoQ Tracks (one per viewport) + one low-rate canvas/proxy track,
 * with pose and the PTP capture instant riding as Object Properties on the media objects themselves.
 * No metadata sidecar track. No subgroup packing.**
 *
 * Why each half:
 *   • One Track per viewport, not one Subgroup per viewport. A Subgroup is pinned to a single stream
 *     and may not be split (draft-18 §11 subgroup-header / draft-19 §2.2), so packing viewports into
 *     subgroups of one track would give up independent subscribe, independent priority, independent
 *     cancellation and independent delivery timeout — every knob the congestion policy needs.
 *   • A canvas track, because the alternative to "survey 16 viewports cheaply" is "subscribe to all
 *     16", which is both ~64x the bitrate for the same navigation and past the measured many-track
 *     ceiling (arXiv:2412.07889 finds throughput peaking at N=5 tracks, with tracks desynchronising
 *     at the relay beyond it). The canvas turns 16-way fan-out into a RELAY property instead of a
 *     CLIENT property, which is the entire trick.
 *   • Properties on the object rather than a sidecar track, because a sidecar has its own timeout and
 *     its own scheduling slot and therefore decouples from the frame exactly when the network is
 *     worst. See viewport-properties.ts.
 *
 * This module is the thin binding: it wraps `MoqTrackSet` (which already routes control/object frames
 * to a per-track `MoqRelay`) with the rig's track names, the PTP mapping and the property codec. It
 * stays PURE and transport-agnostic like everything under it — the Durable Object still owns sockets,
 * auth and metering.
 */
import { MoqTrackSet } from './moq-trackset';
import type { ControlResult, Outbound, RelayEvent } from './moq-relay';
import { decodeObject, encodeObject, MOQ_OBJECT_STATUS } from './moq-wire';
import { rigTrackNames } from './viewport-catalog';
import {
  CANVAS_TRACK_NAME,
  ClockGuard,
  CLOCK_STATE,
  deliveryTimeoutMsFor,
  subscriberPriorityFor,
  viewportTrackName,
  type ClockState,
  type GridLocation,
  type RigDescriptor,
  type SubscriptionIntent,
  type ViewportPose,
} from './viewport-model';
import { encodeViewportProperties, decodeViewportProperties, type ViewportObjectMeta } from './viewport-properties';

/** One frame handed to the rig for publication. */
export interface ViewportFrame {
  /** Viewport id, or 'canvas' for the mosaic track. */
  source: number | 'canvas';
  /** PTP capture instant, TAI nanoseconds. THE input to the mapping. */
  captureTaiNs: bigint;
  payload: Uint8Array;
  /** Per-frame pose. Omit for a fixed camera whose catalog pose is authoritative. */
  pose?: ViewportPose;
  /** What the PTP stack reports. Defaults to LOCKED. */
  servo?: ClockState;
}

/** What publishing one frame produced. */
export interface PublishResult {
  trackName: string;
  location: GridLocation;
  clockState: ClockState;
  /** True when a backward clock step forced a monotonic clamp — the object is still emitted. */
  clamped: boolean;
  frame: Uint8Array;
  fanout: Outbound[];
  events: RelayEvent[];
}

/** The per-track delivery policy a subscriber (or the DO) applies when it subscribes. */
export interface TrackDeliveryPolicy {
  trackName: string;
  intent: SubscriptionIntent;
  /** draft-18 §7 Subscriber Priority — one byte, LOWER value = HIGHER priority. */
  subscriberPriority: number;
  /** draft-18 §8 SUBGROUP_DELIVERY_TIMEOUT, milliseconds. */
  deliveryTimeoutMs: number;
}

export class ViewportTrackSet {
  private readonly set: MoqTrackSet;
  /** One clock guard per track: monotonicity is a per-track invariant, not a rig-wide one. */
  private readonly guards = new Map<string, ClockGuard>();

  constructor(
    private readonly rig: RigDescriptor,
    opts: { cachedGroups?: number } = {},
  ) {
    const names = rigTrackNames(rig);
    this.set = new MoqTrackSet(names, opts);
    for (const n of names) this.guards.set(n, new ClockGuard(rig.grid));
  }

  get trackNames(): string[] {
    return this.set.trackNames;
  }
  get trackSet(): MoqTrackSet {
    return this.set;
  }

  /** Track name for a frame source. */
  static trackNameFor(source: number | 'canvas'): string {
    return source === 'canvas' ? CANVAS_TRACK_NAME : viewportTrackName(source);
  }

  /** Route one control frame (SETUP / PUBLISH_NAMESPACE / SUBSCRIBE / …) to a viewport's relay. */
  onControl(source: number | 'canvas', sessionId: string, frame: Uint8Array): ControlResult {
    return this.set.onControl(ViewportTrackSet.trackNameFor(source), sessionId, frame);
  }

  /** Drop a session from every track of the rig. */
  removeSession(sessionId: string): RelayEvent[] {
    return this.set.removeSession(sessionId);
  }

  /**
   * Encode one captured frame as a MoQ object — Group/Object derived from the PTP instant, viewport
   * identity and the exact capture instant attached as Object Properties — and push it through the
   * track's relay so every subscriber of THAT track (and only that track) receives it.
   *
   * `trackAlias` is 0 on the way in: the relay re-stamps every forwarded object with its own alias,
   * which is what makes the alias consistent for subscribers regardless of the publisher.
   */
  publish(sessionId: string, f: ViewportFrame): PublishResult {
    const trackName = ViewportTrackSet.trackNameFor(f.source);
    const guard = this.guards.get(trackName);
    if (!guard) throw new RangeError(`unknown viewport source ${String(f.source)}`);

    const mapped = guard.next(f.captureTaiNs, f.servo ?? CLOCK_STATE.LOCKED);
    const meta: ViewportObjectMeta = {
      viewportId: f.source === 'canvas' ? undefined : f.source,
      // The EXACT instant, not the slot. Group/Object recover the slot; only this recovers the time.
      captureTaiNs: f.captureTaiNs,
      clockState: mapped.clockState,
      ...(f.pose ? { pose: f.pose } : {}),
      rigId: this.rig.rigId,
    };
    const frame = encodeObject({
      trackAlias: 0n,
      groupId: mapped.groupId,
      objectId: mapped.objectId,
      status: MOQ_OBJECT_STATUS.NORMAL,
      payload: f.payload,
      properties: encodeViewportProperties(meta),
    });
    const { fanout, events } = this.set.onObject(trackName, sessionId, frame);
    return {
      trackName,
      location: { frameIndex: mapped.frameIndex, groupId: mapped.groupId, objectId: mapped.objectId },
      clockState: mapped.clockState,
      clamped: mapped.clamped,
      frame,
      fanout,
      events,
    };
  }

  /** The priority + delivery-timeout policy for a subscription plan. */
  deliveryPolicy(plan: Array<{ source: number | 'canvas'; intent: SubscriptionIntent }>): TrackDeliveryPolicy[] {
    return plan.map((p) => ({
      trackName: ViewportTrackSet.trackNameFor(p.source),
      intent: p.intent,
      subscriberPriority: subscriberPriorityFor(p.intent),
      deliveryTimeoutMs: deliveryTimeoutMsFor(p.intent),
    }));
  }
}

/**
 * Decode a fanned-out object frame back into its location + viewport metadata — the subscriber-side
 * helper, and the proof that the properties survived the relay's decode/re-encode round trip.
 */
export function readViewportObject(objectFrame: Uint8Array): { groupId: bigint; objectId: bigint; bytes: number; meta: ViewportObjectMeta } {
  const o = decodeObject(objectFrame);
  return {
    groupId: o.groupId,
    objectId: o.objectId,
    bytes: o.payload.length,
    meta: o.properties ? decodeViewportProperties(o.properties) : {},
  };
}
