/**
 * WAVE MoQ Edge — shared Worker Env type.
 *
 * NOTE: Does NOT extend ChassisEnv directly because @wave-av/spoke-chassis ^0.10.0 introduced
 * a transitive NotifyEnv index signature `[key: string]: string | undefined` that conflicts with
 * CF binding types (DurableObjectNamespace, KVNamespace, R2Bucket are not `string | undefined`).
 * Instead the chassis call in index.ts uses `env as ChassisEnv`. All required chassis fields
 * (GATEWAY_ORIGIN, POSTHOG_KEY, etc.) are optional strings, so the cast is always safe.
 */

export type { Env as ChassisEnv } from '@wave-av/spoke-chassis';
import type { ContainerBinding } from './moq-sfu-fanout';

/**
 * Worker Env — bindings + vars + secrets. NOTHING here is inlined;
 * bindings come from wrangler.toml and secrets via `wrangler secret put`.
 */
export interface Env {

  // --- CF bindings (wrangler.toml) ---
  /** Durable Object namespace for per-track relay sessions. */
  MOQ_SESSIONS: DurableObjectNamespace;
  /** KV namespace for track registry (announce/catalog/discovery). */
  MOQ_TRACK_REGISTRY: KVNamespace;
  /** R2 bucket for MoQ recordings. */
  MOQ_RECORDINGS: R2Bucket;

  // --- vars (wrangler.toml [vars]) ---
  ENVIRONMENT: string;
  MOQ_DRAFT_VERSION: string;
  MOQ_DRAFT_SUPPORTED?: string;
  MAX_SUBSCRIBERS_PER_TRACK: string;
  MAX_OBJECT_SIZE_BYTES: string;
  LOG_LEVEL: string;
  /** When "true", enforce wave-token-v1 moq:write/moq:read scopes on publish/subscribe. Default off. */
  MOQ_REQUIRE_AUTH?: string;
  /** Number of recent groups replayed to new late-joining subscribers. */
  MOQ_CACHED_GROUPS?: string;
  /** WAVE gateway base URL, e.g. https://api.wave.online. */
  GATEWAY_BASE_URL?: string;
  /** R2 bucket name for recording registration (must match wrangler binding). */
  MOQ_RECORDINGS_BUCKET?: string;
  /** #55 MoQ→SFU fan-out (Builder A). Default-OFF flag; "true" only activates when MOQ_SFU_FANOUT
   *  (below) is ALSO bound — else the /v1/fanout/sfu route returns a typed 501. NEVER fakes transport. */
  MOQ_SFU_FANOUT_ENABLED?: string;
  /** #144 Per-publisher microVM isolation (DARK/default-OFF). "true" only takes effect when a real
   *  MOQ_MICROVM binding is ALSO present — else the hook fail-closes to a typed 501. LAW #130: client
   *  media = cloud microVM ONLY, enforced by src/publisher-isolation.ts rejectsLocalForClient(). */
  MOQ_MICROVM_ISOLATION?: string;
  /** #144 Substrate cells run on. Default 'cloud-microvm' (LAW-#130-safe). 'local-dev' is internal-dev
   *  ONLY and is NEVER honoured for client media (guarded, fail-closed). */
  MOQ_MICROVM_SUBSTRATE?: string;

  // --- container binding (wrangler.toml [[containers]], operator-gated) ---
  /** #55 CF Container running the MoQ-subscribe → decode → VP8/Opus → WHIP-publish engine. Absent today
   *  (image unbuilt + CF Containers gated to the d674452f account). Media/transcode lives HERE, never on
   *  the Worker (frozen contract §9 invariant #2). Absent → honest typed 501; no fabricated transport. */
  MOQ_SFU_FANOUT?: ContainerBinding;

  // --- secrets (wrangler secret put) ---
  /** Machine credential for server-to-server usage emit → gateway. Inert until set. */
  WAVE_SERVICE_TOKEN?: string;
  /**
   * Shared secret proving the request came from the WAVE gateway (#16.2 spoke-spoof hardening).
   * INERT when unset (presence-based gateway trust only). `wrangler secret put WAVE_GATEWAY_SECRET`.
   */
  WAVE_GATEWAY_SECRET?: string;
}
