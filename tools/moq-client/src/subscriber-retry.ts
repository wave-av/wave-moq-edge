/**
 * Publisher-first subscriber retry for the E0 16-track bench (`bench-sixteen-track.ts`).
 *
 * THE FIX (root cause of the 2026-08-31 live run: all 4 canary tracks failed identically —
 * role=subscriber stage=transport-connect, `relay http 404: {"title":"Track not found or no active
 * publisher"...}`, thrown in `openTransport` (cli.ts), called from `runOneTrack`): the relay correctly
 * 404s a subscribe issued before its track's publisher has connected and announced — `runOneTrack`
 * previously opened the SUBSCRIBER transport before the PUBLISHER transport for every track, so every
 * subscribe raced (and lost) against its own publisher's connect.
 *
 * `runOneTrack` now opens the PUBLISHER first. But announce propagation through the relay is not
 * instantaneous and there is no clean synchronous "announced" signal the bench can await — so rather
 * than a magic fixed sleep, `openSubscriberWithRetry` retries the subscriber's own open with a short
 * bounded backoff whenever it hits exactly this 404, connecting the moment the publisher is actually
 * live, no faster and no slower. This also self-heals if the publisher's connect is itself slow for
 * unrelated reasons (network jitter, relay cold-start), which a fixed sleep would not.
 *
 * Split out of bench-sixteen-track.ts to keep that file under the repo's file-size budget (same reason
 * track-failure.ts was split out — see that file's header).
 */
import type { Transport } from './transport.ts';

/** Matches the exact function signature of `openTransport` in cli.ts (kept decoupled — no import of
 *  cli.ts here — this module only needs the shape, not the implementation). */
export type OpenTransportFn = (
  url: string,
  kind: string,
  role: 'subscribe' | 'publish',
  token?: string,
) => Promise<Transport>;

/** Injectable so tests can drive the retry loop without a real timer. */
export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded retry policy for the subscriber's publisher-not-yet-announced window. Worst-case total wait
 * across all attempts (150+300+600+1200+2000=4250ms at the defaults) is well inside the compiled
 * `MAX_DURATION_MS` (30s) per-track ceiling from bench-sixteen-track.ts.
 */
export const SUBSCRIBER_RETRY_MAX_ATTEMPTS = 5;
export const SUBSCRIBER_RETRY_BASE_DELAY_MS = 150;
export const SUBSCRIBER_RETRY_MAX_DELAY_MS = 2_000;

export function retryDelayMs(attempt: number): number {
  return Math.min(SUBSCRIBER_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), SUBSCRIBER_RETRY_MAX_DELAY_MS);
}

/**
 * True when `e` is the relay's "no active publisher yet" 404 (`openTransport` in cli.ts throws
 * `relay http 404: ...` on any 4xx/5xx from the REST publish/subscribe handshake leg) — the ONLY
 * condition this bench retries. Any other failure (auth rejection, 5xx, network) is NOT retryable and
 * is rethrown on the first attempt, exactly as before this fix.
 */
export function isPublisherNotYetAnnounced(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /relay http 404/.test(message);
}

/**
 * Opens the subscriber's transport, retrying a bounded number of times when (and only when) the relay
 * 404s because the publisher hasn't announced its track yet. See module doc for the full rationale.
 */
export async function openSubscriberWithRetry(
  open: OpenTransportFn,
  subUrl: string,
  subToken: string | undefined,
  maxAttempts: number = SUBSCRIBER_RETRY_MAX_ATTEMPTS,
  sleep: SleepFn = defaultSleep,
): Promise<Transport> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await open(subUrl, 'websocket', 'subscribe', subToken);
    } catch (e) {
      if (!isPublisherNotYetAnnounced(e) || attempt === maxAttempts) throw e;
      await sleep(retryDelayMs(attempt));
    }
  }
  // Unreachable — the loop above always either returns or throws on the last attempt — but keeps
  // TypeScript's control-flow analysis happy without an unsafe non-null assertion.
  throw new Error('openSubscriberWithRetry: exhausted attempts without a terminal return/throw');
}
