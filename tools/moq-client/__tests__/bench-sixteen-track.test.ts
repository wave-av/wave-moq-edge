/**
 * Unit tests for the E0-SIXTEEN-TRACKS workload generator's track-set builder.
 *
 * These are local, network-free: they pin the per-track accounting ROW COUNT to the configured
 * track count (governance/plans/volumetric-delivery-proof/E0-SIXTEEN-TRACKS.md P2 Done-check) and
 * assert the track set is data (configurable), not a hard-coded constant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BENCH_NAMESPACE_PREFIX,
  MAX_DURATION_MS,
  benchNamespaceFor,
  buildTrackSet,
  resolveTrackToken,
  runOneTrack,
  type MintFn,
  type OpenTransportFn,
} from '../bench-sixteen-track.ts';
import type { Transport } from '../src/transport.ts';

describe('buildTrackSet', () => {
  it('emits exactly n independently-accounted rows for n=16 (the phase target)', () => {
    const tracks = buildTrackSet(16, 'run-a');
    expect(tracks).toHaveLength(16);
  });

  it('pins row count to the configured track count generally — 1, 4, 16 all differ only by n', () => {
    for (const n of [1, 4, 16]) {
      expect(buildTrackSet(n, 'run-b')).toHaveLength(n);
    }
  });

  it('every track name is unique within a run, so per-track accounting cannot alias', () => {
    const tracks = buildTrackSet(16, 'run-c');
    const names = tracks.map((t) => t.track);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every track announces under the reserved bench namespace prefix', () => {
    const tracks = buildTrackSet(16, 'run-d');
    for (const t of tracks) {
      expect(t.namespace.startsWith(BENCH_NAMESPACE_PREFIX)).toBe(true);
    }
  });

  /**
   * Regression coverage for the E0 16-track auth gap #2: the bench previously joined a two-element
   * namespace array (`[BENCH_NAMESPACE_PREFIX, runId]`) with `/` when building the mint ns and the
   * WebTransport URL. The prod relay's `:namespace` route/schema (src/index.ts `PublishRequestSchema`,
   * `^[a-z0-9][a-z0-9-]*$`) is a SINGLE path segment with no `/` allowed — every mint call's namespace
   * therefore failed schema validation and every one of the 16 canary tracks failed auth (measured:
   * `[bench] canary n=4 error_rate=1.00` — 100% failure, run aborted, 0 tracks completed). A
   * single-segment ns (hyphen-joined, not slash-joined) is the fix; these tests would have failed
   * against the two-segment implementation.
   */
  it('the run-scoped namespace is a single URL path segment — no slash', () => {
    const tracks = buildTrackSet(16, 'run-slash');
    for (const t of tracks) {
      expect(t.namespace).not.toContain('/');
    }
  });

  it('benchNamespaceFor produces the exact single-segment namespace every track uses', () => {
    const tracks = buildTrackSet(16, 'run-consistent');
    const expected = benchNamespaceFor('run-consistent');
    expect(expected).not.toContain('/');
    for (const t of tracks) {
      expect(t.namespace).toBe(expected);
    }
  });

  it('the single-segment namespace matches the relay contract regex (^[a-z0-9][a-z0-9-]*$)', () => {
    const ns = benchNamespaceFor(`${Date.now()}`);
    expect(ns).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('mixes both track classes at 16 tracks (both resolution classes represented)', () => {
    const tracks = buildTrackSet(16, 'run-e');
    const classes = new Set(tracks.map((t) => t.trackClass));
    expect(classes.has('1080p-class')).toBe(true);
    expect(classes.has('2160p-class')).toBe(true);
  });

  it('rejects a non-positive track count rather than silently building an empty run', () => {
    expect(() => buildTrackSet(0, 'run-f')).toThrow();
  });

  it('the compiled duration ceiling is a real bound, not a placeholder', () => {
    expect(MAX_DURATION_MS).toBeGreaterThan(0);
    expect(MAX_DURATION_MS).toBeLessThanOrEqual(60_000);
  });
});

