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
  buildTrackSet,
  resolveTrackToken,
  type MintFn,
} from '../bench-sixteen-track.ts';

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
      expect(t.namespace[0]).toBe(BENCH_NAMESPACE_PREFIX);
    }
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
      tracks.map((t) => resolveTrackToken('https://api.wave.online', 'publish', t.namespace.join('/'), t.track, mint)),
    );

    // Every track triggered its own mint call, addressed to its own track name.
    expect(calls).toHaveLength(16);
    expect(new Set(calls.map((c) => c.track)).size).toBe(16);
    // Every call was bound to the EXACT track it was minted for — the IDOR-closed contract.
    for (const [i, t] of tracks.entries()) {
      expect(calls[i]).toEqual({ role: 'publish', ns: t.namespace.join('/'), track: t.track });
    }
    // And critically: 16 distinct tokens, never one shared token reused across tracks.
    expect(new Set(tokens).size).toBe(16);
  });

  it('mints a different token per role for the SAME track (publish and subscribe are different scopes)', async () => {
    const mint: MintFn = async (opts) => `tok:${opts.role}:${opts.ns}:${opts.track}`;
    const publishToken = await resolveTrackToken('https://api.wave.online', 'publish', 'bench-vdp-e0/run-b', 'cam00-2160p', mint);
    const subscribeToken = await resolveTrackToken('https://api.wave.online', 'subscribe', 'bench-vdp-e0/run-b', 'cam00-2160p', mint);
    expect(publishToken).not.toBe(subscribeToken);
  });

  it('mints against the exact gateway/role/ns/track it was asked for, not a partial match', async () => {
    const mint: MintFn = vi.fn(async (opts) => `tok:${opts.role}:${opts.ns}:${opts.track}`);
    await resolveTrackToken('https://api.wave.online', 'subscribe', 'bench-vdp-e0/run-c', 'cam07-1080p', mint);
    expect(mint).toHaveBeenCalledWith({
      gateway: 'https://api.wave.online',
      role: 'subscribe',
      ns: 'bench-vdp-e0/run-c',
      track: 'cam07-1080p',
      apiKey: 'test-wave-api-key',
    });
  });

  it('falls back to undefined (legacy single MOQ_JOIN_TOKEN path preserved) when no WAVE_API_KEY is set', async () => {
    delete process.env.WAVE_API_KEY;
    const mint: MintFn = vi.fn();
    const token = await resolveTrackToken('https://api.wave.online', 'publish', 'ns', 'track', mint);
    expect(token).toBeUndefined();
    expect(mint).not.toHaveBeenCalled();
  });
});
