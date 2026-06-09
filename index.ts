/// <reference types="@cloudflare/workers-types" />
/**
 * WAVE MoQ Edge Relay — Cloudflare Worker entry point
 *
 * Implements IETF MoQ Transport (https://datatracker.ietf.org/doc/draft-ietf-moq-transport/).
 * Currently advertises preferred=draft-18 with negotiation matrix draft-07..draft-18.
 * Acts as a publish/subscribe relay for sub-second live media at the edge.
 *
 * Routing:
 *   POST   /v1/publish/:namespace/:track          → Become publisher (returns WebTransport URL)
 *   GET    /v1/subscribe/:namespace/:track        → WebTransport subscribe endpoint
 *   GET    /v1/track/:namespace/:track            → Track metadata (subscriber count, last activity)
 *   GET    /v1/announce                           → List announced tracks (for discovery)
 *   GET    /health                                → Liveness probe
 *   GET    /metrics                               → Prometheus-format metrics
 *
 * Each track gets a Durable Object instance for fan-out + state. The DO holds:
 *   - Publisher session (1 per track)
 *   - Subscribers (up to MAX_SUBSCRIBERS_PER_TRACK)
 *   - Object cache (last N groups for late-joiners)
 *
 * Why DO: WebTransport sessions are sticky to one Worker instance, but viewers are global.
 * The DO acts as the rendezvous point — all subscribers + the publisher meet at the same DO,
 * and the DO does the multiplex.
 */

import { z } from 'zod';
import { MOQSessionDurableObject } from './moq-session-do';
import { MetricsCollector } from './metrics-collector';
import { wavePublicPage, wavePublicErrorResponse } from './src/shared/wave-public-html';
import { scopeGate, MOQ_SCOPE_WRITE, MOQ_SCOPE_READ } from './src/wave-auth';

// Re-export DO under the binding name wrangler.toml expects
export { MOQSessionDurableObject as MoqSessionDO };

// The shared WAVE curled-wave mark, flat-filled to the MoQ accent (#00d4d5 — accent-wheel.md
// streaming family, oklch(0.78 0.15 195)). Mark path is verbatim from the foundation favicon
// template; the fill is hex (standalone favicons can't rely on oklch()).
const MOQ_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 102"><title>WAVE</title><g transform="translate(-55.797,177.088) scale(0.024,-0.024)" fill="#00d4d5" stroke="none"><path d="M5055 7373 c-222 -26 -372 -59 -559 -123 -542 -184 -1021 -519 -1397 -980 -438 -535 -683 -1114 -761 -1795 -24 -207 -13 -775 14 -775 16 0 217 123 368 224 359 241 729 567 1156 1017 466 491 757 732 1081 897 247 126 458 178 683 169 277 -11 487 -99 680 -284 194 -184 305 -402 333 -650 38 -343 -148 -743 -438 -943 -262 -180 -592 -170 -791 25 -141 140 -188 357 -125 582 25 86 99 256 135 309 14 21 24 39 22 41 -6 7 -129 -83 -203 -149 -177 -156 -306 -352 -369 -563 -24 -79 -28 -107 -28 -230 0 -160 13 -220 74 -352 124 -265 364 -476 660 -581 155 -55 236 -67 435 -66 150 0 196 4 274 22 291 69 536 208 762 432 301 297 482 651 560 1095 19 105 23 167 23 325 1 259 -25 431 -100 680 -83 272 -251 577 -453 820 -434 523 -1196 868 -1896 858 -60 0 -123 -3 -140 -5z"/></g></svg>`;

interface Env {
  MOQ_SESSIONS: DurableObjectNamespace;
  MOQ_TRACK_REGISTRY: KVNamespace;
  MOQ_RECORDINGS: R2Bucket;
  ENVIRONMENT: string;
  MOQ_DRAFT_VERSION: string;
  MAX_SUBSCRIBERS_PER_TRACK: string;
  MAX_OBJECT_SIZE_BYTES: string;
  LOG_LEVEL: string;
  MOQ_REQUIRE_AUTH?: string; // when truthy, enforce wave-token-v1 on publish/subscribe (default: off)
}