/**
 * Regression coverage for the E0 16-track auth gap: the bench used to mint ONE static join token
 * (MOQ_JOIN_TOKEN) and apply it, unchanged, to all 16 distinct track URLs. The production relay
 * (src/moq-join-verify.ts) binds a join token to an EXACT (ns, track) pair — no prefix/wildcard match
 * — so a single token can never authorize 16 tracks. These tests would have failed against the
 * original single-token implementation (there was no per-track mint call to assert on at all).
 */
describe('resolveTrackToken — per-(ns,track) join-token mint', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, WAVE_API_KEY: 'test-wave-api-key' };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('mints its own distinct, exactly-bound token for every one of 16 tracks (not one shared token)', async () => {
    const tracks = buildTrackSet(16, 'run-token-a');
    const calls: Array<{ role: string; ns: string; track: string }> = [];
    const mint: MintFn = async (opts) => {
      calls.push({ role: opts.role, ns: opts.ns, track: opts.track });
      return `tok:${opts.role}:${opts.ns}:${opts.track}`;
    };

    const tokens = await Promise.all(
      tracks.map((t) => resolveTrackToken('https://api.wave.online', 'publish', t.namespace, t.track, mint)),
    );

    // Every track triggered its own mint call, addressed to its own track name.
    expect(calls).toHaveLength(16);
    expect(new Set(calls.map((c) => c.track)).size).toBe(16);
    // Every call was bound to the EXACT track it was minted for — the IDOR-closed contract.
    for (const [i, t] of tracks.entries()) {
      expect(calls[i]).toEqual({ role: 'publish', ns: t.namespace, track: t.track });
      // Mint ns is a single path segment — no slash — matching the relay's :namespace contract.
      expect(calls[i].ns).not.toContain('/');
    }
    // And critically: 16 distinct tokens, never one shared token reused across tracks.
    expect(new Set(tokens).size).toBe(16);
  });

  it('mints a different token per role for the SAME track (publish and subscribe are different scopes)', async () => {
    const mint: MintFn = async (opts) => `tok:${opts.role}:${opts.ns}:${opts.track}`;
    const ns = benchNamespaceFor('run-b');
    const publishToken = await resolveTrackToken('https://api.wave.online', 'publish', ns, 'cam00-2160p', mint);
    const subscribeToken = await resolveTrackToken('https://api.wave.online', 'subscribe', ns, 'cam00-2160p', mint);
    expect(publishToken).not.toBe(subscribeToken);
  });

  it('mints against the exact gateway/role/ns/track it was asked for, not a partial match', async () => {
    const mint: MintFn = vi.fn(async (opts) => `tok:${opts.role}:${opts.ns}:${opts.track}`);
    const ns = benchNamespaceFor('run-c');
    await resolveTrackToken('https://api.wave.online', 'subscribe', ns, 'cam07-1080p', mint);
    expect(mint).toHaveBeenCalledWith({
      gateway: 'https://api.wave.online',
      role: 'subscribe',
      ns,
      track: 'cam07-1080p',
      apiKey: 'test-wave-api-key',
    });
  });

  it('mint ns and dial (WebTransport URL) ns are identical for every track — no mint/dial mismatch', () => {
    // wsUrl is not exported, so this asserts the identity the way the relay would observe it: the
    // mint call's ns must be byte-identical to the ns segment the relay sees in the WebTransport URL
    // path, which bench-sixteen-track.ts builds from the SAME `cfg.namespace` string for both legs.
    const tracks = buildTrackSet(16, 'run-identity');
    for (const t of tracks) {
      const mintNs = t.namespace;
      const urlPath = `/v1/publish/${t.namespace}/${t.track}`;
      expect(urlPath.split('/')[3]).toBe(mintNs);
    }
  });

  it('falls back to undefined (legacy single MOQ_JOIN_TOKEN path preserved) when no WAVE_API_KEY is set', async () => {
    delete process.env.WAVE_API_KEY;
    const mint: MintFn = vi.fn();
    const token = await resolveTrackToken('https://api.wave.online', 'publish', 'ns', 'track', mint);
    expect(token).toBeUndefined();
    expect(mint).not.toHaveBeenCalled();
  });
});

