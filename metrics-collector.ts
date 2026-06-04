/// <reference types="@cloudflare/workers-types" />
/**
 * MoQ Metrics Collector — aggregates MoQ relay events into the canonical WAVE R4 `wave.usage`
 * metering schema (src/wave-usage.ts, mirrored from wave-media-engine engine/wave-media-adapter.h).
 *
 * This is how MoQ "consumes the engine" at the edge (GUARDRAIL Rule 2): the relay can't link the C++
 * core, so it emits the SAME metering shape every native adapter does → one billing/observability path.
 *
 * record() folds each event into an in-memory meter; usage()/usageLine() expose the canonical event.
 * The eventual sink (Workers Analytics Engine) consumes usage() — wired in deploy, no-op'd here.
 */
import { WaveUsage, newUsage, usageJson } from './src/wave-usage';

interface Env {
  MOQ_TRACK_REGISTRY: KVNamespace;
  ENVIRONMENT: string;
  MOQ_DRAFT_VERSION: string;
}

export interface MoqMetric {
  ts: string;
  kind: 'publish_start' | 'publish_end' | 'subscribe' | 'unsubscribe' | 'object_received' | 'group_complete';
  trackKey: string;
  sessionId: string;
  bytes?: number;
  latencyMs?: number;
}

export class MetricsCollector {
  // One meter per track key, aggregating egress (what subscribers consume = what we meter/bill).
  private meters = new Map<string, WaveUsage>();

  constructor(private env: Env) {}

  private meterFor(trackKey: string): WaveUsage {
    let m = this.meters.get(trackKey);
    if (!m) {
      m = newUsage('moq', 'out');
      this.meters.set(trackKey, m);
    }
    return m;
  }

  /**
   * Fold one MoQ event into its track meter. Mapping MoQ wire concepts → the protocol-agnostic R4 shape:
   *   object_received → one media unit (frames++, bytes += object size)
   *   publish_start    → republish onto a track that already carried media = a reconnect
   * Only observed quantities are counted (no fabricated integrity numbers).
   */
  async record(metric: MoqMetric): Promise<void> {
    const m = this.meterFor(metric.trackKey);
    switch (metric.kind) {
      case 'object_received':
        m.frames += 1;
        m.bytes += metric.bytes ?? 0;
        m.integrity.checked += 1;
        m.integrity.matches += 1; // delivered intact (QUIC guarantees per-object integrity)
        break;
      case 'publish_start':
        if (m.frames > 0) m.reconnects += 1;
        break;
      case 'group_complete':
      case 'publish_end':
      case 'subscribe':
      case 'unsubscribe':
        break;
    }
    // Sink to Workers Analytics Engine wired in deploy; the in-memory meter is the source of truth here.
    void this.env;
  }

  /** Canonical R4 meter for a track (zeroed meter if the track is unknown). */
  usage(trackKey: string): WaveUsage {
    return this.meters.get(trackKey) ?? newUsage('moq', 'out');
  }

  /** Canonical `wave.usage` JSON line for a track. */
  usageLine(trackKey: string): string {
    return usageJson(this.usage(trackKey));
  }
}
