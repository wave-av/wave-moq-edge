#!/usr/bin/env node --experimental-transform-types
/**
 * sixteen-track bench — the E0-SIXTEEN-TRACKS workload generator.
 *
 * Drives N concurrent publisher+subscriber MoQ sessions against a relay (production or otherwise),
 * each track independently accounted (its own ordering/latency report), and prints an aggregate
 * percentile distribution plus a drop/reorder count over the whole run.
 *
 * Safety, by construction (governance/plans/volumetric-delivery-proof/E0-SIXTEEN-TRACKS.md P3
 * hard-gate):
 *   - MAX_DURATION_MS is a compiled ceiling, not a parameter — `--duration` is clamped to it.
 *   - Every track publishes under a namespace PREFIXED with the reserved bench label
 *     (BENCH_NAMESPACE_PREFIX), so a subscriber can never mistake a bench track for a customer one.
 *   - Payload sizes and cadence are bench-scale (kilobytes/10Hz-class), not real video bitrate —
 *     this measures track-count/latency/ordering behaviour, not encode throughput.
 *   - A canary wave (first CANARY_TRACKS tracks) must clear ERROR_RATE_ABORT_THRESHOLD before the
 *     remaining tracks are launched — a threshold fixed here, before any run, not chosen after
 *     seeing the data.
 */
import { runPublish, runSubscribe, percentiles, type SessionReport } from './src/session.ts';
import { openTransport } from './cli.ts';
import { mintJoinToken, type MintJoinTokenOpts } from './src/join-mint.ts';
import type { Transport } from './src/transport.ts';
import {
  TrackStageError,
  collectCanaryErrors,
  logTrackFailure,
  type CanaryErrorDetail,
} from './src/track-failure.ts';
import { openSubscriberWithRetry, type SleepFn } from './src/subscriber-retry.ts';

/** Compiled hard ceiling on run duration. Not overridable by any flag past this. */
export const MAX_DURATION_MS = 30_000;

/** Reserved namespace prefix so a subscriber can never mistake a bench track for a customer one. */
export const BENCH_NAMESPACE_PREFIX = 'bench-vdp-e0';

/** First wave launched before committing to the full track count. */
export const CANARY_TRACKS = 4;

/** Fixed before any run: abort further launch if more than this fraction of the canary fails. */
export const ERROR_RATE_ABORT_THRESHOLD = 0.25;

export type TrackClass = '1080p-class' | '2160p-class';

/**
 * The relay's `:namespace` path/schema contract (src/index.ts `PublishRequestSchema`,
 * `^[a-z0-9][a-z0-9-]*$`) is a SINGLE lowercase-alphanumeric-dash segment — no `/`. This bench must
 * conform to that prod contract, not the other way around. Run identity is folded into the prefix
 * with a HYPHEN, never a path separator, so the mint call's `:namespace` segment and the WebTransport
 * URL's `:namespace` segment are always the same single token.
 */
export function benchNamespaceFor(runId: string): string {
  return `${BENCH_NAMESPACE_PREFIX}-${runId}`;
}

export interface TrackConfig {
  /** Single-segment, run-scoped namespace — see `benchNamespaceFor`. Identical string used for the
   *  mint call, the WebTransport URL, and the MoQT wire-protocol namespace tuple (wrapped as [ns]). */
  namespace: string;
  track: string;
  trackClass: TrackClass;
  intervalMs: number;
  payloadBytes: number;
  /** Objects per Group (GoP). 0 = one group for the whole stream (legacy). See PublishOpts.groupSize. */
  groupSize: number;
}

/**
 * The track set is DATA, not a hard-coded constant: any `n` produces `n` independently-named,
 * independently-accounted tracks. A fixed fraction (roughly a quarter, rounded up) is the
 * higher-cadence/larger-payload "2160p-class"; the rest are "1080p-class" — proportions chosen so
 * a 16-track run has both classes represented without either being a single outlier.
 */
