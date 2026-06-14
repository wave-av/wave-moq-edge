// telemetry.ts — wave-moq-edge's org-standard, customer-exportable OTLP session telemetry (B.4).
//
// ONE OTLP SESSION span per publisher session, emitted at session end (the `publish_end` hook in
// the Durable Object, alongside the #284 billing usage emit). Each session is its own trace (a
// fresh ROOT — a long-lived WebTransport/WS session has no per-request inbound traceparent). The
// span carries AGGREGATE metrics ONLY (bytes/frames/reconnects/duration) — NEVER the billing org,
// the namespace/track key (a customer content identifier), or the sessionId (CWE-200), because it
// is exported to a third-party collector. DEFAULT-OFF (no-op until OTEL_EXPORTER_OTLP_ENDPOINT is
// set), fail-soft (never throws, never blocks the relay or the billing emit), https-only (SSRF).
//
// The W3C/OTLP primitives are the dependency-free ./otlp-trace seam (vendored so this Worker's
// wrangler build/deploy needs no extra registry auth; mirrors @wave-av/observability — repoint +
// delete when it ships to a public registry).

import { rootTraceparent, emitSpan, notifyOps, type NotifyEnv } from './otlp-trace';

const SERVICE = 'wave-moq-edge';

/** Telemetry config — OPERATOR-supplied DO bindings, NEVER request-derived (SSRF). All DEFAULT-OFF. */
export interface MoqObsEnv {
  SENTRY_DSN?: string;
  OPS_WEBHOOK_URL?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  WAVE_SERVICE?: string;
}

/** Project onto the NotifyEnv shape the primitives read (DO Env can't `extends NotifyEnv` — its
 *  KV/R2/DO bindings aren't string → index-signature clash — so we hand-pick the fields). */
function obsEnv(env: MoqObsEnv): NotifyEnv {
  return {
    SENTRY_DSN: env.SENTRY_DSN,
    OPS_WEBHOOK_URL: env.OPS_WEBHOOK_URL,
    OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_EXPORTER_OTLP_HEADERS: env.OTEL_EXPORTER_OTLP_HEADERS,
    WAVE_SERVICE: env.WAVE_SERVICE || SERVICE,
  };
}

/** The anonymized, AGGREGATE shape of a finished session. No org / track key / sessionId. */
export interface MoqSessionDims {
  /** Wall-clock session duration in ms (span end − start). */
  sessionMs: number;
  bytes: number;
  frames: number;
  reconnects: number;
  /** Whether the session ended cleanly. */
  status?: 'ok' | 'error';
}

/**
 * Emit ONE OTLP span for a finished publisher session (DEFAULT-OFF, never throws, best-effort,
 * fire-and-forget). A fresh ROOT trace per session. Carries aggregate metrics ONLY (CWE-200).
 */
export async function emitMoqSessionSpan(env: MoqObsEnv, d: MoqSessionDims, now: () => number = Date.now): Promise<void> {
  const span = rootTraceparent();
  const end = now();
  const start = end - Math.max(0, d.sessionMs);
  await emitSpan(obsEnv(env), {
    name: 'moq.session',
    traceId: span.traceId,
    spanId: span.spanId,
    startMs: start,
    endMs: end,
    attributes: {
      'wave.moq.duration_ms': Math.max(0, d.sessionMs),
      'wave.moq.bytes': d.bytes,
      'wave.moq.frames': d.frames,
      'wave.moq.reconnects': d.reconnects,
    },
    status: d.status === 'error' ? 'error' : 'ok',
    service: SERVICE,
  });
}

/** Capture a relay error → Sentry/webhook (DEFAULT-OFF, best-effort, never throws). */
export async function captureMoqError(env: MoqObsEnv, err: unknown, where: string): Promise<void> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const extra: Record<string, unknown> = { where };
  if (err instanceof Error && err.stack) extra.stack = err.stack;
  await notifyOps(obsEnv(env), message, extra, 'error');
}
