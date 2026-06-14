// otlp-trace.ts — self-contained W3C trace-context + OTLP/HTTP-JSON span transport.
//
// The dependency-free primitives `telemetry.ts` adapts — the same vendored seam used across the
// WAVE edges (the "North Star fractal"): HTTPS-only egress (SSRF), fail-soft, DEFAULT-OFF,
// fire-and-forget. Runtime-agnostic (Web Crypto + global fetch) → a Cloudflare Worker / Durable
// Object uses it unchanged. Mirrors the org-standard @wave-av/observability surface; vendored (not
// a GitHub-Packages dependency) so this Worker's wrangler build/deploy needs no extra registry auth.
// When that package ships to a registry this repo can install from, telemetry.ts repoints its
// import there and this module is deleted — the public adapter surface (telemetry.ts) never changes.

const DEFAULT_SERVICE = 'wave-moq-edge';

/** A parsed/derived W3C trace-context. All fields lowercase hex; `flags` is 2 hex chars. */
export interface TraceParent {
  traceId: string;
  spanId: string;
  flags: string;
}

/** Operator-supplied telemetry config. NEVER request-derived (SSRF). All optional → default-OFF. */
export interface NotifyEnv {
  SENTRY_DSN?: string;
  OPS_WEBHOOK_URL?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  WAVE_SERVICE?: string;
}

// ── W3C trace-context ──────────────────────────────────────────────────────────────────────
// Anchored, single-class regex — no quantifier backtracking, so an attacker-controlled inbound
// header can't trigger ReDoS. Combined with fixed-length checks below.
const HEX = /^[0-9a-f]+$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/** Cryptographically-random lowercase hex of `bytes` length, via Web Crypto (Workers & Node 18+). */
function randHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a); // Workers global Web Crypto (@cloudflare/workers-types)
  let s = '';
  for (const b of a) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Strictly parse an UNTRUSTED inbound `traceparent`. Returns null on ANY malformation so the caller
 * mints a fresh root rather than propagating a bogus/hostile context. Rejects: wrong arity, wrong
 * field lengths, non-hex, the invalid 'ff' version, and the all-zero trace/span ids the spec forbids.
 */
export function parseTraceparent(header: string | null): TraceParent | null {
  if (!header) return null;
  const parts = header.split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, flags] = parts;
  if (version.length !== 2 || traceId.length !== 32 || spanId.length !== 16 || flags.length !== 2) return null;
  if (!HEX.test(version) || !HEX.test(traceId) || !HEX.test(spanId) || !HEX.test(flags)) return null;
  if (version === 'ff') return null; // 0xff is reserved/invalid
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null; // all-zero ids are forbidden
  return { traceId, spanId, flags };
}

/** A fresh root context (no inbound parent) — new trace + span, sampled. */
export function rootTraceparent(): TraceParent {
  return { traceId: randHex(16), spanId: randHex(8), flags: '01' };
}

/** A child of `parent` — same trace + sampling, a fresh span id. */
export function childTraceparent(parent: TraceParent): TraceParent {
  return { traceId: parent.traceId, spanId: randHex(8), flags: parent.flags };
}

/** Build the W3C `traceparent` header (+ an optional attestation id) to echo / forward. */
export function traceHeaders(span: TraceParent, attestationId?: string): Record<string, string> {
  const h: Record<string, string> = { traceparent: `00-${span.traceId}-${span.spanId}-${span.flags}` };
  if (attestationId) h['x-wave-attestation-id'] = attestationId;
  return h;
}

// ── OTLP/HTTP-JSON span export ───────────────────────────────────────────────────────────────

/** One span to export. `attributes` MUST be anonymized dims only (no content/PII — CWE-200). */
export interface SpanInput {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, string | number | boolean>;
  status: 'ok' | 'error';
  service: string;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean }>;

const realFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as Promise<{ ok: boolean }>;

/** Allow tests to inject a (possibly throwing) transport without real network egress. */
let fetchImpl: FetchLike = realFetch;
export function __setFetchImpl(f: FetchLike | null): void {
  fetchImpl = f ?? realFetch;
}

/** `k=v,k2=v2` → header map (OTEL_EXPORTER_OTLP_HEADERS — an operator secret; never logged). */
function parseHeaders(s?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const pair of s.split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

/** Map a flat dim bag onto OTLP `KeyValue[]` (typed AnyValue). Ints stay ints; floats → double. */
function otlpAttrs(a: Record<string, string | number | boolean>): unknown[] {
  return Object.entries(a).map(([key, v]) => ({
    key,
    value:
      typeof v === 'number'
        ? Number.isInteger(v)
          ? { intValue: String(v) }
          : { doubleValue: v }
        : typeof v === 'boolean'
          ? { boolValue: v }
          : { stringValue: v },
  }));
}

/**
 * Export ONE span over OTLP/HTTP-JSON. DEFAULT-OFF (no endpoint → no-op), HTTPS-only (refuse
 * plaintext egress — SSRF), fire-and-forget, and wrapped fail-soft: it never throws and never
 * blocks or alters the relay / the billing emit. trace/span ids are lowercase hex (OTLP/JSON's
 * special-case); timestamps are nanosecond strings.
 */
export async function emitSpan(env: NotifyEnv, s: SpanInput): Promise<void> {
  try {
    const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!base) return; // DEFAULT-OFF
    if (!base.startsWith('https://')) return; // SSRF: no plaintext telemetry egress
    const url = base.replace(/\/+$/, '') + '/v1/traces';
    const ns = (ms: number) => String(Math.round(ms * 1e6));
    const span: Record<string, unknown> = {
      traceId: s.traceId,
      spanId: s.spanId,
      name: s.name,
      kind: 2, // SPAN_KIND_SERVER
      startTimeUnixNano: ns(s.startMs),
      endTimeUnixNano: ns(s.endMs),
      attributes: otlpAttrs(s.attributes),
      status: { code: s.status === 'error' ? 2 : 1 }, // ERROR : OK
    };
    if (s.parentSpanId) span.parentSpanId = s.parentSpanId;
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: otlpAttrs({ 'service.name': s.service }) },
          scopeSpans: [{ scope: { name: s.service }, spans: [span] }],
        },
      ],
    });
    void fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS) },
      body,
    }).catch(() => {});
  } catch {
    /* best-effort — observability must never break the relay */
  }
}

/**
 * Capture an ops event (an error/warning) to the operator webhook. DEFAULT-OFF (no
 * OPS_WEBHOOK_URL → no-op), HTTPS-only (SSRF), fire-and-forget, fail-soft.
 */
export async function notifyOps(
  env: NotifyEnv,
  message: string,
  extra: Record<string, unknown>,
  level: 'error' | 'warn' | 'info' = 'error',
): Promise<void> {
  try {
    const url = env.OPS_WEBHOOK_URL;
    if (!url) return; // DEFAULT-OFF
    if (!url.startsWith('https://')) return; // SSRF
    const body = JSON.stringify({ service: env.WAVE_SERVICE || DEFAULT_SERVICE, level, message, extra });
    void fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {});
  } catch {
    /* best-effort */
  }
}
