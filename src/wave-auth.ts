/**
 * wave-token-v1 edge auth gate for the MoQ relay.
 *
 * `wave-token-v1` is WAVE's bearer-token scheme advertised in capabilities.json (auth field) and
 * carried as `Authorization: Bearer wave-token-v1.<token>` — the same convention the sibling edge
 * wave-realtime-edge uses (docs/api/openapi.yaml). This module is the EDGE half: it validates the
 * token's FORMAT at the relay front door so unauthenticated traffic is rejected before a Durable
 * Object / WebSocket is ever opened.
 *
 * It does NOT cryptographically verify the token against an identity store — that is gateway-side,
 * federated exactly like realtime-edge (#108 gateway entitlement federation). What it DOES add (task
 * #285) on top of the format gate is canonical SCOPE enforcement: when enforcement is on, publishing a
 * track requires `moq:write` and subscribing requires `moq:read` (the gateway maps moq:write→publish,
 * moq:read→subscribe), read from the gateway-injected principal (x-wave-scopes header). This closes the
 * anonymous-access hole at the relay front door instead of leaving the advertised
 * `auth: wave-token-v1, metered: true` (capabilities.json) unenforced.
 *
 * PURE + flag-gated: every gate is OFF unless MOQ_REQUIRE_AUTH is set truthy, so enabling it is an
 * explicit operator action (task #288) — existing unauthenticated clients on the live relay keep
 * working until an operator opts in (a behavioral change to a live path must never flip on by default).
 */

/** The wave-token-v1 bearer prefix. A well-formed token is `wave-token-v1.<opaque-body>`. */
export const WAVE_TOKEN_PREFIX = 'wave-token-v1.';

/**
 * Canonical MoQ protocol scopes (the SINGLE vocabulary from task #281 / the API gateway PR #71, mirrored
 * here so the edge enforces the SAME literals the gateway authorizes against — never invent new names).
 * The gateway maps moq:write→publish and moq:read→subscribe (api-gateway src/scopes.ts §PROTOCOL_GROUPS).
 */
export const MOQ_SCOPE_WRITE = 'moq:write'; // required to PUBLISH a track
export const MOQ_SCOPE_READ = 'moq:read'; //  required to SUBSCRIBE to a track

/**
 * Header carrying the gateway-injected principal's granted scopes, SPACE-delimited — the exact
 * serialization the gateway already uses on its token-exchange response (`scope: scopes.join(" ")`,
 * api-gateway src/worker.ts handleTokenExchange) and the OAuth2 `scope` convention (RFC 6749 §3.3).
 * The gateway is the system of record for the principal; the edge consumes the forwarded scopes here
 * (same trust model as the clip-engine spoke, task #63: spokes consume the gateway-injected principal).
 */
export const WAVE_SCOPES_HEADER = 'x-wave-scopes';

/** Env knobs this gate reads (subset of the worker Env). */
export interface AuthEnv {
  MOQ_REQUIRE_AUTH?: string;
}

