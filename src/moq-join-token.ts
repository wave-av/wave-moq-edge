// wave — MoQ join-token codec (SHARED, byte-identical across the gateway mint and the relay verify).
//
// WHY THIS EXISTS: moq.wave.online routes DIRECT to the wave-moq-edge relay (not gateway-fronted),
// so a client-supplied `x-wave-scopes` header is spoofable and no crypto validation happens. We do NOT
// want to proxy the 4K/~500 Mbps media WebSocket through the gateway Worker (it would put the gateway in
// the media data path). Instead: the gateway authorizes on the caller's durable org key (validateKey →
// hasScope → meter) and MINTS a short-lived join-token here; the media WS connects DIRECT to the relay
// carrying that token; the relay VERIFIES it here and derives org/scopes from the SIGNED claims — never
// from a client header. Least-privilege: the signing secret (WAVE_MOQ_JOIN_SECRET) is DEDICATED to the
// MoQ join, distinct from WIF_SIGNING_SECRET, so a relay compromise can forge only MoQ joins, never full
// gateway identity tokens.
//
// Token shape:  base64url(header).base64url(payload).base64url(HMAC-SHA256)
//   header  = { alg:"HS256", typ:"MOQJ", kid:"moqj1" }   // typ "MOQJ" (not "JWT") so it can NEVER be
//                                                          // confused with a WIF token or an api-key.
//   payload = { iss:MOQJ_ISS, ns, track, org, scope, iat, exp, jti }
//             scope is a SPACE-delimited grant string, e.g. "moq:write moq:read" (RFC 6749 §3.3 convention).
//
// PURE (no I/O, no deps): both a Cloudflare Worker (gateway) and a Cloudflare Worker (relay) import the
// same functions, guaranteeing the mint/verify pair agree. Verification is FAIL-CLOSED: any structural,
// signature, issuer, expiry, resource, or scope mismatch returns a typed failure — never throws to the
// caller, never silently passes.

export const MOQJ_ALG = 'HS256';
export const MOQJ_TYP = 'MOQJ';
export const MOQJ_KID = 'moqj1';
export const MOQJ_ISS = 'wave-gateway'; // # guard:allow token issuer identity baked into the pinned interop vector — cross-service protocol constant, not a private-repo reference

/** Max lifetime the gateway will mint (seconds). A join-token is ephemeral by contract — the durable
 *  credential (the org key) stays with the client; only this short-lived token travels to the relay. */
export const MOQJ_MAX_TTL_SEC = 120;
/** Small allowance for clock skew between the gateway (mint) and the relay (verify), in seconds. */
export const MOQJ_SKEW_SEC = 5;

export interface MoqJoinClaims {
  /** namespace — lowercase alphanumeric + dash, 1..64 (must equal the relay URL path param). */
  ns: string;
  /** track — lowercase alphanumeric + dash, 1..64 (must equal the relay URL path param). */
  track: string;
  /** the authorized billing/isolation org (gateway principal.organizationId). */
  org: string;
  /** space-delimited granted scopes, e.g. "moq:write moq:read". */
  scope: string;
  /** issued-at (epoch seconds). */
  iat: number;
  /** expiry (epoch seconds). */
  exp: number;
  /** unique token id (replay/audit correlation). */
  jti: string;
  iss?: string;
}

// ---- base64url (no padding) --------------------------------------------------------------------

function b64urlEncodeBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlEncodeString(s: string): string {
  return b64urlEncodeBytes(new TextEncoder().encode(s));
}

function b64urlDecodeToString(s: string): string | null {
  // Reject anything outside the base64url alphabet (defense-in-depth: a malformed token is a reject,
  // never a best-effort decode). atob() itself throws on bad input; we also guard the charset.
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// ---- HMAC-SHA256 -------------------------------------------------------------------------------

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function hmacSign(secret: string, signingInput: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput)));
  return b64urlEncodeBytes(sig);
}

/** Constant-time string compare — no early-exit on mismatch (matches the gateway's timingSafeEqual). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// ---- scope check (mirrors wave-moq-edge hasScope + gateway auth.ts hasScope) --------------------

/** Does a space-delimited grant satisfy `required`? Exact, global `*`, or resource wildcard `moq:*`. */
export function scopeGrants(scope: string, required: string): boolean {
  const set = new Set(scope.trim().split(/\s+/).filter((s) => s.length > 0));
  if (set.has(required)) return true;
  if (set.has('*')) return true;
  const colon = required.indexOf(':');
  if (colon > 0 && set.has(`${required.slice(0, colon)}:*`)) return true;
  return false;
}

// ---- MINT (gateway side) -----------------------------------------------------------------------

/**
 * Sign a MoQ join-token. Called by the gateway AFTER it has authorized the caller's org key and the
 * requested moq scope. `now` is injectable for deterministic tests; defaults to Date.now().
 */
export async function signJoinToken(
  secret: string,
  claims: Omit<MoqJoinClaims, 'iss'>,
): Promise<string> {
  const header = { alg: MOQJ_ALG, typ: MOQJ_TYP, kid: MOQJ_KID };
  const payload: MoqJoinClaims = { iss: MOQJ_ISS, ...claims };
  const signingInput = `${b64urlEncodeString(JSON.stringify(header))}.${b64urlEncodeString(JSON.stringify(payload))}`;
  const sig = await hmacSign(secret, signingInput);
  return `${signingInput}.${sig}`;
}