const PublishRequestSchema = z.object({
  namespace: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase alphanumeric + dash only'),
  track: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase alphanumeric + dash only'),
});

function trackKey(namespace: string, track: string): string {
  return `${namespace}/${track}`;
}

function getDO(env: Env, namespace: string, track: string): DurableObjectStub {
  const id = env.MOQ_SESSIONS.idFromName(trackKey(namespace, track));
  return env.MOQ_SESSIONS.get(id);
}

async function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

async function errorResponse(title: string, status: number, detail?: string): Promise<Response> {
  return jsonResponse(
    {
      type: `https://httpstatuses.io/${status}`,
      title,
      status,
      detail,
    },
    status
  );
}

function isWebSocketUpgrade(request: Request): boolean {
  return (request.headers.get('Upgrade') ?? '').toLowerCase() === 'websocket';
}

async function handlePublish(env: Env, namespace: string, track: string, request: Request): Promise<Response> {
  // MoQ scope gate (no-op unless MOQ_REQUIRE_AUTH is enabled) — reject before touching KV/the DO.
  // When enforced, publishing requires the canonical moq:write scope on the gateway-injected principal.
  const denied = scopeGate(request, env, MOQ_SCOPE_WRITE);
  if (denied) return denied;

  const parsed = PublishRequestSchema.safeParse({ namespace, track });
  if (!parsed.success) {
    return errorResponse('Invalid namespace/track', 400, parsed.error.message);
  }

  // Register track in KV (for /announce + /catalog discovery)
  const key = trackKey(namespace, track);
  await env.MOQ_TRACK_REGISTRY.put(`track:${key}`, JSON.stringify({
    namespace,
    track,
    publisher_started_at: new Date().toISOString(),
    region: request.cf?.colo ?? 'unknown',
  }), { expirationTtl: 86400 }); // 24h auto-cleanup

  // Forward to the DO: a WebSocket upgrade becomes the live MoQ relay publisher session; a plain
  // POST is the legacy JSON registration. The DO handles both.
  const doStub = getDO(env, namespace, track);
  return doStub.fetch(request);
}

async function handleSubscribe(env: Env, namespace: string, track: string, request: Request): Promise<Response> {
  // MoQ scope gate (no-op unless MOQ_REQUIRE_AUTH is enabled) — reject before touching KV/the DO.
  // When enforced, subscribing requires the canonical moq:read scope on the gateway-injected principal.
  const denied = scopeGate(request, env, MOQ_SCOPE_READ);
  if (denied) return denied;

  const parsed = PublishRequestSchema.safeParse({ namespace, track });
  if (!parsed.success) {
    return errorResponse('Invalid namespace/track', 400, parsed.error.message);
  }

  // A WebSocket subscribe forwards straight to the DO relay (it tolerates a not-yet-publishing
  // track — the subscriber simply receives nothing until the publisher attaches). The legacy JSON
  // subscribe-register path keeps the 404-if-unknown guard for HTTP discovery clients.
  if (!isWebSocketUpgrade(request)) {
    const registryEntry = await env.MOQ_TRACK_REGISTRY.get(`track:${trackKey(namespace, track)}`);
    if (!registryEntry) {
      return errorResponse('Track not found or no active publisher', 404, `${namespace}/${track}`);
    }
  }

  const doStub = getDO(env, namespace, track);
  return doStub.fetch(request);
}

async function handleTrackMetadata(env: Env, namespace: string, track: string): Promise<Response> {
  const entry = await env.MOQ_TRACK_REGISTRY.get(`track:${trackKey(namespace, track)}`);
  if (!entry) {
    return errorResponse('Track not found', 404);
  }
  // Get DO state for live counts
  const doStub = getDO(env, namespace, track);
  const stateResp = await doStub.fetch(new Request('https://internal/state'));
  if (!stateResp.ok) {
    return jsonResponse({ ...JSON.parse(entry), live: false });
  }
  const state = (await stateResp.json()) as Record<string, unknown>;
  return jsonResponse({ ...JSON.parse(entry), ...state });
}

