/**
 * Per-track failure diagnostics for the E0 16-track bench (`bench-sixteen-track.ts`).
 *
 * Split out of the bench file itself so the bench stays readable: this module owns the shape of a
 * failure (`CanaryErrorDetail`), the wrapper `runOneTrack` throws to attach stage/role context
 * (`TrackStageError`), and the pure functions that turn a batch of `Promise.allSettled` results into
 * printable/reportable diagnostics (`summarizeTrackFailure`, `collectCanaryErrors`, `logTrackFailure`).
 *
 * Before this module existed, every failed track's error was caught only by `Promise.allSettled` and
 * then discarded — the bench counted `tracksFailed`/`error_rate` but never said WHY a track failed, so
 * a live run that hit `error_rate=1.00` gave the operator no way to tell mint failure from
 * transport-connect failure from anything else. Nothing here changes control flow or thresholds; it
 * only makes the existing failure visible.
 *
 * NEVER log the join token, the WAVE_API_KEY, or any bearer value here — only `.message`/`.stack`
 * (which come from `join-mint.ts`'s and `cli.ts`'s own error messages, neither of which include the
 * token/key) and the mint HTTP status parsed back out of that message.
 */
import type { SessionReport } from './session.ts';

export interface TrackConfigLike {
  namespace: string;
  track: string;
}

export interface TrackResultLike {
  config: TrackConfigLike;
  publisher: SessionReport;
  subscriber: SessionReport;
}

/** Which stage of a track's setup/run produced the failure — the diagnostic operators actually need. */
export type TrackFailureStage = 'mint' | 'transport-connect' | 'publish' | 'subscribe' | 'session' | 'unknown';

/**
 * Thrown by `runOneTrack` (in place of the bare error a mint/transport-connect call throws) so the
 * catcher — `Promise.allSettled` in `main()` — has enough structure to print a diagnostic that says
 * WHICH leg of WHICH track failed at WHICH stage, instead of a single indistinguishable rejection.
 * Copies the original error's stack so the printed trace still points at the real failure site, not
 * this wrapper's constructor; the original is kept as `.cause` for anything that wants it.
 */
export class TrackStageError extends Error {
  readonly role: 'publisher' | 'subscriber';
  readonly stage: TrackFailureStage;
  readonly ns: string;
  readonly track: string;
  /** HTTP status parsed out of a mint-stage error's message, when the mint call was reached. */
  readonly mintStatus?: number;

  constructor(cause: unknown, role: 'publisher' | 'subscriber', stage: TrackFailureStage, ns: string, track: string) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = 'TrackStageError';
    this.role = role;
    this.stage = stage;
    this.ns = ns;
    this.track = track;
    this.cause = cause;
    if (cause instanceof Error && cause.stack) this.stack = cause.stack;
    if (stage === 'mint') {
      // join-mint.ts's thrown message shape is "METHOD url → 4xx statusText: body" — pull the status
      // back out so a re-run's stderr/JSON can show it without re-parsing the message string.
      const m = message.match(/→\s*(\d{3})\b/);
      if (m) this.mintStatus = Number(m[1]);
    }
  }
}

/** One failed track's diagnostic — what a re-run's JSON report exposes under `canaryErrors`. */
export interface CanaryErrorDetail {
  role: 'publisher' | 'subscriber' | 'track';
  ns: string;
  track: string;
  stage: TrackFailureStage;
  message: string;
  mintStatus?: number;
  stack?: string;
}

/** Turn one rejected settle reason into a printable/reportable diagnostic. Never includes a token. */
export function summarizeTrackFailure(reason: unknown): CanaryErrorDetail {
  if (reason instanceof TrackStageError) {
    return {
      role: reason.role,
      ns: reason.ns,
      track: reason.track,
      stage: reason.stage,
      message: reason.message,
      mintStatus: reason.mintStatus,
      stack: reason.stack,
    };
  }
  if (reason instanceof Error) {
    return { role: 'track', ns: '', track: '', stage: 'unknown', message: reason.message, stack: reason.stack };
  }
  return { role: 'track', ns: '', track: '', stage: 'unknown', message: String(reason) };
}

/**
 * Walk every settled track result and produce one diagnostic per failure — both the REJECTED case
 * (mint/transport-connect/etc threw, caught below as `TrackStageError`) and the FULFILLED-but-negative
 * case (the session completed but `SessionReport.outcome !== 'ok'`, e.g. `auth-rejected`), matching
 * exactly the two conditions the bench's `errorRate()` already counts as "bad" — so every track that
 * counts against `error_rate`/`tracksFailed` has a line here explaining why.
 */
export function collectCanaryErrors(settled: PromiseSettledResult<TrackResultLike>[]): CanaryErrorDetail[] {
  const errors: CanaryErrorDetail[] = [];
  for (const r of settled) {
    if (r.status === 'rejected') {
      errors.push(summarizeTrackFailure(r.reason));
      continue;
    }
    const { config, publisher, subscriber } = r.value;
    if (publisher.outcome !== 'ok') {
      errors.push({
        role: 'publisher',
        ns: config.namespace,
        track: config.track,
        stage: 'session',
        message: `${publisher.outcome}: ${publisher.evidence}`,
      });
    }
    if (subscriber.outcome !== 'ok') {
      errors.push({
        role: 'subscriber',
        ns: config.namespace,
        track: config.track,
        stage: 'session',
        message: `${subscriber.outcome}: ${subscriber.evidence}`,
      });
    }
  }
  return errors;
}

/** Print one failed-track diagnostic to stderr. Never logs a token or the API key — message/stack only. */
export function logTrackFailure(e: CanaryErrorDetail): void {
  const statusPart = e.mintStatus !== undefined ? ` mintStatus=${e.mintStatus}` : '';
  process.stderr.write(
    `[bench] track FAILED role=${e.role} ns=${e.ns || '?'} track=${e.track || '?'} stage=${e.stage}${statusPart} error=${e.message}\n`,
  );
  if (e.stack) process.stderr.write(`${e.stack}\n`);
}