export function buildTrackSet(n: number, runId: string, intervalMs = 100, groupSize = 0): TrackConfig[] {
  if (n < 1) throw new Error(`track count must be >= 1, got ${n}`);
  if (intervalMs < 1) throw new Error(`intervalMs must be >= 1, got ${intervalMs}`);
  const namespace = benchNamespaceFor(runId);
  const highResCount = Math.max(1, Math.round(n / 4));
  const tracks: TrackConfig[] = [];
  for (let i = 0; i < n; i++) {
    const isHigh = i < highResCount;
    tracks.push({
      namespace,
      track: `cam${String(i).padStart(2, '0')}-${isHigh ? '2160p' : '1080p'}`,
      trackClass: isHigh ? '2160p-class' : '1080p-class',
      // Publish cadence. Default 100ms (10 obj/s). `--interval` overrides it so a run can probe whether
      // the relay's delivery pacing is a fixed throughput ceiling (slower publish → subscriber keeps up,
      // latency flat) or rate-coupled (still ramps) — the discriminator for the ~126ms/object artifact.
      intervalMs,
      payloadBytes: isHigh ? 8_000 : 2_000,
      groupSize,
    });
  }
  return tracks;
}

export interface TrackResult {
  config: TrackConfig;
  publisher: SessionReport;
  subscriber: SessionReport;
}

function wsUrl(relayBase: string, role: 'publish' | 'subscribe', ns: string, track: string): string {
  const u = new URL(relayBase);
  u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol;
  u.pathname = `/v1/${role}/${ns}/${track}`;
  return u.toString();
}

/** Injectable so tests can assert on mint calls without a real network round trip. */
export type MintFn = (opts: MintJoinTokenOpts) => Promise<string>;

/** Injectable so tests can force a transport-connect failure without a real network round trip. */
export type OpenTransportFn = typeof openTransport;

/**
 * Resolve the join token for ONE leg (publish or subscribe) of ONE track.
 *
 * THE FIX (this bench previously minted a single static MOQ_JOIN_TOKEN and applied it, unchanged, to
 * all 16 distinct track URLs): the production relay (src/moq-join-verify.ts) binds every join token
 * to an EXACT (ns, track) pair at mint time — no prefix/wildcard match, IDOR closed (#58) — so one
 * token can never authorize more than one track. This is therefore called once per role per track,
 * never once for the whole run; see `runOneTrack` below.
 *
 * TTL / re-mint: the gateway caps a minted token at MOQJ_MAX_TTL_SEC=120s (src/moq-join-token.ts).
 * This bench's own hard ceiling is MAX_DURATION_MS=30s, so minting once per track at session open is
 * always well inside the token's TTL and no re-mint-on-expiry path is implemented. A future variant
 * of this bench that runs a single track past ~120s WOULD need to re-mint mid-session — out of scope
 * here.
 *
 * Falls back to `undefined` (openTransport()/withToken() then applies the legacy single global
 * MOQ_JOIN_TOKEN env var, if set, unchanged) when no WAVE_API_KEY is configured — e.g. against a
 * relay with join enforcement off, or when the operator supplies one pre-minted token out of band.
 */
export async function resolveTrackToken(
  gateway: string,
  role: 'publish' | 'subscribe',
  ns: string,
  track: string,
  mint: MintFn = mintJoinToken,
  apiKey: string | undefined = process.env.WAVE_API_KEY,
): Promise<string | undefined> {
  if (!apiKey) return undefined;
  return mint({ gateway, role, ns, track, apiKey });
}

/**
 * Runs one track's publish+subscribe pair. Every awaited setup step (mint, transport-connect) is
 * individually wrapped so a failure is rethrown as a `TrackStageError` carrying WHICH leg (publisher
 * or subscriber), WHICH stage (mint vs transport-connect), and the (ns, track) it failed for — instead
 * of a bare, indistinguishable rejection that `Promise.allSettled` in `main()` can only count, not
 * explain. `mint`/`open` are injectable so tests can force a failure at a specific stage without a
 * real network round trip.
 */
