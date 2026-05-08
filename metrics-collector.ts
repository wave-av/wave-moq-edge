/// <reference types="@cloudflare/workers-types" />
/**
 * MoQ Metrics Collector — minimal working scaffold (2026-05-07).
 *
 * Per WAVE moq-edge strategy doc, real metrics flow into Workers Analytics
 * Engine via the DO's metrics emitter. This class is the abstraction over
 * that path. The previous metrics-collector.ts (now .broken-2026-05-07) was
 * Python-to-TS conversion artifacts — discarded.
 *
 * Week-2 work fills in:
 *   - per-session bandwidth tracking
 *   - object-level latency histograms
 *   - publisher congestion signals
 *   - subscriber drop-out reasons
 */

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
  constructor(private env: Env) {}

  /**
   * Record a single MoQ event. Future: write to Workers Analytics Engine
   * dataset for time-series queries. For now, no-op (DO emits its own state).
   */
  async record(metric: MoqMetric): Promise<void> {
    // Placeholder — wire to Analytics Engine in week 2.
    void this.env;
    void metric;
  }
}