// ---- VERIFY (relay side) -----------------------------------------------------------------------

export type VerifyOk = { ok: true; org: string; scope: string; claims: MoqJoinClaims };
export type VerifyErr = { ok: false; code: string };
export type VerifyResult = VerifyOk | VerifyErr;

export interface VerifyOpts {
  /** namespace the request is actually addressing (URL path). Claim MUST equal this. */
  ns: string;
  /** track the request is actually addressing (URL path). Claim MUST equal this. */
  track: string;
  /** required scope: "moq:write" (publish) or "moq:read" (subscribe). */
  requiredScope: string;
  /** current epoch seconds — injectable for tests; defaults to Date.now()/1000. */
  nowSec?: number;
}

/**
 * Verify a MoQ join-token — FAIL-CLOSED. Returns {ok:true, org, scope} only when EVERY check passes:
 * structure, header (alg/typ/kid), HMAC signature (constant-time), issuer, iat/exp window (with small
 * skew), ns/track equal the addressed resource, and the granted scope covers `requiredScope`. Any failure
 * returns a typed {ok:false, code} — never throws, never partially trusts. The org and scopes returned are
 * taken from the SIGNED payload, so the relay never trusts a client-supplied x-wave-org/x-wave-scopes.
 */
export async function verifyJoinToken(secret: string, token: string, opts: VerifyOpts): Promise<VerifyResult> {
  if (!secret) return { ok: false, code: 'MOQJ_SECRET_UNCONFIGURED' };
  if (typeof token !== 'string' || token.length === 0) return { ok: false, code: 'MOQJ_MISSING' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, code: 'MOQJ_MALFORMED' };

  // Header
  const headerJson = b64urlDecodeToString(parts[0]);
  if (!headerJson) return { ok: false, code: 'MOQJ_MALFORMED' };
  let header: { alg?: string; typ?: string; kid?: string };
  try {
    header = JSON.parse(headerJson);
  } catch {
    return { ok: false, code: 'MOQJ_MALFORMED' };
  }
  if (header.alg !== MOQJ_ALG || header.typ !== MOQJ_TYP || header.kid !== MOQJ_KID) {
    return { ok: false, code: 'MOQJ_BAD_HEADER' };
  }

  // Signature (constant-time). Recompute over the exact received signing input.
  const expectedSig = await hmacSign(secret, `${parts[0]}.${parts[1]}`);
  if (!timingSafeEqual(expectedSig, parts[2])) return { ok: false, code: 'MOQJ_BAD_SIGNATURE' };

  // Payload
  const payloadJson = b64urlDecodeToString(parts[1]);
  if (!payloadJson) return { ok: false, code: 'MOQJ_MALFORMED' };
  let claims: MoqJoinClaims;
  try {
    claims = JSON.parse(payloadJson);
  } catch {
    return { ok: false, code: 'MOQJ_MALFORMED' };
  }

  if (claims.iss !== MOQJ_ISS) return { ok: false, code: 'MOQJ_BAD_ISSUER' };
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return { ok: false, code: 'MOQJ_MALFORMED' };
  // jti is a REQUIRED contract claim (replay/audit correlation) — a token missing it is malformed, not trusted.
  if (typeof claims.jti !== 'string' || claims.jti.length === 0) return { ok: false, code: 'MOQJ_MALFORMED' };
  // Defense-in-depth: a non-positive TTL (exp<=iat) is structurally invalid even if both stamps sit inside the
  // skew window — reject outright so a mint bug (swapped/corrupted iat/exp) can never yield an accepted token.
  if (claims.exp <= claims.iat) return { ok: false, code: 'MOQJ_MALFORMED' };

  const now = typeof opts.nowSec === 'number' ? opts.nowSec : Math.floor(Date.now() / 1000);
  if (claims.exp + MOQJ_SKEW_SEC < now) return { ok: false, code: 'MOQJ_EXPIRED' };
  if (claims.iat - MOQJ_SKEW_SEC > now) return { ok: false, code: 'MOQJ_NOT_YET_VALID' };
  // Reject an over-long lifetime even if signed (a mint bug or a rotated-out secret must not grant a
  // long-lived bearer): exp-iat must be within the contract ceiling.
  if (claims.exp - claims.iat > MOQJ_MAX_TTL_SEC + MOQJ_SKEW_SEC) return { ok: false, code: 'MOQJ_TTL_TOO_LONG' };

  if (typeof claims.ns !== 'string' || claims.ns !== opts.ns) return { ok: false, code: 'MOQJ_NS_MISMATCH' };
  if (typeof claims.track !== 'string' || claims.track !== opts.track) return { ok: false, code: 'MOQJ_TRACK_MISMATCH' };
  if (typeof claims.org !== 'string' || claims.org.length === 0) return { ok: false, code: 'MOQJ_NO_ORG' };
  if (typeof claims.scope !== 'string' || !scopeGrants(claims.scope, opts.requiredScope)) {
    return { ok: false, code: 'MOQJ_SCOPE_INSUFFICIENT' };
  }

  return { ok: true, org: claims.org, scope: claims.scope, claims };
}
