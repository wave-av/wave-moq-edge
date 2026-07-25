/**
 * #112 join-token-authed DISCOVERY (/v1/announce + /v1/catalog).
 *
 * THE GAP THIS CLOSES: publish/subscribe authenticate with a gateway-minted join-token
 * (src/moq-join-token.ts — HMAC-SHA256, signed ns/track/org/scope claims), but discovery
 * authenticates via a DIFFERENT carrier — the gateway-injected `x-wave-org` header consumed by
 * filterTracksForOrg (src/wave-auth.ts). moq.wave.online routes DIRECT to this relay, so a caller
 * holding a perfectly valid join-token has no org identity on the discovery path: it resolves
 * anonymous and (with MOQ_REQUIRE_AUTH on) lists nothing. The two auth models do not compose.
 * This module makes the join-token a first-class discovery credential — ADDITIVE: the
 * `wave-token-v1` / `x-wave-org` carrier behaves exactly as today.
 *
 * ── SCOPING DECISION (deliberate, narrow) ──────────────────────────────────────────────────────
 * A join-token is minted BOUND TO ONE `ns` + `track`. We scope a token-authed listing to the
 * token's signed `ns` claim — NOT to its `org` claim. Rationale:
 *   • The org claim would turn a single-track credential into an org-wide directory key. That is a
 *     scope WIDENING (one track → every namespace the org owns), and a token is 120s-ephemeral and
 *     handed to browser clients, so it is exactly the credential we least want to widen.
 *   • The `ns` claim is what the gateway actually authorized this token to touch, so listing that
 *     namespace grants nothing the holder could not already reach by subscribing.
 *   • It still delivers the use case: the tracks of one live broadcast share a namespace, so a
 *     publisher/viewer can enumerate the sibling tracks of the stream it is already authorized for.
 * Org-wide listing is intentionally NOT granted here. If it is ever wanted it must be a separate,
 * explicitly-minted claim (e.g. a `list` scope or an `ns:*` grant) — never an inferred widening.
 *
 * ── FAIL-CLOSED ────────────────────────────────────────────────────────────────────────────────
 * Any verification failure (bad signature, expired, malformed, wrong issuer, over-long TTL,
 * insufficient scope, unset secret) lists NOTHING. There is no error path that falls back to the
 * unfiltered list. No token value is ever logged or echoed — only the typed failure code.
 *
 * ── DEFAULT-INERT ──────────────────────────────────────────────────────────────────────────────
 * Gated by MOQ_DISCOVERY_JOIN (off unless "1"/"true"/"on"/"enforce"), the repo's default-OFF flag
 * convention (MOQ_REQUIRE_AUTH, MOQ_JOIN_ENFORCE). Flag off → this module is a pure no-op and
 * discovery is byte-identical to today. Flag on + NO join-token → also byte-identical to today
 * (the legacy org-header path decides). Only a request that ACTUALLY CARRIES a join-token takes
 * the new path.
 */

import { verifyJoinToken } from './moq-join-token';
import { extractJoinToken, type JoinEnv } from './moq-join-verify';
import { MOQ_SCOPE_READ } from './wave-auth';

/** Env knobs this module reads (subset of the worker Env). */
export interface DiscoveryEnv extends JoinEnv {
  MOQ_DISCOVERY_JOIN?: string;
}

/** Is join-token discovery auth enabled? Truthy: "1"|"true"|"on"|"enforce". Default: off. */
export function discoveryJoinEnabled(env: DiscoveryEnv): boolean {
  const v = (env.MOQ_DISCOVERY_JOIN ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'enforce';
}

/**
 * The bound resource a token CLAIMS, read from the payload segment WITHOUT trusting it.
 *
 * WHY THIS IS SAFE: verifyJoinToken binds ns/track to the resource being addressed (IDOR closure on
 * publish/subscribe), but discovery addresses NO single resource — so we read the claimed ns/track
 * here and feed them straight back into verifyJoinToken as the "addressed" resource. The HMAC is
 * computed over the ENTIRE payload segment, so a caller who edits ns/track invalidates the
 * signature: the equality check becomes a tautology, but every other check — signature, issuer,
 * iat/exp with the existing skew, the TTL ceiling, org presence, scope — still applies with full
 * force, and the values we ultimately USE come from the VERIFIED result, never from this peek.
 * Returns null on any structural problem (→ caller fail-closes).
 */
export function peekClaimedResource(token: string): { ns: string; track: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const seg = parts[1];
  if (!/^[A-Za-z0-9_-]*$/.test(seg)) return null;
  const pad = seg.length % 4 === 0 ? '' : '='.repeat(4 - (seg.length % 4));
  let json: string;
  try {
    const bin = atob(seg.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    json = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  let claims: { ns?: unknown; track?: unknown };
  try {
    claims = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof claims.ns !== 'string' || claims.ns.length === 0) return null;
  if (typeof claims.track !== 'string' || claims.track.length === 0) return null;
  return { ns: claims.ns, track: claims.track };
}

export type DiscoveryVerdict =
  | { ok: true; ns: string; org: string }
  | { ok: false; code: string };

/**
 * Verify a join-token presented on a discovery request. Requires `moq:read` — listing is a READ.
 * FAIL-CLOSED: an unset secret, an absent token, or ANY verification failure returns {ok:false}.
 * `nowSec` is injectable for deterministic tests (it flows into the existing expiry/skew rules,
 * which are NOT relaxed here).
 */
export async function verifyDiscoveryJoin(
  env: DiscoveryEnv,
  request: Request,
  nowSec?: number,
): Promise<DiscoveryVerdict> {
  const secret = env.WAVE_MOQ_JOIN_SECRET ?? '';
  if (!secret) return { ok: false, code: 'MOQJ_SECRET_UNCONFIGURED' };
  const token = extractJoinToken(request);
  if (!token) return { ok: false, code: 'MOQJ_MISSING' };
  const claimed = peekClaimedResource(token);
  if (!claimed) return { ok: false, code: 'MOQJ_MALFORMED' };
  const r = await verifyJoinToken(secret, token, {
    ns: claimed.ns,
    track: claimed.track,
    requiredScope: MOQ_SCOPE_READ,
    nowSec,
  });
  if (!r.ok) return { ok: false, code: r.code };
  return { ok: true, ns: r.claims.ns, org: r.org };
}

/**
 * Does this discovery request take the join-token path at all? True only when the flag is on AND a
 * token is actually present. False → the caller runs the legacy org-header path unchanged.
 */
export function usesDiscoveryJoin(env: DiscoveryEnv, request: Request): boolean {
  return discoveryJoinEnabled(env) && extractJoinToken(request) !== null;
}

/**
 * Filter registry entries to the VERIFIED token's namespace. Pure given the verdict.
 *   ok:false → [] (fail-closed)
 *   ok:true  → only entries whose namespace EXACTLY equals the signed `ns` claim (see the scoping
 *              decision above: exact, not prefix — a prefix match would leak sibling namespaces).
 */
export function filterTracksForJoin<T>(
  entries: T[],
  verdict: DiscoveryVerdict,
  namespaceOf: (e: T) => string,
): T[] {
  if (!verdict.ok) return [];
  return entries.filter((e) => namespaceOf(e) === verdict.ns);
}
