/**
 * Unit tests for #213's fix: `readCatalog()` attaches a discovery join-token and resolves a
 * catalogformat §3.2.4-hoisted `commonTrackFields.namespace` back onto each per-track entry.
 *
 * Network-free: `fetch` is stubbed so these assert the client-side parsing/carrier logic in
 * isolation from the relay (the relay-side fail-closed/join-scoped behavior is covered by
 * `__tests__/discovery-join-endpoints.test.ts` at the repo root).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCatalog } from '../src/catalog-read.ts';

function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const { status, body } = handler(url);
      return {
        status,
        json: async () => body,
      } as Response;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readCatalog — carrier', () => {
  it('does NOT attach a ?join= param when no token is supplied (unauthenticated, pre-#213-fix-identical)', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { tracks: [] } }));
    await readCatalog('https://moq.wave.online');
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).searchParams.has('join')).toBe(false);
  });

  it('attaches the join-token as ?join= when supplied — the #112 discovery credential carrier', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { tracks: [] } }));
    await readCatalog('https://moq.wave.online', 'tok.payload.sig');
    expect(new URL(calls[0]).searchParams.get('join')).toBe('tok.payload.sig');
  });
});

describe('readCatalog — #213 regression: fail-closed empty catalog surfaces as empty, not a crash', () => {
  it('an unauthenticated read against an auth-enforcing relay returns status 200 with an empty tracks array (matches #213 observed shape)', async () => {
    stubFetch(() => ({ status: 200, body: { version: 1, tracks: [] } }));
    const result = await readCatalog('https://moq.wave.online');
    expect(result.status).toBe(200);
    expect(result.tracks).toEqual([]);
  });
});

describe('readCatalog — #213 regression: commonTrackFields.namespace hoisting fallback', () => {
  it('resolves per-track namespace from commonTrackFields when the catalog hoisted a uniform namespace (catalogformat §3.2.4)', async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        version: 1,
        commonTrackFields: { packaging: 'loc', namespace: 'bench-vdp-e0-171234' },
        tracks: [
          { name: 'cam00-2160p', packaging: 'loc' },
          { name: 'cam01-1080p', packaging: 'loc' },
        ],
      },
    }));
    const result = await readCatalog('https://moq.wave.online');
    expect(result.tracks).toEqual([
      { namespace: 'bench-vdp-e0-171234', track: 'cam00-2160p' },
      { namespace: 'bench-vdp-e0-171234', track: 'cam01-1080p' },
    ]);
    // The specific regression: every track resolves to a namespace that STARTS WITH the bench
    // prefix, which is exactly the `benchTracksLive` filter in bench-sixteen-track.ts — before the
    // fix this fell back to `''`, which never matches the prefix, undercounting live tracks even
    // when the catalog response itself was healthy and fully populated.
    for (const t of result.tracks) {
      expect(t.namespace.startsWith('bench-vdp-e0')).toBe(true);
    }
  });

  it('a per-track namespace, when present, wins over the hoisted commonTrackFields value', async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        commonTrackFields: { packaging: 'loc', namespace: 'common-ns' },
        tracks: [{ name: 'trackA', packaging: 'loc', namespace: 'per-track-ns' }],
      },
    }));
    const result = await readCatalog('https://moq.wave.online');
    expect(result.tracks).toEqual([{ namespace: 'per-track-ns', track: 'trackA' }]);
  });

  it('falls back to empty string when neither a per-track namespace nor commonTrackFields.namespace is present', async () => {
    stubFetch(() => ({ status: 200, body: { tracks: [{ name: 'trackA' }] } }));
    const result = await readCatalog('https://moq.wave.online');
    expect(result.tracks).toEqual([{ namespace: '', track: 'trackA' }]);
  });

  it('a malformed (non-JSON) response degrades to an empty track list, never a thrown exception', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 502,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      })) as unknown as typeof fetch,
    );
    const result = await readCatalog('https://moq.wave.online');
    expect(result.status).toBe(502);
    expect(result.tracks).toEqual([]);
  });
});