async function handleAnnounce(env: Env): Promise<Response> {
  // List up to 100 announced tracks. KV LIST is paginated; cap for response size.
  const list = await env.MOQ_TRACK_REGISTRY.list({ prefix: 'track:', limit: 100 });
  const tracks = await Promise.all(
    list.keys.map(async (k) => {
      const v = await env.MOQ_TRACK_REGISTRY.get(k.name);
      return v ? JSON.parse(v) : null;
    })
  );
  return jsonResponse({ tracks: tracks.filter(Boolean), count: tracks.filter(Boolean).length });
}

/**
 * /v1/catalog — IETF draft-ietf-moq-catalog implementation.
 * Returns a JSON catalog listing all tracks at this relay with their MoQ
 * track aliases, group orders, and capability profiles. Subscribers use
 * this for track discovery.
 *
 * Format follows draft-ietf-moq-catalog-01 (subset). Cloudflare's reference
 * implementation does NOT yet expose a catalog endpoint as of 2026-05-07,
 * making WAVE the first public-facing MoQ catalog at the relay edge.
 */
async function handleCatalog(env: Env, request: Request): Promise<Response> {
  const list = await env.MOQ_TRACK_REGISTRY.list({ prefix: 'track:', limit: 1000 });
  const entries = await Promise.all(
    list.keys.map(async (k) => {
      const v = await env.MOQ_TRACK_REGISTRY.get(k.name);
      if (!v) return null;
      const parsed = JSON.parse(v);
      return parsed;
    })
  );

  const catalog = {
    version: '01',
    catalog_format: 'draft-ietf-moq-catalog',
    relay_id: 'wave-moq-edge',
    relay_environment: env.ENVIRONMENT,
    moq_draft_version: env.MOQ_DRAFT_VERSION,
    generated_at: new Date().toISOString(),
    cf_colo: request.cf?.colo ?? 'unknown',
    tracks: entries
      .filter(Boolean)
      .map((e: { namespace: string; track: string; publisher_started_at?: string; region?: string }) => ({
        namespace: e.namespace,
        name: e.track,
        track_namespace: [e.namespace, e.track],
        // Default capability profile (real impl reads from DO state):
        capabilities: {
          group_order: 'ascending',
          forwarding: 'object',
          delivery_timeout_ms: 5000,
        },
        publisher_started_at: e.publisher_started_at ?? null,
        publisher_region: e.region ?? null,
      })),
    track_count: entries.filter(Boolean).length,
  };

  return jsonResponse(catalog);
}

