/// <reference types="@cloudflare/workers-types" />
/**
 * MoQ → API gateway usage emit (#284 / #265 MoQ slice).
 *
 * The relay accumulates a real per-track meter (metrics-collector.ts: live QUIC bytes/frames/reconnects).
 * This module flushes that meter to the gateway's #236 per-dimension ingest (POST /v1/internal/usage,
 * service-token gated) at the END of a publisher session, so a MoQ stream produces REAL billable usage
 * instead of being a `metered: true` claim with nothing behind it (capabilities.json).
 *
 * HONESTY + SAFETY GATES (this is why the MoQ spoke can claim metered:true without lying):
 *   • No org → SKIP. The gateway injects `x-wave-org` only on an authorized request; when it's absent
 *     (anonymous / direct traffic while MOQ_REQUIRE_AUTH is off) there is no principal to bill, and we
 *     NEVER fabricate one. No org = no emit.
 *   • GATEWAY_BASE_URL / WAVE_SERVICE_TOKEN unset → SKIP. The emit is INERT until an operator provisions
 *     both (the URL var + the secret), mirroring the gateway's own USAGE_INGEST default-off staging — so
 *     merging this changes nothing on the live relay until the operator opts in (#263 / per-edge secret).
 *   • Zero usage → SKIP. A session that moved no bytes/frames and lasted no time emits nothing.
 *   • Any fetch error → swallowed. A usage emit must NEVER affect the live relay (fail-open).
 *
 * The meter has no fps (a relay doesn't decode), so duration can't be derived frame/fps; we send the real
 * publisher-session wall-time as `session_ms`. `protocol` defaults to `"moq"` UNLESS the publisher
 * EXPLICITLY declared a different origin protocol (task#14, e.g. 'dante') at mint/publish time — see
 * MoqUsageArgs.protocol — so the gateway bills it as the matching per-protocol stream-minute dimension
 * (`duration_ms:moq` or `duration_ms:dante`, api-gateway #262).
 */

/** The subset of the worker/DO env this emit reads. Both are optional → emit is inert until provisioned. */
export interface MoqUsageEmitEnv {
  /** Gateway origin, e.g. https://api.wave.online (var; not a secret). */
  GATEWAY_BASE_URL?: string;
  /** Internal service-to-service bearer for /v1/internal/usage (secret; `wrangler secret put`). */
  WAVE_SERVICE_TOKEN?: string;
}

/** Primitive snapshot of one publisher session's accumulated usage (captured BEFORE the meter is reset). */
export interface MoqUsageArgs {
  org: string | null;
  trackKey: string;
  sessionId: string;
  bytes: number;
  frames: number;
  reconnects: number;
  sessionMs: number;
  /**
   * task#14: the origin protocol the PUBLISHER explicitly declared at mint/publish time (e.g. 'dante'),
   * threaded from the relay's verified join-token claim (moq-session-do.ts publisherProtocol) — NEVER
   * inferred from the namespace/trackKey (that would risk mis-billing other moq traffic sharing a strand
   * path). Undefined/absent → this is real MoQ-native traffic → bills as 'moq' (unchanged default).
   */
  protocol?: string;
}

/** The gateway `/v1/internal/usage` request envelope (matches api-gateway src/usage.ts handleUsageIngest). */
interface UsageEnvelope {
  org: string;
  usage: {
    protocol: string; // 'moq' (default) | 'dante' (task#14, when the publisher declared it) | future protocols
    bytes: number;
    frames: number;
    reconnects: number;
    session_ms?: number;
    session_id: string;
    event_id: string;
  };
}

/** True only when there is a real principal AND real usage AND the operator has provisioned the emit. */
export function shouldEmit(env: MoqUsageEmitEnv, a: MoqUsageArgs): boolean {
  if (!a.org) return false; // no principal → never fabricate an org to bill
  if (!env.GATEWAY_BASE_URL || !env.WAVE_SERVICE_TOKEN) return false; // inert until operator provisions
  return a.bytes > 0 || a.frames > 0 || a.sessionMs > 0; // nothing real → don't emit a zero event
}

/**
 * Build the gateway ingest envelope, or null when {@link shouldEmit} says we must not emit. Pure (no I/O)
 * so the honesty gate is unit-testable without a network. `event_id` is per publisher session (the
 * sessionId is a fresh UUID per connection) → the gateway dedupes a redelivery.
 */
export function buildMoqUsageBody(env: MoqUsageEmitEnv, a: MoqUsageArgs): UsageEnvelope | null {
  if (!shouldEmit(env, a)) return null;
  const protocol = a.protocol || 'moq'; // task#14: declared protocol wins; undeclared → real MoQ traffic
  return {
    org: a.org as string,
    usage: {
      protocol,
      bytes: a.bytes,
      frames: a.frames,
      reconnects: a.reconnects,
      ...(a.sessionMs > 0 ? { session_ms: a.sessionMs } : {}),
      session_id: a.sessionId,
      event_id: `${protocol}:${a.trackKey}:${a.sessionId}`,
    },
  };
}

/**
 * Flush one publisher session's usage to the gateway. Fire-and-forget friendly (call via
 * state.waitUntil); never throws. No-op (and no network) when {@link shouldEmit} is false.
 */
export async function emitMoqUsage(env: MoqUsageEmitEnv, a: MoqUsageArgs): Promise<void> {
  const body = buildMoqUsageBody(env, a);
  if (!body) return;
  const base = (env.GATEWAY_BASE_URL as string).replace(/\/+$/, '');
  try {
    await fetch(`${base}/v1/internal/usage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.WAVE_SERVICE_TOKEN as string}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    /* fail-open: a usage emit must never affect the live relay */
  }
}
