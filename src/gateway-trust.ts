/**
 * Gateway-trust boundary for the MoQ relay (task #42 — spoke-spoof hardening, the #16.2 secret made live).
 *
 * WHY THIS EXISTS: the auth gates in wave-auth.ts (scopeGate/orgGate/filterTracksForOrg) derive the
 * caller's identity from request headers the gateway is supposed to inject — `x-wave-org` (tenant),
 * `x-wave-scopes` (granted scopes), `x-wave-tier` (entitlement tier). But moq.wave.online is reachable
 * directly on the public internet, so WITHOUT this module a client that bypasses the gateway could simply
 * SET those headers itself (`x-wave-org: <victim>`, `x-wave-scopes: moq:*`) and defeat tenant isolation
 * the moment MOQ_REQUIRE_AUTH is enabled — spoofed enforcement, not real enforcement.
 *
 * THE FIX (fail-closed): the WAVE gateway alone knows the shared secret WAVE_GATEWAY_SECRET and stamps it
 * on every request it forwards (a dedicated gateway-secret header). At the relay's front door we sanitize the
 * inbound request: unless it carries the matching secret (constant-time compared), we STRIP every
 * gateway-injected principal header so the downstream gates see no identity and fail closed (401/403).
 * The secret header itself is always removed before the request travels deeper (never forwarded to the DO).
 *
 * INERT UNTIL PROVISIONED: when WAVE_GATEWAY_SECRET is unset, this is a pure pass-through — identical to
 * today's behavior — so shipping it changes nothing on the live relay until the secret is minted on BOTH
 * the gateway and the relay (a behavioral change to a live path must never flip on by default). Composes
 * with MOQ_REQUIRE_AUTH: the secret decides WHOSE identity is trusted; MOQ_REQUIRE_AUTH decides whether an
 * (untrusted → empty) identity is rejected.
 *
 * PURE + hermetically testable: Request in → Request out, no I/O.
 */

/** The header the gateway stamps to prove a request passed through it. Never forwarded past this boundary. */
export const WAVE_GATEWAY_SECRET_HEADER = 'x-wave-gateway-secret'; // # guard:allow cross-service protocol header name, not a private-repo reference

/**
 * Every gateway-injected principal header. These confer trust (tenant, scopes, entitlement tier), so a
 * request that cannot prove gateway origin must have ALL of them removed — a partial strip would leave a
 * spoofable field. Header lookup/deletion is case-insensitive per the Fetch spec (Headers normalizes).
 */
export const GATEWAY_INJECTED_HEADERS = ['x-wave-org', 'x-wave-scopes', 'x-wave-tier'] as const;

/** Env subset this boundary reads (the shared secret; a subset of the worker Env). */
export interface GatewayTrustEnv {
  WAVE_GATEWAY_SECRET?: string;
}

/**
 * Constant-time string equality. The CF Workers runtime does not expose Node's crypto.timingSafeEqual over
 * plain strings, so we hand-roll it: XOR-accumulate every char code and OR the length mismatch into the
 * result, so the comparison cost does not depend on WHERE the first differing byte is (no early return on
 * the first mismatch). The secret is a fixed-length high-entropy token, so revealing "lengths differ" via
 * timing is not a meaningful oracle, but we fold length into the constant-time result regardless.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    // charCodeAt past the end is NaN; `| 0` coerces to 0 so we still touch every index up to n.
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/**
 * Did this request prove it came through the WAVE gateway? True only when a secret is configured AND the
 * request carries the gateway-secret header that matches it (constant-time). No secret configured → false
 * (callers treat that as "inert", see sanitizeInjectedHeaders).
 */
export function requestFromGateway(request: Request, env: GatewayTrustEnv): boolean {
  const secret = env.WAVE_GATEWAY_SECRET;
  if (!secret) return false;
  const presented = request.headers.get(WAVE_GATEWAY_SECRET_HEADER);
  if (!presented) return false;
  return timingSafeEqual(presented, secret);
}

/**
 * Return a request safe to hand to the auth gates + DO. Behavior:
 *   - WAVE_GATEWAY_SECRET UNSET (default today) → return the request UNCHANGED (inert pass-through; the
 *     live relay is byte-for-byte unaffected until the secret is provisioned on gateway + relay).
 *   - secret SET + request proves gateway origin → keep the injected principal headers, but drop the
 *     secret header so it never travels past this boundary (defense in depth).
 *   - secret SET + origin NOT proven → drop the secret header AND every gateway-injected principal header,
 *     so scopeGate/orgGate see no identity and fail closed (401/403 when MOQ_REQUIRE_AUTH is on).
 *
 * Reconstructing the request preserves method, body, and the `Upgrade` header (the WebSocket accept happens
 * later in the Durable Object via WebSocketPair, so a header-only clone is safe for WS publish/subscribe).
 */
export function sanitizeInjectedHeaders(request: Request, env: GatewayTrustEnv): Request {
  // Inert until the secret exists on both sides — do not perturb the live relay.
  if (!env.WAVE_GATEWAY_SECRET) return request;

  const trusted = requestFromGateway(request, env);
  const headers = new Headers(request.headers);
  // The secret is a bearer of trust; strip it before the request travels deeper (the DO never needs it).
  headers.delete(WAVE_GATEWAY_SECRET_HEADER);
  if (!trusted) {
    for (const name of GATEWAY_INJECTED_HEADERS) headers.delete(name);
  }
  return new Request(request, { headers });
}
