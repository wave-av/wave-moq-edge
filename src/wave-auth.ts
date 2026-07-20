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

/* ============================================================================
 * TENANT ISOLATION (task #45) — namespace→org binding.
 *
 * scopeGate above proves a caller holds moq:read/moq:write, but NOT *which*
 * namespaces they may touch — so with the flag on, any moq:read principal could
 * still subscribe to ANY org's track. This closes that: a namespace is OWNED by
 * exactly one org, and a principal may only publish/subscribe/enumerate the
 * namespaces its gateway-injected org owns. Pure + flag-gated + default-OFF,
 * exactly like scopeGate: when MOQ_REQUIRE_AUTH is off every function below is a
 * no-op and the live relay is unchanged.
 * ========================================================================== */

/**
 * The canonical gateway-injected organization header. The gateway stamps the
 * authenticated principal's org id here (`x-wave-org: <organizationId>`), the
 * same convention as the x-wave-scopes principal above. The edge CONSUMES it —
 * it is the source of truth for tenant identity. Never invent a different literal.
 */
export const WAVE_ORG_HEADER = 'x-wave-org';

/**
 * task#14: the RELAY-TRUSTED declared-origin-protocol header (e.g. 'dante'), set ONLY by
 * withVerifiedPrincipal from a verified join-token's signed `protocol` claim — the DO reads this to bill
 * a Dante-origin session as `duration_ms:dante` instead of the 'moq' default. Distinct from the unrelated
 * `x-wave-protocol` spoke-attribution header (wave-dante-edge proxy.ts), which the gateway forward() path
 * uses for a different purpose and which this relay never trusts for billing.
 */
export const WAVE_DECLARED_PROTOCOL_HEADER = 'x-wave-declared-protocol';

/**
 * task#14 CONFIRMED under-bill fix: the SET of protocols the relay will ever trust in
 * {@link WAVE_DECLARED_PROTOCOL_HEADER} (mirrors the gateway's scopes.ts PROTOCOL_RESOURCES — the same
 * set usage.ts sources its `duration_ms:<protocol>` billing dimensions from). Defense-in-depth: even if a
 * future regression let an unverified value reach the DO, an unrecognized string can never bill a
 * dimension that doesn't exist. Duplicated here (not imported cross-repo) because the relay and
 * the gateway are separate deployables; keep in sync with the gateway's PROTOCOL_RESOURCES.
 */
export const KNOWN_DECLARABLE_PROTOCOLS = new Set(['srt', 'ndi', 'dante', 'omt', 'moq']);

/**
 * task#14 CONFIRMED under-bill fix: unconditionally strip any CLIENT-supplied declared-protocol header
 * before the request reaches the mode branch / the DO. Only {@link withVerifiedPrincipal} (moq-join-verify)
 * is allowed to SET this header, and only from a cryptographically verified join-token claim — so this
 * must run in EVERY mode (off/shadow/enforce), not just when enforce is active, otherwise a client dialing
 * the public publish socket directly (join enforcement off or shadow) could self-declare a cheaper protocol
 * and under-bill. Returns a NEW Request; the original is untouched.
 */
export function stripDeclaredProtocol(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(WAVE_DECLARED_PROTOCOL_HEADER);
  return new Request(request, { headers });
}

/** The gateway-injected org id, trimmed; null when absent/empty. */
export function extractInjectedOrg(request: Request): string | null {
  const raw = request.headers.get(WAVE_ORG_HEADER);
  if (!raw) return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

/**
 * PURE prefix-ownership: is `namespace` owned by org `org`? A namespace belongs
 * to org X iff it is exactly `X` or begins with `X-` (the org id as the root
 * segment, dash-delimited). The dash separator is load-bearing: it prevents
 * prefix-confusion — org `A` must own `A` and `A-live` but NOT `AB` or `AB-x`.
 * An empty/absent org owns nothing (fail-closed).
 */
export function orgOwnsNamespace(org: string | null, namespace: string): boolean {
  if (!org) return false;
  return namespace === org || namespace.startsWith(`${org}-`);
}

/**
 * The namespace→org gate. Returns null to proceed, or 403 to reject.
 *   MOQ_REQUIRE_AUTH off (DEFAULT) → always null (live relay unchanged).
 *   on → require a gateway-injected x-wave-org that OWNS `namespace`, else 403.
 *        A missing org (enforced) is a 403 too — the gateway must inject it.
 * Compose this AFTER scopeGate in the publish/subscribe handlers.
 */
export function orgGate(request: Request, env: AuthEnv, namespace: string): Response | null {
  if (!authRequired(env)) return null; // off → no behavioral change
  const org = extractInjectedOrg(request);
  if (orgOwnsNamespace(org, namespace)) return null;
  const detail = org
    ? `org '${org}' does not own namespace '${namespace}'`
    : `missing ${WAVE_ORG_HEADER} — the gateway must inject the principal's org`;
  return new Response(
    JSON.stringify({
      type: 'https://httpstatuses.io/403',
      title: 'Forbidden',
      status: 403,
      detail,
      namespace,
    }),
    {
      status: 403,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer realm="moq.wave.online", error="insufficient_scope", scope="tenant:${namespace}"`,
      },
    }
  );
}

/**
 * Scope a track-discovery list (/announce, /catalog) to the caller's org so the
 * relay is not a cross-org directory. `namespaceOf` extracts the namespace from
 * one entry (entries differ between callers, so the accessor is injected).
 *   off → return `entries` unchanged (live relay unchanged).
 *   on  → keep only entries whose namespace the caller's injected org owns; a
 *         missing org (enforced) yields an empty list (fail-closed).
 */
export function filterTracksForOrg<T>(
  entries: T[],
  request: Request,
  env: AuthEnv,
  namespaceOf: (e: T) => string
): T[] {
  if (!authRequired(env)) return entries;
  const org = extractInjectedOrg(request);
  if (!org) return [];
  return entries.filter((e) => orgOwnsNamespace(org, namespaceOf(e)));
}
