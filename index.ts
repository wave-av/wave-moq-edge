/// <reference types="@cloudflare/workers-types" />
/**
 * WAVE MoQ Edge Relay — Worker entrypoint.
 *
 * Two halves, loop-free:
 *   /v1/* → MoQ API (metered relay routes) — handled BEFORE the chassis.
 *   else  → chassis branded public landing (consistent WAVE face).
 *
 * Routing:
 *   POST   /v1/publish/:namespace/:track   → Become publisher (returns WebTransport URL)
 *   GET    /v1/subscribe/:namespace/:track → WebTransport subscribe endpoint
 *   GET    /v1/track/:namespace/:track     → Track metadata (subscriber count, last activity)
 *   GET    /v1/announce                   → List announced tracks (for discovery)
 *   GET    /v1/catalog                    → MSF Catalog Format (draft-ietf-moq-catalogformat-01)
 *   GET    /health                        → Liveness probe
 *   GET    /metrics                       → Prometheus-format metrics
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

import { makeFetch, type Env as ChassisEnv } from '@wave-av/spoke-chassis';
import { z } from 'zod';
import { MOQSessionDurableObject } from './moq-session-do';
import { MetricsCollector } from './metrics-collector';
import { scopeGate, MOQ_SCOPE_WRITE, MOQ_SCOPE_READ } from './src/wave-auth';
import { buildMsfCatalog, type TrackRegistryEntry } from './src/catalog';
import { landingPage } from './src/landing';
import { FAVICON_SVG } from './src/favicon';
import type { Env } from './src/types';

// Re-export DO under the binding name wrangler.toml expects
export { MOQSessionDurableObject as MoqSessionDO };

// MetricsCollector remains used by the DO for per-session metrics; this is just the edge snapshot.
const _keepImport: unknown = MetricsCollector;
void _keepImport;

// Chassis owns root / human landing, /_wave/* assets, manifest, favicon, and JSON-LD.
// /v1/* is intercepted BEFORE this (loop-free).
const chassis = makeFetch(landingPage, FAVICON_SVG, {
  meta: {
    product: 'Media over QUIC',
    host: 'moq.wave.online',
    tagline: 'Sub-second live media at the edge via IETF MoQ Transport',
    accentHex: '#00d4d5',
  },
});

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
 * /v1/catalog — MSF Catalog Format (IETF draft-ietf-moq-catalogformat-01 + draft-ietf-moq-msf-00).
 *
 * Returns the "Common Catalog Format for moq-transport" JSON document for the tracks published at
 * this relay, shaped for the MSF (MOQT Streaming Format, streamingFormat=0x001) streaming format so
 * OpenMOQ-speaking relays (Akamai/Cisco/YouTube) can discover and select tracks. The catalog SHAPE
 * (root version/streamingFormat/streamingFormatVersion + per-track name/packaging/selectionParams)
 * lives in src/catalog.ts with per-field draft-section citations.
 *
 * Cloudflare's reference relay does NOT expose a catalog endpoint, making WAVE the first
 * public-facing MoQ catalog at the relay edge.
 */
async function handleCatalog(env: Env): Promise<Response> {
  const list = await env.MOQ_TRACK_REGISTRY.list({ prefix: 'track:', limit: 1000 });
  const raw = await Promise.all(
    list.keys.map(async (k) => {
      const v = await env.MOQ_TRACK_REGISTRY.get(k.name);
      return v ? (JSON.parse(v) as TrackRegistryEntry) : null;
    })
  );
  const entries = raw.filter((e): e is TrackRegistryEntry => e !== null);

  // Spec-shaped catalogformat-01 document (no WAVE-specific fields inside the document itself).
  return jsonResponse(buildMsfCatalog(entries));
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

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // --- /v1/* — MoQ API routes (intercepted BEFORE the chassis) ---

      // /v1/announce — discovery
      if (path === '/v1/announce' && request.method === 'GET') {
        return handleAnnounce(env);
      }

      // /v1/catalog — MSF Catalog Format (draft-ietf-moq-catalogformat-01, first public CF MoQ catalog)
      if (path === '/v1/catalog' && request.method === 'GET') {
        return handleCatalog(env);
      }

      // /v1/publish/:namespace/:track
      // POST = one-shot / legacy register (and POST-with-Upgrade). GET + Upgrade = the standard
      // RFC 6455 WebSocket relay publisher: Cloudflare's edge only honours a WebSocket upgrade on a
      // GET, so the live WS relay publisher (the documented transport) must be reachable via GET —
      // otherwise the record path is unreachable from any standard WebSocket client. The DO does the
      // upgrade on the Upgrade header regardless of method; a GET without Upgrade still 404s below.
      const publishMatch = path.match(/^\/v1\/publish\/([^/]+)\/([^/]+)$/);
      if (publishMatch && (request.method === 'POST' || (request.method === 'GET' && isWebSocketUpgrade(request)))) {
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

      // Unknown /v1/* paths → JSON 404 (don't fall through to chassis for API paths)
      if (path.startsWith('/v1/')) {
        return errorResponse('Not Found', 404, `${request.method} ${path}`);
      }

      // Health + metrics (non-/v1/ operational paths served before chassis)
      if (path === '/health') return handleHealth(env);
      if (path === '/metrics') return handleMetrics(env);

      // Machine identity (WAVE Discoverability standard): did:web, consistent with fleet.
      if (path === '/.well-known/did.json' && request.method === 'GET') {
        return jsonResponse({
          '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
          id: 'did:web:moq.wave.online',
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

      // Non-/v1/ paths fall through to the chassis branded landing.
      // The chassis owns /: the human landing, /_wave/* assets, manifest, favicon, and JSON-LD.
      // Cast: our Env has CF binding types that conflict with NotifyEnv's index signature in
      // spoke-chassis ^0.10.0 — the cast is safe because chassis only reads the optional string
      // vars (GATEWAY_ORIGIN, POSTHOG_KEY, etc.) from env, never the binding fields.
      return chassis(request, env as unknown as ChassisEnv);
    } catch (error) {
      console.error('moq-edge fetch error', error);
      const detail = error instanceof Error ? error.message : String(error);
      return errorResponse('Internal Server Error', 500, detail);
    }
  },
} satisfies ExportedHandler<Env>;