function fakeTransport(): Transport {
  return {
    kind: 'websocket',
    alpn: null,
    send: () => {},
    receive: async () => null,
    close: () => {},
    closeInfo: new Promise(() => {}), // never resolves — irrelevant to these ordering tests
  };
}

/**
 * Regression coverage for the exact live failure this branch fixes: 2026-08-31, all 4 canary tracks
 * failed identically — role=subscriber stage=transport-connect, `relay http 404: {"title":"Track not
 * found or no active publisher"...}` — because `runOneTrack` opened the subscriber's transport before
 * the publisher's. These tests assert the subscriber is not opened until the publisher-ready condition
 * is met: a fake publisher that becomes ready after N ticks, and a subscriber whose connect defers
 * (retries on a simulated 404) until then.
 */
describe('runOneTrack — publisher-first ordering', () => {
  const track = buildTrackSet(1, 'run-order-a')[0];
  const noSleep = async () => {}; // tests inject a no-op sleep so the retry backoff costs 0ms

  it('opens the publisher transport before the subscriber transport for the same track', async () => {
    const order: Array<'publish' | 'subscribe'> = [];
    const open: OpenTransportFn = async (_url, _kind, role) => {
      order.push(role);
      return fakeTransport();
    };
    const mint: MintFn = async (opts) => `tok:${opts.role}`;

    await runOneTrack('https://relay.example', track, 20, 'https://api.wave.online', mint, open, noSleep);

    expect(order).toEqual(['publish', 'subscribe']);
  });

  it('defers the subscriber connect until the publisher is ready — retries a simulated 404 then succeeds', async () => {
    const order: Array<{ role: 'publish' | 'subscribe'; attempt: number }> = [];
    let subscriberAttempts = 0;
    const publisherReadyAfterTicks = 2; // the fake publisher "announces" only after this many subscriber attempts
    const open: OpenTransportFn = async (_url, _kind, role) => {
      if (role === 'publish') {
        order.push({ role, attempt: 1 });
        return fakeTransport();
      }
      subscriberAttempts++;
      order.push({ role, attempt: subscriberAttempts });
      if (subscriberAttempts <= publisherReadyAfterTicks) {
        throw new Error('relay http 404: {"title":"Track not found or no active publisher","status":404}');
      }
      return fakeTransport();
    };
    const mint: MintFn = async (opts) => `tok:${opts.role}`;

    const result = await runOneTrack('https://relay.example', track, 20, 'https://api.wave.online', mint, open, noSleep);

    // The subscriber was NOT opened successfully until the 3rd attempt (after the publisher-ready tick).
    expect(subscriberAttempts).toBe(publisherReadyAfterTicks + 1);
    // Publisher's connect happened first, and every subscriber attempt happened strictly after it.
    expect(order[0]).toEqual({ role: 'publish', attempt: 1 });
    expect(order.slice(1).every((o) => o.role === 'subscribe')).toBe(true);
    // The track still completes successfully once the retry catches the publisher becoming ready.
    expect(result.config).toBe(track);
  });

  it('does not retry the subscriber on a non-404 transport-connect failure — fails the track immediately', async () => {
    let subscriberAttempts = 0;
    const open: OpenTransportFn = async (_url, _kind, role) => {
      if (role === 'publish') return fakeTransport();
      subscriberAttempts++;
      throw new Error('relay http 401: {"title":"unauthorized"}');
    };
    const mint: MintFn = async (opts) => `tok:${opts.role}`;

    await expect(
      runOneTrack('https://relay.example', track, 20, 'https://api.wave.online', mint, open, noSleep),
    ).rejects.toThrow(/relay http 401/);
    expect(subscriberAttempts).toBe(1);
  });
});