export async function runOneTrack(
  relayBase: string,
  cfg: TrackConfig,
  durationMs: number,
  gateway = process.env.WAVE_GATEWAY ?? 'https://api.wave.online',
  mint: MintFn = mintJoinToken,
  open: OpenTransportFn = openTransport,
  sleep: SleepFn | undefined = undefined,
): Promise<TrackResult> {
  // Single-segment ns — identical string used for the mint call and the dialed URL below, so the
  // relay's exact-binding check (minted ns == dialed ns) always sees a match.
  const ns = cfg.namespace;
  const pubUrl = wsUrl(relayBase, 'publish', ns, cfg.track);
  const subUrl = wsUrl(relayBase, 'subscribe', ns, cfg.track);
  const count = Math.max(1, Math.floor(durationMs / cfg.intervalMs));

  let subTransport: Transport | undefined;
  let pubTransport: Transport | undefined;
  try {
    // THE FIX: publisher first, subscriber second. The relay requires an active publisher for a
    // subscribe to succeed — see ./src/subscriber-retry.ts for the full rationale and the measured
    // failure this fixes. Each leg still mints its OWN token, bound to its OWN (role, ns, track).
    let pubToken: string | undefined;
    try {
      pubToken = await resolveTrackToken(gateway, 'publish', ns, cfg.track, mint);
    } catch (e) {
      throw new TrackStageError(e, 'publisher', 'mint', ns, cfg.track);
    }
    try {
      pubTransport = await open(pubUrl, 'websocket', 'publish', pubToken);
    } catch (e) {
      throw new TrackStageError(e, 'publisher', 'transport-connect', ns, cfg.track);
    }
    // Coordination for STEADY-STATE latency: gate the publisher's object stream on the subscriber
    // being attached. `announced` resolves once PUBLISH_NAMESPACE is sent (so the subscriber's
    // 404-retry can succeed); `subscriberReady` is resolved once the subscriber is attached, releasing
    // the publisher's send loop. Without this the publisher sent from t=0 while the subscriber attached
    // ~seconds later, and the relay delivered those early objects late — inflating p50/p95 ~50x over
    // the true per-hop floor. `subscriberReady` is resolved in a finally so a subscriber failure can
    // never leave the publisher parked forever on its startSignal.
    let resolveAnnounced!: () => void;
    const announced = new Promise<void>((r) => { resolveAnnounced = r; });
    let resolveSubscriberReady!: () => void;
    const subscriberReady = new Promise<void>((r) => { resolveSubscriberReady = r; });

    const publisherPromise = runPublish({
      transport: pubTransport,
      peer: pubUrl,
      namespace: [ns],
      track: cfg.track,
      count,
      intervalMs: cfg.intervalMs,
      payloadBytes: cfg.payloadBytes,
      groupSize: cfg.groupSize,
      onAnnounced: resolveAnnounced,
      startSignal: subscriberReady,
    }).catch((e) => {
      throw new TrackStageError(e, 'publisher', 'publish', ns, cfg.track);
    });

    try {
      // Wait until the publisher has announced before attaching the subscriber. Race against
      // publisherPromise so an announce-time publisher failure surfaces here rather than hanging.
      await Promise.race([announced, publisherPromise]);

      // Subscriber second — its own open() retries a bounded number of times on the relay's
      // publisher-not-yet-announced 404 (announce propagation is not instantaneous even though the
      // publisher's transport is already open above), instead of racing it once and failing the track.
      let subToken: string | undefined;
      try {
        subToken = await resolveTrackToken(gateway, 'subscribe', ns, cfg.track, mint);
      } catch (e) {
        throw new TrackStageError(e, 'subscriber', 'mint', ns, cfg.track);
      }
      try {
        subTransport = sleep
          ? await openSubscriberWithRetry(open, subUrl, subToken, undefined, sleep)
          : await openSubscriberWithRetry(open, subUrl, subToken);
      } catch (e) {
        throw new TrackStageError(e, 'subscriber', 'transport-connect', ns, cfg.track);
      }
    } finally {
      // Release the publisher's object stream no matter what: on success the subscriber is attached
      // (steady-state), on failure this lets the parked publisher observe the closed transport and
      // return cleanly instead of dangling on an unresolved startSignal.
      resolveSubscriberReady();
    }
    const subscriberPromise = runSubscribe({
      transport: subTransport,
      peer: subUrl,
      namespace: [ns],
      track: cfg.track,
      durationMs: durationMs + 3_000, // grace window past the publisher's own stop
      maxObjects: count,
    }).catch((e) => {
      throw new TrackStageError(e, 'subscriber', 'subscribe', ns, cfg.track);
    });

    const [publisher, subscriber] = await Promise.all([publisherPromise, subscriberPromise]);
    return { config: cfg, publisher, subscriber };
  } finally {
    pubTransport?.close();
    subTransport?.close();
  }
}