/** Is auth enforcement enabled? Truthy values: "1", "true", "on" (case-insensitive). Default: off. */
export function authRequired(env: AuthEnv): boolean {
  const v = (env.MOQ_REQUIRE_AUTH ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * Pull a wave-token-v1 token from a request. Two grounded carriers, in priority order:
 *   1. `Authorization: Bearer wave-token-v1.<t>`  (server-to-server, matches wave-realtime-edge)
 *   2. `?access_token=wave-token-v1.<t>`           (browser WebSocket clients can't set headers)
 * Returns the raw token string (including the prefix) or null when absent.
 */
export function extractWaveToken(request: Request): string | null {
  const auth = request.headers.get('Authorization') ?? request.headers.get('authorization');
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  try {
    const q = new URL(request.url).searchParams.get('access_token');
    if (q) return q;
  } catch {
    /* malformed URL — treat as no token */
  }
  return null;
}

/**
 * Format check only: a non-empty `wave-token-v1.` prefix with a non-trivial opaque body. This is the
 * shape the gateway issues; it is NOT a cryptographic or entitlement check (that is gateway-federated).
 */
export function isWaveTokenWellFormed(token: string | null): boolean {
  if (!token || !token.startsWith(WAVE_TOKEN_PREFIX)) return false;
  const body = token.slice(WAVE_TOKEN_PREFIX.length);
  return body.length >= 8; // reject `wave-token-v1.` with an empty/stub body
}

/**
 * The relay front-door gate. Returns null when the request may proceed, or a 401 Response when auth is
 * enforced and the token is missing/malformed. When MOQ_REQUIRE_AUTH is off this always returns null
 * (no behavioral change to the live relay). RFC 6750 §3 WWW-Authenticate header on rejection.
 */
export function authGate(request: Request, env: AuthEnv): Response | null {
  if (!authRequired(env)) return null;
  const token = extractWaveToken(request);
  if (isWaveTokenWellFormed(token)) return null;
  const detail = token ? 'malformed wave-token-v1 bearer token' : 'missing wave-token-v1 bearer token';
  return new Response(
    JSON.stringify({ type: 'https://httpstatuses.io/401', title: 'Unauthorized', status: 401, detail }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="moq.wave.online", error="invalid_token", scheme="wave-token-v1"',
      },
    }
  );
}

/**
 * Parse the gateway-injected scopes header into a scope set. SPACE-delimited (RFC 6749 §3.3 + the
 * gateway's own `scopes.join(" ")` serialization). Tolerant of repeated whitespace and a missing
 * header (→ empty set). Header name lookup is case-insensitive (Headers normalizes it).
 */
export function extractInjectedScopes(request: Request): Set<string> {
  const raw = request.headers.get(WAVE_SCOPES_HEADER);
  if (!raw) return new Set();
  return new Set(raw.trim().split(/\s+/).filter((s) => s.length > 0));
}

/**
 * Does the gateway-injected principal hold `required`? A wildcard `moq:*` (or global `*`) also grants
 * it — matching the gateway's hasScope semantics (api-gateway src/auth.ts) so the edge never rejects
 * a principal the gateway would have admitted. Pure; no I/O.
 */
export function hasScope(scopes: Set<string>, required: string): boolean {
  if (scopes.has(required)) return true;
  if (scopes.has('*')) return true;
  const colon = required.indexOf(':');
  if (colon > 0 && scopes.has(`${required.slice(0, colon)}:*`)) return true; // e.g. "moq:*" grants "moq:read"
  return false;
}

/**
 * The MoQ scope gate. Composes the format gate (authGate) with a scope check on the gateway-injected
 * principal. Behaviour by flag state (the WHOLE point of this PR — additive, default-OFF):
 *
 *   MOQ_REQUIRE_AUTH off (DEFAULT)  → always null. The live relay is UNCHANGED: anonymous publish AND
 *                                     subscribe keep working exactly as today. Flipping the flag on is
 *                                     an explicit operator action (task #288), never a default.
 *   MOQ_REQUIRE_AUTH on             → (1) authGate: reject missing/malformed wave-token-v1 with 401;
 *                                     (2) require `required` (moq:write for publish, moq:read for
 *                                         subscribe) in the x-wave-scopes principal, else 403. This is
 *                                     what closes the anonymous-access hole: with the flag on, an
 *                                     unauthenticated/unscoped caller can no longer publish or subscribe.
 *
 * Returns null to proceed, or a 401/403 Response to reject. RFC 6750 §3 WWW-Authenticate on rejection.
 */
export function scopeGate(request: Request, env: AuthEnv, required: string): Response | null {
  // Off → no behavioral change to the live relay (also covers the format gate).
  const denied = authGate(request, env);
  if (denied) return denied; // off → null; on+bad-token → 401
  if (!authRequired(env)) return null; // off → proceed (token already validated as null-op above)

  // On + well-formed token: require the canonical scope from the gateway-injected principal.
  const scopes = extractInjectedScopes(request);
  if (hasScope(scopes, required)) return null;
  return new Response(
    JSON.stringify({
      type: 'https://httpstatuses.io/403',
      title: 'Forbidden',
      status: 403,
      detail: `principal lacks required scope: ${required}`,
      required_scope: required,
    }),
    {
      status: 403,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer realm="moq.wave.online", error="insufficient_scope", scope="${required}"`,
      },
    }
  );
}
