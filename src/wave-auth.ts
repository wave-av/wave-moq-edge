/**
 * wave-token-v1 edge auth gate for the MoQ relay.
 *
 * `wave-token-v1` is WAVE's bearer-token scheme advertised in capabilities.json (auth field) and
 * carried as `Authorization: Bearer wave-token-v1.<token>` — the same convention the sibling edge
 * wave-realtime-edge uses (docs/api/openapi.yaml). This module is the EDGE half: it validates the
 * token's FORMAT at the relay front door so unauthenticated traffic is rejected before a Durable
 * Object / WebSocket is ever opened.
 *
 * It does NOT (yet) verify the token against an identity store or check entitlement/quota — that is
 * gateway-side, federated exactly like realtime-edge (#108 gateway entitlement federation). Wiring the
 * verified token through to a gateway entitlement check is the follow-on; this PR only adds the
 * format gate so the advertised `auth: wave-token-v1` is real at the edge instead of unenforced.
 *
 * PURE + flag-gated: the gate is OFF unless MOQ_REQUIRE_AUTH is set truthy, so enabling it is an
 * explicit operator action — existing unauthenticated clients on the live relay keep working until
 * an operator opts in (a behavioral change to a live path must never flip on by default).
 */

/** The wave-token-v1 bearer prefix. A well-formed token is `wave-token-v1.<opaque-body>`. */
export const WAVE_TOKEN_PREFIX = 'wave-token-v1.';

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
