/**
 * Network-free coverage for the E0 16-track bench's failure-diagnostics path (src/track-failure.ts).
 *
 * Before this change, a failed track's mint/transport-connect error was caught only by
 * `Promise.allSettled` in `bench-sixteen-track.ts`'s `main()` and discarded — the JSON report showed
 * `tracksFailed`/`error_rate` but never WHY. These tests assert that `runOneTrack` tags a thrown
 * mint/transport error with role/stage/ns/track (never the token), and that `collectCanaryErrors`
 * turns a batch of `Promise.allSettled` results — both rejected and fulfilled-but-negative-outcome —
 * into the `canaryErrors` array the report now carries.
 */
import { describe, expect, it } from 'vitest';
import { buildTrackSet, runOneTrack, type MintFn, type OpenTransportFn } from '../bench-sixteen-track.ts';
import { TrackStageError, collectCanaryErrors, summarizeTrackFailure } from '../src/track-failure.ts';
import type { SessionReport } from '../src/session.ts';

function fakeSessionReport(overrides: Partial<SessionReport> = {}): SessionReport {
  return {
    peer: 'wss://relay.test/v1/publish/ns/track',
    transport: 'websocket',
    transportAlpn: null,
    moqDraft: 18,
    moqAlpn: 'moq-00',
    role: 'publisher',
    outcome: 'ok',
    evidence: '',
    objects: 0,
    bytes: 0,
    ordering: { outOfOrder: 0, missing: 0, monotonic: true },
    latency: { count: 0, p50Ms: null, p95Ms: null, minMs: null, maxMs: null },
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('runOneTrack — per-stage error tagging', () => {
  // NOTE (fix/e0-bench-publisher-first): `runOneTrack` now opens the PUBLISHER before the SUBSCRIBER
  // (see src/subscriber-retry.ts for the ordering fix and its rationale), so a mint/open fake that
  // throws unconditionally regardless of role is now reached by the publisher's leg FIRST — these
  // tests updated their expected `role` from 'subscriber' to 'publisher' to match.
  it('tags a mint failure with role=publisher stage=mint (publisher mints/connects first)', async () => {
    process.env.WAVE_API_KEY = 'test-wave-api-key';
    try {
      const [track] = buildTrackSet(1, 'run-mint-fail');
      const throwingMint: MintFn = async () => {
        throw new Error('mint POST https://api.wave.online/v1/moq/publish/ns/track → 402 Payment Required: no MoQ entitlement');
      };
      const neverCalledOpen: OpenTransportFn = async () => {
        throw new Error('open should not be reached when mint fails first');
      };

      await expect(runOneTrack('https://relay.test', track, 1000, 'https://api.wave.online', throwingMint, neverCalledOpen)).rejects.toMatchObject(
        {
          name: 'TrackStageError',
          role: 'publisher',
          stage: 'mint',
          track: track.track,
          mintStatus: 402,
        },
      );
    } finally {
      delete process.env.WAVE_API_KEY;
    }
  });

  it('tags a transport-connect failure with the stage and role, never leaking the token into the message', async () => {
    process.env.WAVE_API_KEY = 'test-wave-api-key';
    try {
      const [track] = buildTrackSet(1, 'run-transport-fail');
      const secretToken = 'super-secret-join-token-value';
      const mint: MintFn = async () => secretToken;
      const throwingOpen: OpenTransportFn = async () => {
        throw new Error('websocket connection failed before open (ECONNREFUSED)');
      };

      let caught: unknown;
      try {
        await runOneTrack('https://relay.test', track, 1000, 'https://api.wave.online', mint, throwingOpen);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(TrackStageError);
      const err = caught as TrackStageError;
      expect(err.role).toBe('publisher');
      expect(err.stage).toBe('transport-connect');
      expect(err.track).toBe(track.track);
      expect(err.message).not.toContain(secretToken);
    } finally {
      delete process.env.WAVE_API_KEY;
    }
  });
});

describe('collectCanaryErrors — turns settled results into the report\'s canaryErrors array', () => {
  it('captures a rejected track (TrackStageError) as one diagnostic with role/track/stage/message', async () => {
    process.env.WAVE_API_KEY = 'test-wave-api-key';
    try {
      const [track] = buildTrackSet(1, 'run-collect-a');
      const throwingMint: MintFn = async () => {
        throw new Error('mint POST https://api.wave.online/v1/moq/publish/ns/track → 500 Internal Server Error: boom');
      };
      const neverCalledOpen: OpenTransportFn = async () => {
        throw new Error('unreachable');
      };
      const settled = await Promise.allSettled([
        runOneTrack('https://relay.test', track, 1000, 'https://api.wave.online', throwingMint, neverCalledOpen),
      ]);

      const errors = collectCanaryErrors(settled);
      expect(errors).toHaveLength(1);
      // Publisher mints first now (fix/e0-bench-publisher-first) — see the note above.
      expect(errors[0].role).toBe('publisher');
      expect(errors[0].track).toBe(track.track);
      expect(errors[0].stage).toBe('mint');
      expect(errors[0].message).toContain('500');
      expect(errors[0].mintStatus).toBe(500);
    } finally {
      delete process.env.WAVE_API_KEY;
    }
  });

  it('captures a fulfilled-but-negative-outcome track (session reported auth-rejected) with stage=session', () => {
    const settled: PromiseSettledResult<{
      config: { namespace: string; track: string };
      publisher: SessionReport;
      subscriber: SessionReport;
    }>[] = [
      {
        status: 'fulfilled',
        value: {
          config: { namespace: 'bench-vdp-e0-1', track: 'cam00-2160p' },
          publisher: fakeSessionReport({ role: 'publisher', outcome: 'auth-rejected', evidence: 'REQUEST_ERROR 0x2 unauthorized' }),
          subscriber: fakeSessionReport({ role: 'subscriber', outcome: 'ok' }),
        },
      },
    ];

    const errors = collectCanaryErrors(settled);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      role: 'publisher',
      ns: 'bench-vdp-e0-1',
      track: 'cam00-2160p',
      stage: 'session',
    });
    expect(errors[0].message).toContain('auth-rejected');
  });

  it('produces zero diagnostics for an all-ok settled batch', () => {
    const settled: PromiseSettledResult<{
      config: { namespace: string; track: string };
      publisher: SessionReport;
      subscriber: SessionReport;
    }>[] = [
      {
        status: 'fulfilled',
        value: {
          config: { namespace: 'bench-vdp-e0-1', track: 'cam00-2160p' },
          publisher: fakeSessionReport({ role: 'publisher', outcome: 'ok' }),
          subscriber: fakeSessionReport({ role: 'subscriber', outcome: 'ok' }),
        },
      },
    ];
    expect(collectCanaryErrors(settled)).toHaveLength(0);
  });

  it('falls back to a plain diagnostic for a rejection that is not a TrackStageError', () => {
    const detail = summarizeTrackFailure(new Error('unexpected'));
    expect(detail).toMatchObject({ role: 'track', stage: 'unknown', message: 'unexpected' });
  });
});
