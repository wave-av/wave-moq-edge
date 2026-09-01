/**
 * discovery-join-endpoints.test.ts — #112 END-TO-END through the Worker fetch: GET /v1/announce and
 * GET /v1/catalog actually honour a join-token, and every negative case returns an EMPTY listing.
 * Complements discovery-join-auth.test.ts (which unit-tests the gate) by proving the WIRING.
 */
import { describe, it, expect } from 'vitest';
import worker from '../index';
import { signJoinToken } from '../src/moq-join-token';
import type { Env } from '../src/types';

const HOST = 'https://moq.wave.online';
const SECRET = 'e2e-moq-join-secret-#112'; // enforce-ignore — test-only HMAC key, not a real credential

const REGISTRY: Record<string, { namespace: string; track: string }> = {
  'track:acme-live/lens-wide': { namespace: 'acme-live', track: 'lens-wide' },
  'track:acme-live/lens-tight': { namespace: 'acme-live', track: 'lens-tight' },
  'track:acme-live/lens-aerial': { namespace: 'acme-live', track: 'lens-aerial' },
  'track:acme-archive/lens-wide': { namespace: 'acme-archive', track: 'lens-wide' },
  'track:globex-live/lens-wide': { namespace: 'globex-live', track: 'lens-wide' },
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  const kv = {
    get: async (k: string) => (REGISTRY[k] ? JSON.stringify(REGISTRY[k]) : null),
    put: async () => {},
    delete: async () => {},
    list: async () => ({
      keys: Object.keys(REGISTRY).map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
  return {
    MOQ_SESSIONS: {} as DurableObjectNamespace,
    MOQ_TRACK_REGISTRY: kv,
    MOQ_RECORDINGS: {} as R2Bucket,
    ENVIRONMENT: 'test',
    MOQ_DRAFT_VERSION: '20',
    MAX_SUBSCRIBERS_PER_TRACK: '100',
    MAX_OBJECT_SIZE_BYTES: '16777216',
    LOG_LEVEL: 'debug',
    ...overrides,
  } as unknown as Env;
}

const ENV_ON = makeEnv({ MOQ_DISCOVERY_JOIN: 'true', WAVE_MOQ_JOIN_SECRET: SECRET });
const ENV_OFF = makeEnv({ WAVE_MOQ_JOIN_SECRET: SECRET });

async function mint(over: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJoinToken(SECRET, {
    ns: 'acme-live',
    track: 'lens-wide',
    org: 'acme',
    scope: 'moq:read',
    iat: now,
    exp: now + 60,
    jti: 'jti-e2e',
    ...over,
  } as Parameters<typeof signJoinToken>[1]);
}

async function announce(env: Env, token?: string) {
  const url = token ? `${HOST}/v1/announce?join=${encodeURIComponent(token)}` : `${HOST}/v1/announce`;
  const r = await worker.fetch(new Request(url), env, {} as ExecutionContext);
  return (await r.json()) as { tracks: { namespace: string; track: string }[]; count: number };
}

async function catalog(env: Env, token?: string) {
  const url = token ? `${HOST}/v1/catalog?join=${encodeURIComponent(token)}` : `${HOST}/v1/catalog`;
  const r = await worker.fetch(new Request(url), env, {} as ExecutionContext);
  return (await r.json()) as { tracks: { name: string }[] };
}

describe('/v1/announce — join-token authed', () => {
  it('no token → exactly as today (all registry entries, MOQ_REQUIRE_AUTH off)', async () => {
    expect((await announce(ENV_ON)).count).toBe(5);
    expect((await announce(ENV_OFF)).count).toBe(5);
  });

  it('FLAG OFF + valid token → unchanged (default-inert)', async () => {
    expect((await announce(ENV_OFF, await mint())).count).toBe(5);
  });

  it('valid token → the three live lens tracks of ITS namespace, and only those', async () => {
    const body = await announce(ENV_ON, await mint());
    expect(body.count).toBe(3);
    expect(body.tracks.map((t) => t.track).sort()).toEqual(['lens-aerial', 'lens-tight', 'lens-wide']);
    expect(body.tracks.every((t) => t.namespace === 'acme-live')).toBe(true);
  });

  it('expired / malformed / wrong-secret tokens list NOTHING', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await announce(ENV_ON, await mint({ iat: now - 300, exp: now - 240 }))).count).toBe(0);
    expect((await announce(ENV_ON, 'garbage.token.here')).count).toBe(0);
    expect((await announce(makeEnv({ MOQ_DISCOVERY_JOIN: 'true', WAVE_MOQ_JOIN_SECRET: 'other' }), await mint())).count).toBe(0);
  });

  it('wrong-org token lists only its OWN namespace', async () => {
    const body = await announce(ENV_ON, await mint({ ns: 'globex-live', org: 'globex' }));
    expect(body.tracks).toEqual([{ namespace: 'globex-live', track: 'lens-wide' }]);
  });

  it('no token value ever appears in the response body', async () => {
    const t = await mint({ ns: 'nope-live' });
    const r = await worker.fetch(new Request(`${HOST}/v1/announce?join=${encodeURIComponent(t)}`), ENV_ON, {} as ExecutionContext);
    expect((await r.text()).includes(t)).toBe(false);
  });
});

describe('/v1/catalog — join-token authed', () => {
  it('valid token → an MSF catalog of only that namespace’s tracks', async () => {
    const doc = await catalog(ENV_ON, await mint());
    expect(doc.tracks.map((t) => t.name).sort()).toEqual(['lens-aerial', 'lens-tight', 'lens-wide']);
  });

  it('invalid token → an empty catalog, never the full one', async () => {
    expect((await catalog(ENV_ON, 'a.b.c')).tracks).toEqual([]);
  });

  it('no token → exactly as today', async () => {
    expect((await catalog(ENV_ON)).tracks).toHaveLength(5);
  });
});
