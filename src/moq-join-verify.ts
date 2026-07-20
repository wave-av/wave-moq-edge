/**
 * #58 MoQ join-token VERIFICATION — the EDGE half of "gateway-authorized, edge-verified, direct-media".
 *
 * moq.wave.online routes DIRECT to this relay (not gateway-fronted), so the legacy auth (wave-auth.ts)
 * trusts a CLIENT-supplied x-wave-scopes/x-wave-org header — spoofable, no crypto. This module closes that
 * hole WITHOUT putting the gateway in the ~500 Mbps media path: the gateway authorizes the caller and mints
 * a short-lived HMAC-SHA256 join-token (byte-identical codec in ./moq-join-token); the client dials the media
 * WS DIRECT to us carrying `?join=<token>`; we VERIFY it here and derive org+scope from the SIGNED claims,
 * ignoring any client header.
 *
 * MIGRATION-SAFE (default-OFF): MOQ_JOIN_ENFORCE gates the behavior. `off` = the live relay is byte-identical
 * to today (legacy scopeGate/orgGate on gateway-injected headers). `shadow` = verify + log the verdict but do
 * NOT reject (observe real traffic first). `enforce` = require a valid token bound to this ns/track + scope,
 * fail-closed, and replace the client principal headers with the verified claims. This supersedes the #45
 * namespace-prefix org gate on the enforce path: the token already proves the gateway authorized THIS org for
 * THIS ns/track at mint time (verifyJoinToken re-checks ns/track — IDOR closed), so no prefix heuristic is
 * needed.
 */

import { verifyJoinToken } from './moq-join-token';
import { WAVE_ORG_HEADER, WAVE_SCOPES_HEADER, WAVE_DECLARED_PROTOCOL_HEADER } from './wave-auth';

export type JoinMode = 'off' | 'shadow' | 'enforce';

/** Env knobs this module reads (subset of the worker Env). */
export interface JoinEnv {
  MOQ_JOIN_ENFORCE?: string;
  WAVE_MOQ_JOIN_SECRET?: string;
}

/** Resolve the migration mode. enforce: "enforce"|"1"|"true"|"on"; shadow: "shadow"; else off (default). */
export function joinMode(env: JoinEnv): JoinMode {
  const v = (env.MOQ_JOIN_ENFORCE ?? '').trim().toLowerCase();
  if (v === 'enforce' || v === '1' || v === 'true' || v === 'on') return 'enforce';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

/**
 * Pull the join-token. Browser WebSocket clients can't set request headers, so `?join=<token>` is the primary
 * carrier; `x-wave-moq-join` is the server-to-server alternative (e.g. the on-device strand). A dedicated
 * param/header (NOT ?access_token / Authorization) keeps the MOQJ token unambiguous vs the legacy
 * wave-token-v1 format gate. Returns the raw token or null.
 */
export function extractJoinToken(request: Request): string | null {
  try {
    const q = new URL(request.url).searchParams.get('join');
    if (q) return q;
  } catch {
    /* malformed URL — fall through to the header carrier */
  }
  const h = request.headers.get('x-wave-moq-join');
  return h && h.length > 0 ? h : null;
}

export type JoinVerdict =
  | { ok: true; org: string; scope: string; protocol?: string }
  | { ok: false; code: string; status: number };

/**
 * Verify a join-token against the ADDRESSED ns/track + requiredScope. FAIL-CLOSED: an unset secret is 503
 * (never admit an unverifiable token), a missing token is 401, an insufficient scope is 403, and every other
 * failure (bad signature, expiry, ns/track mismatch, malformed) is 401. Org/scope on success come ONLY from
 * the signed claims.
 */
export async function verifyJoin(
  env: JoinEnv,
  request: Request,
  ns: string,
  track: string,
  requiredScope: string,
): Promise<JoinVerdict> {
  const secret = env.WAVE_MOQ_JOIN_SECRET ?? '';
  if (!secret) return { ok: false, code: 'MOQJ_SECRET_UNCONFIGURED', status: 503 };
  const token = extractJoinToken(request);
  if (!token) return { ok: false, code: 'MOQJ_MISSING', status: 401 };
  const r = await verifyJoinToken(secret, token, { ns, track, requiredScope });
  if (r.ok) return { ok: true, org: r.org, scope: r.scope, protocol: r.protocol };
  const status = r.code === 'MOQJ_SCOPE_INSUFFICIENT' ? 403 : r.code === 'MOQJ_SECRET_UNCONFIGURED' ? 503 : 401;
  return { ok: false, code: r.code, status };
}

/** Problem+json rejection with an RFC 6750 challenge. NEVER echoes the token — only the failure code. */
export function joinDenied(code: string, status: number, ns: string, track: string): Response {
  const title = status === 403 ? 'Forbidden' : status === 503 ? 'Service Unavailable' : 'Unauthorized';
  const errAttr = status === 403 ? 'insufficient_scope' : 'invalid_token';
  return new Response(
    JSON.stringify({
      type: `https://httpstatuses.io/${status}`,
      title,
      status,
      detail: `join-token rejected: ${code}`,
      code,
      namespace: ns,
      track,
    }),
    {
      status,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer realm="moq.wave.online", error="${errAttr}", scheme="moq-join"`,
      },
    }
  );
}

/**
 * Replace any client-supplied gateway-trust headers with the VERIFIED principal from the signed token, so the
 * DO's metering (#284, x-wave-org) and any downstream consumer trust ONLY the cryptographically-derived
 * org/scope — never a spoofable client header. Returns a NEW Request (headers rewritten; method/body and the
 * WebSocket-upgrade semantics are preserved, matching how the gateway forward() rewrites headers on WS
 * upgrades).
 */
export function withVerifiedPrincipal(request: Request, org: string, scope: string, protocol?: string): Request {
  const headers = new Headers(request.headers);
  headers.delete(WAVE_ORG_HEADER);
  headers.delete(WAVE_SCOPES_HEADER);
  headers.set(WAVE_ORG_HEADER, org);
  headers.set(WAVE_SCOPES_HEADER, scope);
  // task#14: only the VERIFIED join-token claim ever sets this — always delete any client-supplied value
  // first (never trust a spoofed header), then set it ONLY when the publisher explicitly declared a
  // protocol at mint time. Absent → the DO's usage-emit defaults the session to 'moq' (unchanged).
  headers.delete(WAVE_DECLARED_PROTOCOL_HEADER);
  if (protocol) headers.set(WAVE_DECLARED_PROTOCOL_HEADER, protocol);
  return new Request(request, { headers });
}
