/**
 * task#14 CONFIRMED under-bill fix — proves a CLIENT can never self-declare a billed protocol.
 *
 * Adversarial pre-deploy review found: in off/shadow join mode (the code-level default when
 * MOQ_JOIN_ENFORCE is unset), handlePublish/handleSubscribe forwarded the request UNCHANGED to the DO,
 * so a client dialing /v1/publish directly with x-wave-declared-protocol: <cheaper protocol> would have
 * that value billed verbatim — no signature, no allowlist. This suite proves the fix: the header is
 * stripped UNCONDITIONALLY, in every join mode, before the DO ever sees the request.
 */
import { describe, it, expect } from 'vitest';
import worker from '../index';
import type { Env } from '../src/types';

const HOST = 'https://moq.wave.online';
const DECLARE_HEADER = 'x-wave-declared-protocol';

function makeKvStub(): KVNamespace {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

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

/** A DO stub that RECORDS every request handed to it (so we can inspect what the DO actually saw). */
function makeRecordingDoStub(): { ns: DurableObjectNamespace; seenHeaders: Headers[] } {
  const seenHeaders: Headers[] = [];
  const stubObject = {
    fetch: async (req: Request) => {
      seenHeaders.push(req.headers);
      return new Response(JSON.stringify({ ok: true, publish_session: 'sess-1', websocket_url: 'wss://x' }), { status: 200 });
    },
  } as unknown as DurableObjectStub;
  const ns = {
    idFromName: () => ({} as DurableObjectId),
    idFromString: () => ({} as DurableObjectId),
    newUniqueId: () => ({} as DurableObjectId),
    get: () => stubObject,
    jurisdiction: () => { throw new Error('not stubbed'); },
  } as unknown as DurableObjectNamespace;
  return { ns, seenHeaders };
}

function buildEnv(doNs: DurableObjectNamespace, overrides: Partial<Env> = {}): Env {
  return {
    MOQ_SESSIONS: doNs,
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

describe('task#14 — declared-protocol spoof is stripped in OFF mode (the default)', () => {
  it('POST /v1/publish with a spoofed x-wave-declared-protocol never reaches the DO', async () => {
    const { ns, seenHeaders } = makeRecordingDoStub();
    const env = buildEnv(ns); // MOQ_JOIN_ENFORCE unset → off mode
    const req = new Request(`${HOST}/v1/publish/wave-crest/live`, {
      method: 'POST',
      headers: { [DECLARE_HEADER]: 'dante' }, // attacker-supplied, trying to under-bill
    });
    const r = await worker.fetch(req, env, {} as ExecutionContext);
    expect(r.status).toBe(200);
    expect(seenHeaders.length).toBe(1);
    expect(seenHeaders[0].get(DECLARE_HEADER)).toBeNull(); // stripped → usage-emit defaults to 'moq'
  });

  it('POST /v1/subscribe (register) with a spoofed header also gets it stripped', async () => {
    const { ns, seenHeaders } = makeRecordingDoStub();
    const env = buildEnv(ns);
    // Prime the registry so the legacy subscribe path's 404-guard passes.
    (env.MOQ_TRACK_REGISTRY as unknown as { get: () => Promise<string | null> }).get = async () =>
      JSON.stringify({ namespace: 'wave-crest', track: 'live' });
    const req = new Request(`${HOST}/v1/subscribe/wave-crest/live`, {
      method: 'GET',
      headers: { [DECLARE_HEADER]: 'dante' },
    });
    const r = await worker.fetch(req, env, {} as ExecutionContext);
    expect(r.status).toBe(200);
    expect(seenHeaders.length).toBe(1);
    expect(seenHeaders[0].get(DECLARE_HEADER)).toBeNull();
  });
});

describe('task#14 — declared-protocol spoof is stripped in SHADOW mode', () => {
  it('POST /v1/publish with a spoofed header is stripped even when MOQ_JOIN_ENFORCE=shadow', async () => {
    const { ns, seenHeaders } = makeRecordingDoStub();
    const env = buildEnv(ns, { MOQ_JOIN_ENFORCE: 'shadow' } as Partial<Env>);
    const req = new Request(`${HOST}/v1/publish/wave-crest/live`, {
      method: 'POST',
      headers: { [DECLARE_HEADER]: 'dante' },
    });
    const r = await worker.fetch(req, env, {} as ExecutionContext);
    expect(r.status).toBe(200);
    expect(seenHeaders.length).toBe(1);
    expect(seenHeaders[0].get(DECLARE_HEADER)).toBeNull();
  });
});
