/**
 * Unit tests for the E0-SIXTEEN-TRACKS workload generator's track-set builder.
 *
 * These are local, network-free: they pin the per-track accounting ROW COUNT to the configured
 * track count (governance/plans/volumetric-delivery-proof/E0-SIXTEEN-TRACKS.md P2 Done-check) and
 * assert the track set is data (configurable), not a hard-coded constant.
 */
import { describe, expect, it } from 'vitest';
import {
  BENCH_NAMESPACE_PREFIX,
  MAX_DURATION_MS,
  buildTrackSet,
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