export interface CatalogTrackSummary {
  namespace: string;
  track: string;
}

export async function readCatalog(relayBase: string): Promise<{ status: number; tracks: CatalogTrackSummary[]; raw: unknown }> {
  const url = new URL('/v1/catalog', relayBase).toString();
  const res = await fetch(url);
  const raw = await res.json().catch(() => null);
  const tracks: CatalogTrackSummary[] = Array.isArray((raw as { tracks?: unknown })?.tracks)
    ? (raw as { tracks: Array<{ namespace?: string; name?: string }> }).tracks.map((t) => ({
        namespace: t.namespace ?? '',
        track: t.name ?? '',
      }))
    : [];
  return { status: res.status, tracks, raw };
}

function errorRate(results: PromiseSettledResult<TrackResult>[]): number {
  if (results.length === 0) return 0;
  const bad = results.filter(
    (r) => r.status === 'rejected' || r.value.publisher.outcome !== 'ok' || r.value.subscriber.outcome !== 'ok',
  ).length;
  return bad / results.length;
}

interface Args {
  tracks: number;
  durationMs: number;
  intervalMs: number;
  groupSize: number;
  relay: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags.set(a.slice(2), 'true');
    else flags.set(a.slice(2, eq), a.slice(eq + 1));
  }
  const tracks = Number(flags.get('tracks') ?? 16);
  const requestedDuration = Number(flags.get('duration') ?? MAX_DURATION_MS);
  return {
    tracks,
    durationMs: Math.min(requestedDuration, MAX_DURATION_MS),
    intervalMs: Math.max(1, Number(flags.get('interval') ?? 100)),
    groupSize: Math.max(0, Number(flags.get('group-size') ?? 0)),
    relay: flags.get('relay') ?? 'https://moq.wave.online',
    json: flags.has('json'),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `${Date.now()}`;
  const trackSet = buildTrackSet(args.tracks, runId, args.intervalMs, args.groupSize);
  const benchNamespace = benchNamespaceFor(runId);

  const startedAt = new Date().toISOString();
  process.stderr.write(
    `[bench] run=${runId} relay=${args.relay} tracks=${trackSet.length} durationMs=${args.durationMs} ns=${benchNamespace}\n`,
  );

  // Canary wave: launch the first CANARY_TRACKS, check the error rate, only then launch the rest.
  const canary = trackSet.slice(0, Math.min(CANARY_TRACKS, trackSet.length));
  const rest = trackSet.slice(canary.length);

  const canarySettled = await Promise.allSettled(canary.map((t) => runOneTrack(args.relay, t, args.durationMs)));
  const canaryErrorRate = errorRate(canarySettled);
  process.stderr.write(`[bench] canary n=${canary.length} error_rate=${canaryErrorRate.toFixed(2)}\n`);

  let restSettled: PromiseSettledResult<TrackResult>[] = [];
  let aborted = false;
  if (canaryErrorRate > ERROR_RATE_ABORT_THRESHOLD) {
    aborted = true;
    process.stderr.write(
      `[bench] ABORTED — canary error rate ${canaryErrorRate.toFixed(2)} > threshold ${ERROR_RATE_ABORT_THRESHOLD}; remaining ${rest.length} track(s) not launched\n`,
    );
  } else if (rest.length > 0) {
    restSettled = await Promise.allSettled(rest.map((t) => runOneTrack(args.relay, t, args.durationMs)));
  }

  const settled = [...canarySettled, ...restSettled];
  const results: TrackResult[] = settled.filter((r): r is PromiseFulfilledResult<TrackResult> => r.status === 'fulfilled').map((r) => r.value);
  const failures = settled.length - results.length;

  // Surface WHY each failed track failed — previously the per-track error was caught only by
  // `Promise.allSettled` above and discarded, so a canary abort gave no clue whether mint,
  // transport-connect, or the session itself was the failing stage. See src/track-failure.ts.
  const canaryErrors: CanaryErrorDetail[] = collectCanaryErrors(settled);
  for (const e of canaryErrors) logTrackFailure(e);

  // Catalog read WHILE tracks are (mostly) still connected — subscribers hold for durationMs+3s grace.
  const catalogDuring = await readCatalog(args.relay).catch((e) => ({ status: -1, tracks: [], raw: String(e) }));

  // Aggregate latency across every subscriber's samples (true end-to-end: publisher timestamp -> receipt).
  const allLatencySamplesMs: number[] = [];
  let totalMissing = 0;
  let totalOutOfOrder = 0;
  let totalObjectsReceived = 0;
  for (const r of results) {
    totalMissing += r.subscriber.ordering.missing;
    totalOutOfOrder += r.subscriber.ordering.outOfOrder;
    totalObjectsReceived += r.subscriber.objects;
    if (r.subscriber.rawLatencySamplesMs) allLatencySamplesMs.push(...r.subscriber.rawLatencySamplesMs);
  }
  // Percentiles are never averaged across sessions — every raw sample is pooled once, then the
  // percentile is computed on the pooled set, so this is a true cross-track distribution.
  const aggregate = percentiles(allLatencySamplesMs);

  // Give the relay a moment to expire announce state after publishers close, then re-read.
  await new Promise((r) => setTimeout(r, 2_000));
  const catalogAfter = await readCatalog(args.relay).catch((e) => ({ status: -1, tracks: [], raw: String(e) }));

  const finishedAt = new Date().toISOString();

  const report = {
    runId,
    startedAt,
    finishedAt,
    relay: args.relay,
    benchNamespace,
    configuredTracks: trackSet.length,
    canaryTracks: canary.length,
    canaryErrorRate,
    aborted,
    durationMs: args.durationMs,
    tracksCompleted: results.length,
    tracksFailed: failures,
    // Self-describing on its own: every failed track's role/ns/track/stage/message, so a re-run's
    // JSON needs no paired stderr scrollback to explain a nonzero tracksFailed/error_rate.
    canaryErrors,
    drop: { missing: totalMissing, outOfOrder: totalOutOfOrder, objectsReceived: totalObjectsReceived },
    perTrack: results.map((r) => ({
      track: r.config.track,
      trackClass: r.config.trackClass,
      publisherOutcome: r.publisher.outcome,
      subscriberOutcome: r.subscriber.outcome,
      objectsSent: r.publisher.objects,
      objectsReceived: r.subscriber.objects,
      latency: r.subscriber.latency,
      ordering: r.subscriber.ordering,
    })),
    aggregate,
    catalogDuring: { status: catalogDuring.status, benchTracksLive: catalogDuring.tracks.filter((t) => t.namespace.startsWith(BENCH_NAMESPACE_PREFIX)).length, tracks: catalogDuring.tracks },
    catalogAfter: { status: catalogAfter.status, benchTracksLive: catalogAfter.tracks.filter((t) => t.namespace.startsWith(BENCH_NAMESPACE_PREFIX)).length, tracks: catalogAfter.tracks },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return aborted || failures > 0 ? 1 : 0;
}

// Only run when executed directly (not when imported for its exports by tests).
if (process.argv[1] && (process.argv[1].endsWith('bench-sixteen-track.ts') || process.argv[1].endsWith('bench-sixteen-track.js'))) {
  main().then((code) => process.exit(code));
}
