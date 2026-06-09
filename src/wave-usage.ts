/**
 * WAVE R4 metering schema — the TypeScript mirror of the Media Engine's `wave.usage` event.
 *
 * The canonical contract lives in the engine core as C++:
 *   the media engine → engine/media-adapter.h  (struct UsageMeter + usage_json())
 * Per GUARDRAIL.md (Rule 2), edge relays live in wave-*-edge and CONSUME the engine. A Cloudflare
 * Worker can't link the C++ core, so this file MIRRORS the contract field-for-field — every native
 * adapter (NDI/SRT/OMT/Dante/ST2110) and every cloud relay (MoQ here) emits the SAME shape, so one
 * billing + observability pipeline ingests them all (→ R4 → billing #127). Keep in sync with the
 * engine header; field names/nesting must match usage_json() exactly.
 */

/** Mirror of the engine R1 clock_status_json() sub-object. */
export interface WaveClockStatus {
  source: 'ptp' | 'ntp' | 'monotonic' | 'edge';
  offset_ns: number;
  locked: boolean;
  gm: string; // grandmaster id / clock label ("" if none)
}

/** Mirror of engine UsageMeter.integrity (post-recovery loss accounting). */
export interface WaveIntegrity {
  checked: number;
  matches: number;
  mismatches: number;
  reorders: number;
  gaps: number;
}

/** Mirror of engine UsageMeter + the serialized `wave.usage` line. */
export interface WaveUsage {
  protocol: string; // "moq" | "ndi" | "srt" | …
  direction: 'in' | 'out';
  frames: number;
  bytes: number;
  fps: number;
  audio_samples: number;
  sample_rate: number;
  channels: number;
  av_drift_ms: number;
  reconnects: number;
  rate_n: number;
  rate_d: number;
  res: string; // "WxH" ("0x0" when N/A, e.g. a relay that doesn't decode)
  integrity: WaveIntegrity;
  clock: WaveClockStatus;
}

/** A zeroed meter for `protocol`/`direction` — start here and accumulate. */
export function newUsage(protocol: string, direction: 'in' | 'out'): WaveUsage {
  return {
    protocol,
    direction,
    frames: 0,
    bytes: 0,
    fps: 0,
    audio_samples: 0,
    sample_rate: 0,
    channels: 0,
    av_drift_ms: 0,
    reconnects: 0,
    rate_n: 0,
    rate_d: 0,
    res: '0x0',
    integrity: { checked: 0, matches: 0, mismatches: 0, reorders: 0, gaps: 0 },
    clock: edgeClock(),
  };
}

/**
 * The edge clock. Cloudflare's runtime wallclock is NTP-disciplined infrastructure time, so we report
 * source "edge" with a zero local offset and locked=true (no /dev/ptp0 at the edge — PTP discipline is
 * an on-prem/relay concern, see the media engine R1.P2). Mirrors the engine clock sub-object shape.
 */
export function edgeClock(): WaveClockStatus {
  return { source: 'edge', offset_ns: 0, locked: true, gm: '' };
}

/**
 * Serialize to the canonical `wave.usage` line. Field order matches the engine's usage_json() so a
 * consumer can diff edge vs native output. (JSON object key order is insignificant to parsers, but we
 * keep it identical for human/byte comparison.)
 */
export function usageJson(m: WaveUsage): string {
  return JSON.stringify({
    protocol: m.protocol,
    direction: m.direction,
    frames: m.frames,
    bytes: m.bytes,
    fps: m.fps,
    audio_samples: m.audio_samples,
    sample_rate: m.sample_rate,
    channels: m.channels,
    av_drift_ms: m.av_drift_ms,
    reconnects: m.reconnects,
    rate_n: m.rate_n,
    rate_d: m.rate_d,
    res: m.res,
    integrity: m.integrity,
    clock: m.clock,
  });
}
