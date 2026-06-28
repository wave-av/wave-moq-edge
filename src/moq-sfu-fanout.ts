/**
 * MoQ → WAVE SFU fan-out leg (#55 / #91 any-protocol-ingest, Builder A — CF-native).
 *
 * WHAT THIS IS (and ISN'T):
 *   This is the CONTROL/SIGNALING half of the MoQ→SFU fan-out leg. The MoQ relay (moq-session-do.ts)
 *   already RECEIVES real MoQ objects on a live track. This module opens a fan-out SESSION that asks a
 *   sidecar CONTAINER to: subscribe to that track, DEMUX+DECODE the MoQ media, RE-ENCODE to a
 *   WebRTC-negotiable codec (VP8/Opus), and PUBLISH it via @wave-av/whip-publish to the gateway
 *   /v1/whip/publish (the SFU). The Worker NEVER touches media — invariant #2 (frozen contract §9):
 *   media/transcode happens IN A CONTAINER, never on a Worker. The Worker is signaling only.
 *
 * HONESTY CONTRACT (mirrors wave-bridge-edge/src/srt.ts — no fabricated transport, ever):
 *   - The fan-out container (the MoQ-subscribe → decode → VP8/Opus → WHIP-publish engine) is NOT built
 *     or pushed yet, and is bound only when an operator provisions the [[containers]] MOQ_SFU_FANOUT
 *     binding on a CF-Containers-enabled account. So this route returns a TYPED, HONEST 501
 *     `MOQ_SFU_FANOUT_NOT_ACTIVATED` today. It never claims a live SFU track while no transport can run.
 *   - The forward SHAPE is wired behind `MOQ_SFU_FANOUT_ENABLED` (default OFF). Even when an operator
 *     flips it ON, it FAIL-CLOSES to the same honest 501 unless the real MOQ_SFU_FANOUT container
 *     binding is present — i.e. the forward branch is inert until BOTH the image lands AND CF Containers
 *     is enabled. No dormant fake success path exists.
 *
 * TRUST MODEL: moq.wave.online sits BEHIND the WAVE API gateway. The gateway runs authorize →
 * scope(moq:read|moq:write) → entitlement → meter, then forwards with x-wave-org / x-wave-tier
 * attribution headers. This worker is the origin; it makes NO access decision of its own. The fan-out
 * leg is just another WHIP publisher (frozen contract §3): the gateway proxies the republish; the
 * gateway never mints, never touches media. Billing rides the existing wave_stream_bridge_minutes meter
 * (frozen contract §5) — no new SKU here.
 */

/** A minimal container-binding shape (CF Containers `fetch`). Present only once the operator provisions
 *  the [[containers]] MOQ_SFU_FANOUT block in wrangler.toml AND CF Containers is enabled on the account.
 *  Kept local (no @cloudflare/containers dep) so the control-plane Worker stays dependency-light — the
 *  binding is what the runtime injects, this is just its structural type. */
export interface ContainerBinding {
  fetch(request: Request): Promise<Response>;
}

/** Env knobs this leg reads (a subset of the worker Env). */
export interface MoqSfuFanoutEnv {
  /** Default-OFF activation flag. Unset/"false" = honest 501. Flipping to "true" only takes effect when
   *  the MOQ_SFU_FANOUT binding is ALSO present — otherwise still fail-closes to the typed 501. */
  MOQ_SFU_FANOUT_ENABLED?: string;
  /** CF Container binding for the MoQ→decode→VP8/Opus→WHIP-publish engine. Absent today (image unpushed
   *  + CF Containers gated to the d674452f account). Absent → honest typed 501; no fabricated transport. */
  MOQ_SFU_FANOUT?: ContainerBinding;
}

/** Canonical MoQ protocol scopes — the SAME literals the gateway authorizes against (never invent new).
 *  Opening a fan-out (a mutating control action) requires moq:write; a status read requires moq:read. */
export const MOQ_SFU_SCOPES = { read: 'moq:read', write: 'moq:write' } as const;

/** Seconds a client should wait before retrying — activation is operator-gated, not transient. */
export const MOQ_SFU_RETRY_AFTER_SECONDS = 86_400; // 24h: a productization gate, not a blip.

/** TRUE only when the fan-out flag is ON **and** a real container binding exists. Today: always false. */
export function moqSfuFanoutActivated(env: MoqSfuFanoutEnv): boolean {
  return env.MOQ_SFU_FANOUT_ENABLED === 'true' && typeof env.MOQ_SFU_FANOUT?.fetch === 'function';
}

/** Honest "not activated yet" body — accurate machine-readable state for agents. Claims nothing live. */
export function notActivatedBody(method: string) {
  return {
    error: 'MOQ_SFU_FANOUT_NOT_ACTIVATED',
    protocol: 'moq',
    leg: 'moq->sfu',
    // Honest lifecycle: the control-plane scaffold exists, but the transcode/WHIP container cannot run yet.
    status: 'not_activated',
    metered: false,
    live: false,
    required_scope: method === 'GET' || method === 'HEAD' ? MOQ_SFU_SCOPES.read : MOQ_SFU_SCOPES.write,
    // Exactly what an operator must do — no hidden magic, no fake success path (frozen contract §7 step 3-4).
    blockers: [
      'build + push the MoQ→decode→VP8/Opus→WHIP-publish container image (unbuilt)',
      'enable CF Containers on the deploying account (d674452f)',
      'provision the [[containers]] MOQ_SFU_FANOUT binding in wrangler.toml',
      'set MOQ_SFU_FANOUT_ENABLED=true',
      'bind the bridge wk_ key (whip:write) + x-wave-meter-override: wave_stream_bridge_minutes',
    ],
    docs: 'https://moq.wave.online/llms.txt',
  };
}

/**
 * Handle a MoQ→SFU fan-out control request for a given track.
 *
 * - Activated (flag ON + MOQ_SFU_FANOUT bound): forward the control call to the fan-out container, which
 *   subscribes to the live MoQ track, decodes, re-encodes to VP8/Opus, and WHIP-publishes to the SFU.
 *   This branch is the spec'd SHAPE; it is unreachable today (no binding) so it cannot fabricate a track.
 *   The track identity is appended as a header so the container knows which MoQ track to fan out (the
 *   gateway has already injected x-wave-org / x-wave-scopes upstream; this is a pure control forward).
 * - Not activated (the only real state today): honest typed 501 + Retry-After. NEVER fake transport.
 */
export async function handleMoqSfuFanout(
  request: Request,
  env: MoqSfuFanoutEnv,
  track: { namespace: string; name: string },
): Promise<Response> {
  if (moqSfuFanoutActivated(env)) {
    // SHAPE: hand the control call to the fan-out container. Inert until the image + CF Containers land.
    // We thread the resolved track identity through so the container knows which MoQ track to subscribe
    // to; everything else (org/scope/meter) was already stamped by the gateway upstream.
    const fwd = new Request(request);
    fwd.headers.set('x-wave-moq-namespace', track.namespace);
    fwd.headers.set('x-wave-moq-track', track.name);
    return env.MOQ_SFU_FANOUT!.fetch(fwd);
  }
  return Response.json(notActivatedBody(request.method), {
    status: 501,
    headers: {
      'retry-after': String(MOQ_SFU_RETRY_AFTER_SECONDS),
      'cache-control': 'no-store',
    },
  });
}

export const __testing = {
  MOQ_SFU_SCOPES,
  MOQ_SFU_RETRY_AFTER_SECONDS,
  moqSfuFanoutActivated,
  notActivatedBody,
};