async function handleHealth(env: Env): Promise<Response> {
  return jsonResponse({
    ok: true,
    service: 'moq-edge',
    environment: env.ENVIRONMENT,
    moq_draft: env.MOQ_DRAFT_VERSION,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Branded HTML landing page at GET /. First adopter of
 * workers/shared/wave-public-html.ts per ADR-0149 §B (P1 migration target).
 *
 * Public-facing surface — every visitor sees:
 *  - WAVE wordmark + brand-aligned dark surface
 *  - Live track count (read from KV registry)
 *  - MoQ draft version + environment badge
 *  - Quick-link section to /v1/announce, /v1/catalog, /health, /metrics
 *  - WCAG 2.2 AA compliance (4.5:1 contrast, focus rings, skip-link)
 *
 * Aggressively cached at the edge for 30s — track count is approximate by
 * design so repeat visitors don't pay KV-list every hit.
 */
async function handleHtmlRoot(env: Env, request: Request): Promise<Response> {
  // Best-effort live track count. KV LIST is paginated; cap at 100 for response time.
  let trackCount = 0;
  try {
    const list = await env.MOQ_TRACK_REGISTRY.list({ prefix: 'track:', limit: 100 });
    trackCount = list.keys.length;
  } catch {
    // Fallback to 0 if KV throttled — not worth failing the landing page
  }
  const region = (request.cf as { colo?: string } | undefined)?.colo ?? 'edge';

  const html = wavePublicPage({
    title: 'MoQ relay',
    subtitle: `Sub-second live media at the edge. IETF draft-ietf-moq-transport-${env.MOQ_DRAFT_VERSION}. Built by WAVE Online.`,
    status: 'operational',
    accent: '#00d4d5',
    canonical: `https://${request.headers.get('host') ?? 'moq.wave.online'}/`,
    stats: [
      { label: 'Active tracks', value: trackCount.toString(), mono: true },
      { label: 'MoQ draft', value: env.MOQ_DRAFT_VERSION, mono: true },
      { label: 'Environment', value: env.ENVIRONMENT },
      { label: 'Region', value: region, mono: true },
    ],
    children: `
      <h2 style="font-size:1.4rem;margin-top:32px;margin-bottom:12px">Endpoints</h2>
      <pre>POST   /v1/publish/:namespace/:track       Publish a track (WebSocket upgrade → relay publisher)
GET    /v1/subscribe/:namespace/:track     Subscribe to a track (WebSocket upgrade → relay subscriber)
GET    /v1/track/:namespace/:track         Track metadata + live counts
GET    /v1/announce                        List all announced tracks
GET    /v1/catalog                         draft-ietf-moq-catalog-01 listing
GET    /health                             Liveness probe (JSON)
GET    /metrics                            Prometheus exposition</pre>

      <h2 style="font-size:1.4rem;margin-top:32px;margin-bottom:12px">Quick links</h2>
      <ul style="list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:12px">
        <li><a href="/v1/announce">Active tracks (JSON)</a></li>
        <li><a href="/v1/catalog">MoQ catalog</a></li>
        <li><a href="/health">Health</a></li>
        <li><a href="/metrics">Metrics</a></li>
      </ul>

      <h2 style="font-size:1.4rem;margin-top:32px;margin-bottom:12px">Open source</h2>
      <p>moq-edge ships under MIT. Canonical source at
        <a href="https://github.com/wave-av/wave-moq-edge" rel="noopener">github.com/wave-av/wave-moq-edge</a>.
        Spec compliance reports + interop testing welcome.</p>
    `,
    ogImage: 'https://wave.online/og/moq-edge.png',
  });

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=30, s-maxage=30',
      'x-wave-surface': 'moq-edge-public',
    },
  });
}

