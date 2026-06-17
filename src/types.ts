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

  // --- secrets (wrangler secret put) ---
  /** Machine credential for server-to-server usage emit → gateway. Inert until set. */
  WAVE_SERVICE_TOKEN?: string;
  /**
   * Shared secret proving the request came from the WAVE gateway (#16.2 spoke-spoof hardening).
   * INERT when unset (presence-based gateway trust only). `wrangler secret put WAVE_GATEWAY_SECRET`.
   */
  WAVE_GATEWAY_SECRET?: string;
}
