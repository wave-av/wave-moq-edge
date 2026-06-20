/**
 * Chassis landing retrofit — asserts that GET / returns the full chassis shell (not the old
 * bespoke wavePublicPage), and that existing /v1 API routes still respond correctly (no regression).
 *
 * The chassis markers verified here match the fleet-wide set used by clip-engine and media-engine:
 * id="main", rel="manifest", application/ld+json, /_wave/nav.js, theme-color.
 * All five present → shell() was called; any one missing → landing.ts bypassed shell().
 */
import { describe, it, expect } from 'vitest';
import worker from '../index';
import type { Env } from '../src/types';

const HOST = 'https://moq.wave.online';

/** Minimal stub for a KV namespace — list returns empty, get returns null. */
function makeKvStub(): KVNamespace {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

/** Minimal stub for an R2 bucket — reads always return null. */
function makeR2Stub(): R2Bucket {
  return {
    put: async () => null,
    get: async () => null,
    delete: async () => {},
    list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
    head: async () => null,
    createMultipartUpload: async () => { throw new Error('not stubbed'); },
    resumeMultipartUpload: () => { throw new Error('not stubbed'); },
  } as unknown as R2Bucket;
}

/** Minimal stub for a DO namespace — idFromName + get return a stub that 404s on fetch. */
function makeDoStub(): DurableObjectNamespace {
  const stubObject = {
    fetch: async () => new Response(null, { status: 404 }),
  } as unknown as DurableObjectStub;
  return {
    idFromName: () => ({} as DurableObjectId),
    idFromString: () => ({} as DurableObjectId),
    newUniqueId: () => ({} as DurableObjectId),
    get: () => stubObject,
    jurisdiction: () => { throw new Error('not stubbed'); },
  } as unknown as DurableObjectNamespace;
}

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    MOQ_SESSIONS: makeDoStub(),
    MOQ_TRACK_REGISTRY: makeKvStub(),
    MOQ_RECORDINGS: makeR2Stub(),
    ENVIRONMENT: 'test',
    MOQ_DRAFT_VERSION: '18',
    MAX_SUBSCRIBERS_PER_TRACK: '100',
    MAX_OBJECT_SIZE_BYTES: '16777216',
    LOG_LEVEL: 'debug',
    ...overrides,
  } as unknown as Env;
}

describe('chassis landing — GET /', () => {
  it('returns 200 HTML with all 5 required chassis markers', async () => {
    const r = await worker.fetch(new Request(`${HOST}/`), buildEnv(), {} as ExecutionContext);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toContain('text/html');
    const body = await r.text();
    // Chassis shell markers — any missing means shell() was not called
    expect(body, 'missing id="main" (chassis card container)').toContain('id="main"');
    expect(body, 'missing rel="manifest" (chassis manifest link)').toContain('rel="manifest"');
    expect(body, 'missing application/ld+json (chassis JSON-LD)').toContain('application/ld+json');
    expect(body, 'missing /_wave/nav.js (chassis progressive-enhancement nav)').toContain('/_wave/nav.js');
    expect(body, 'missing theme-color (chassis meta tag)').toContain('theme-color');
    // Product-specific copy from landing.ts
    expect(body, 'missing product name in landing copy').toContain('Media over QUIC');
    expect(body, 'missing host in landing copy').toContain('moq.wave.online');
  });

  it('does NOT contain the old wavePublicPage bespoke markup (regression guard)', async () => {
    const r = await worker.fetch(new Request(`${HOST}/`), buildEnv(), {} as ExecutionContext);
    await r.text(); // drain the body; this regression guard only asserts on the header
    // The old handleHtmlRoot injected x-wave-surface header and used wavePublicPage — chassis does not
    expect(r.headers.get('x-wave-surface')).toBeNull();
  });
});

describe('/v1 API routes — no regression (must not return chassis 200)', () => {
  it('GET /v1/announce returns JSON (not an HTML chassis page)', async () => {
    const r = await worker.fetch(new Request(`${HOST}/v1/announce`), buildEnv(), {} as ExecutionContext);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toContain('application/json');
    const body = (await r.json()) as { tracks: unknown[]; count: number };
    expect(body).toHaveProperty('tracks');
    expect(body).toHaveProperty('count');
  });

  it('GET /v1/catalog returns JSON catalog (not a chassis page)', async () => {
    const r = await worker.fetch(new Request(`${HOST}/v1/catalog`), buildEnv(), {} as ExecutionContext);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toContain('application/json');
    const body = (await r.json()) as { catalog_format: string };
    expect(body.catalog_format).toBe('draft-ietf-moq-catalog');
  });

  it('POST /v1/publish/:ns/:track with invalid namespace returns 400 JSON (not chassis 200)', async () => {
    const r = await worker.fetch(
      new Request(`${HOST}/v1/publish/INVALID_CAPS/track`, { method: 'POST' }),
      buildEnv(),
      {} as ExecutionContext,
    );
    expect(r.status).toBe(400);
    expect(r.headers.get('content-type') ?? '').toContain('application/json');
  });

  it('GET /v1/publish/:ns/:track WITH a WebSocket upgrade routes to handlePublish (the WS relay publisher)', async () => {
    // CF only honours a WS upgrade on GET, so the live relay publisher must be reachable via GET+Upgrade.
    // Invalid namespace → handlePublish validation → 400 (proves it ROUTED to handlePublish, not a 404 miss).
    const r = await worker.fetch(
      new Request(`${HOST}/v1/publish/INVALID_CAPS/track`, {
        method: 'GET',
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
      buildEnv(),
      {} as ExecutionContext,
    );
    expect(r.status).toBe(400);
    expect(r.headers.get('content-type') ?? '').toContain('application/json');
  });

  it('GET /v1/publish/:ns/:track WITHOUT an upgrade still 404s (no behavior change for non-WS GET)', async () => {
    const r = await worker.fetch(
      new Request(`${HOST}/v1/publish/wave/cam-1`, { method: 'GET' }),
      buildEnv(),
      {} as ExecutionContext,
    );
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type') ?? '').toContain('application/json');
  });

  it('GET /v1/subscribe/:ns/:track without WebSocket upgrade returns 404 (track not found, not chassis)', async () => {
    const r = await worker.fetch(
      new Request(`${HOST}/v1/subscribe/wave/cam-1`),
      buildEnv(),
      {} as ExecutionContext,
    );
    // Not a WebSocket upgrade → KV miss → 404 JSON (not chassis HTML)
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type') ?? '').toContain('application/json');
  });

  it('GET /v1/unknown-path returns 404 JSON (not chassis landing)', async () => {
    const r = await worker.fetch(new Request(`${HOST}/v1/does-not-exist`), buildEnv(), {} as ExecutionContext);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type') ?? '').toContain('application/json');
    const text = await r.text();
    // Must be JSON error, not HTML chassis
    expect(text).not.toContain('<!DOCTYPE');
  });
});

describe('health + metrics endpoints', () => {
  it('GET /health returns JSON with ok:true', async () => {
    const r = await worker.fetch(new Request(`${HOST}/health`), buildEnv(), {} as ExecutionContext);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('moq-edge');
  });

  it('GET /metrics returns Prometheus text', async () => {
    const r = await worker.fetch(new Request(`${HOST}/metrics`), buildEnv(), {} as ExecutionContext);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toContain('text/plain');
    const body = await r.text();
    expect(body).toContain('moq_edge_active_tracks');
  });
});