async function handleMetrics(env: Env): Promise<Response> {
  // Lightweight Prometheus exposition. The full MetricsCollector accumulates
  // per-session metrics via recordMetrics(); for /metrics endpoint we surface
  // a snapshot of the current edge state. Detailed metrics flow into Workers
  // Analytics Engine via the DO's metrics emitter.
  const list = await env.MOQ_TRACK_REGISTRY.list({ prefix: 'track:', limit: 1000 });
  const trackCount = list.keys.length;
  const lines = [
    '# HELP moq_edge_active_tracks Number of currently announced MoQ tracks',
    '# TYPE moq_edge_active_tracks gauge',
    `moq_edge_active_tracks{environment="${env.ENVIRONMENT}"} ${trackCount}`,
    '# HELP moq_edge_build_info Build metadata',
    '# TYPE moq_edge_build_info gauge',
    `moq_edge_build_info{environment="${env.ENVIRONMENT}",moq_draft="${env.MOQ_DRAFT_VERSION}"} 1`,
  ];
  return new Response(lines.join('\n') + '\n', {
    headers: { 'content-type': 'text/plain; version=0.0.4' },
  });
}
// MetricsCollector remains used by the DO for per-session metrics; this is just the edge snapshot.
const _keepImport: unknown = MetricsCollector;
void _keepImport;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Branded HTML landing (browser navigations to GET /)
      if (path === '/' && request.method === 'GET') {
        return handleHtmlRoot(env, request);
      }

      // Branded wave-mark favicon (the shared WAVE mark, flat-filled to the MoQ accent)
      if (path === '/favicon.svg' && request.method === 'GET') {
        return new Response(MOQ_FAVICON_SVG, {
          headers: {
            'content-type': 'image/svg+xml',
            'cache-control': 'public, max-age=86400',
            'x-wave-surface': 'moq-edge-public',
          },
        });
      }

      // Machine identity (WAVE Discoverability standard): platform-controlled did:web,
      // consistent with the rest of the fleet. Sits before the MoQ/WS routes — a plain GET.
      if (path === '/.well-known/did.json' && request.method === 'GET') {
        return jsonResponse({
          '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
          id: `did:web:${host}`
          controller: 'did:web:wave.online',
          alsoKnownAs: ['https://moq.wave.online'],
          verificationMethod: [{
            id: 'did:web:moq.wave.online#gateway-key',
            type: 'JsonWebKey2020',
            controller: 'did:web:wave.online',
            publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', use: 'sig', kid: 'https://api.wave.online/.well-known/jwks.json' },
          }],
          assertionMethod: ['did:web:moq.wave.online#gateway-key'],
          service: [
            { id: 'did:web:moq.wave.online#moq', type: 'MoqRelay', serviceEndpoint: 'https://moq.wave.online' },
            { id: 'did:web:moq.wave.online#gateway', type: 'WaveGateway', serviceEndpoint: 'https://api.wave.online' },
          ],
        }, 200, { 'cache-control': 'public, max-age=3600' });
      }

      // Health + metrics
      if (path === '/health') return handleHealth(env);
      if (path === '/metrics') return handleMetrics(env);

      // /v1/announce — discovery
      if (path === '/v1/announce' && request.method === 'GET') {
        return handleAnnounce(env);
      }

      // /v1/catalog — IETF draft-ietf-moq-catalog (NEW — first public CF MoQ catalog)
      if (path === '/v1/catalog' && request.method === 'GET') {
        return handleCatalog(env, request);
      }

      // /v1/publish/:namespace/:track
      const publishMatch = path.match(/^\/v1\/publish\/([^/]+)\/([^/]+)$/);
      if (publishMatch && request.method === 'POST') {
        return handlePublish(env, publishMatch[1], publishMatch[2], request);
      }

      // /v1/subscribe/:namespace/:track (WebTransport upgrade)
      const subscribeMatch = path.match(/^\/v1\/subscribe\/([^/]+)\/([^/]+)$/);
      if (subscribeMatch && request.method === 'GET') {
        return handleSubscribe(env, subscribeMatch[1], subscribeMatch[2], request);
      }

      // /v1/track/:namespace/:track — metadata
      const trackMatch = path.match(/^\/v1\/track\/([^/]+)\/([^/]+)$/);
      if (trackMatch && request.method === 'GET') {
        return handleTrackMetadata(env, trackMatch[1], trackMatch[2]);
      }

      // Browser navigation to unknown path → branded 404 HTML; API client → JSON 404
      const accept = request.headers.get('accept') ?? '';
      if (accept.includes('text/html')) {
        return wavePublicErrorResponse(
          404,
          'Not found',
          `${request.method} ${path} is not a moq-edge endpoint. Try / for the landing page.`,
          { headers: { 'x-wave-surface': 'moq-edge-public' } }
        );
      }
      return errorResponse('Not Found', 404, `${request.method} ${path}`);
    } catch (error) {
      console.error('moq-edge fetch error', error);
      const accept = request.headers.get('accept') ?? '';
      const detail = error instanceof Error ? error.message : String(error);
      if (accept.includes('text/html')) {
        return wavePublicErrorResponse(500, 'Something went wrong', detail, {
          headers: { 'x-wave-surface': 'moq-edge-public' },
        });
      }
      return errorResponse('Internal Server Error', 500, detail);
    }
  },
};
