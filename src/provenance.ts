/**
 * MOQT ↔ C2PA provenance binding — the WAVE differentiation (#144).
 *
 * WHAT THIS IS (and the honest boundary):
 *   A PURE, Workers-native bearer-token PROVENANCE hook for the MoQ relay. It does two things, both
 *   with `crypto.subtle` only (NO new dependency — same primitive @wave-av/content-hash's StreamingHasher
 *   already uses on the Worker runtime):
 *
 *     1. verifyProvenanceToken() — FAIL-CLOSED HMAC-SHA256 verification of a signed provenance token
 *        `wave-prov-v1.<base64url(payload)>.<base64url(sig)>` where sig = HMAC(secret, "<payload>").
 *        The verify uses `crypto.subtle.verify` (constant-time in the platform primitive), so we never
 *        hand-roll a byte compare of the MAC. Any malformed / expired / bad-signature token resolves to
 *        `{ valid: false, … }` — it NEVER throws into the publish hot path.
 *
 *     2. buildProvenanceAttestation() — on a VALID token, produce a C2PA-v2.3-SHAPED assertion object
 *        that BINDS the live MOQT track (namespace/track) to the token's claimed producer + a SHA-256
 *        content digest, referencing the two live standards this differentiation rides on:
 *          • draft-ietf-moq-c4m  (Common Catalog / provenance carriage for Media-over-QUIC)
 *          • CTA-5007-B CAT      (Common Access Token — the entitlement/attestation envelope)
 *          • C2PA v2.3           (the manifest/assertion model whose SHAPE we mirror here)
 *
 * WHAT THIS IS **NOT** (scope boundary — do not overclaim):
 *   - This is NOT a real C2PA manifest SIGNER. A production binding must produce a COSE-signed C2PA
 *     manifest with an X.509 provenance credential and embed/side-car it per C2PA v2.3 §. Here we emit
 *     a design-accurate JSON assertion SHAPE so the relay control-plane and tests can exercise the
 *     binding end-to-end; the cryptographic manifest signer is the next-step productization (see
 *     docs/144-microvm-relay-spike.md → "Prove it for real").
 *   - The HMAC token is a lightweight PROVENANCE-SESSION token (a producer proves it holds the shared
 *     provenance secret for this org). It is NOT the wave-token-v1 ENTITLEMENT bearer (that is the
 *     gateway-federated auth in src/wave-auth.ts); the two compose — auth gates ACCESS, provenance
 *     BINDS ORIGIN.
 *
 * PURE: no fetch, no shell, no I/O beyond crypto.subtle. Token bytes are treated as fully untrusted and
 * are never interpolated into any sink (only compared, decoded, and echoed inside a JSON structure).
 */

/** Prefix of a well-formed provenance token. */
export const WAVE_PROV_PREFIX = 'wave-prov-v1.';

/** Standards this binding rides on — surfaced in the attestation so consumers can resolve them. */
export const PROVENANCE_STANDARDS = {
  moqCatalog: 'draft-ietf-moq-c4m',
  commonAccessToken: 'CTA-5007-B',
  c2pa: 'c2pa-v2.3',
} as const;

/** The decoded, verified provenance claim. Shape mirrors a minimal CTA-5007-B / JWT-style payload. */
export interface ProvenanceClaim {
  /** Producer identity (opaque org/producer id the gateway vouches for). */
  producer: string;
  /** Namespace the producer is asserting provenance over. */
  namespace: string;
  /** Track the producer is asserting provenance over. */
  track: string;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). Absent → no expiry (still allowed, but a real deployment SHOULD set it). */
  exp?: number;
}

/** Result of verifyProvenanceToken — FAIL-CLOSED: `valid:false` carries a machine-readable reason. */
export type ProvenanceVerifyResult =
  | { valid: true; claim: ProvenanceClaim }
  | { valid: false; reason: string };

/** base64url decode → Uint8Array. Returns null on any malformed input (fail-closed, never throws out). */
function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const enc = new TextEncoder();

/**
 * Verify a `wave-prov-v1.<payload>.<sig>` token against the org's shared provenance secret using
 * HMAC-SHA256. FAIL-CLOSED at every branch. `now` is injectable for deterministic tests.
 *
 * SECURITY:
 *   - MAC comparison is delegated to `crypto.subtle.verify` (constant-time platform primitive) — we do
 *     NOT compare MAC bytes by hand.
 *   - A missing/empty secret → `{valid:false}` (never verifies with an empty key).
 *   - Expiry is enforced when present.
 *   - Any decode/parse error → `{valid:false}`; the caller path never sees a throw.
 */
export async function verifyProvenanceToken(
  token: string | null | undefined,
  secret: string | undefined,
  now: number = Math.floor(Date.now() / 1000)
): Promise<ProvenanceVerifyResult> {
  if (!secret || secret.length === 0) return { valid: false, reason: 'no_provenance_secret' };
  if (!token || !token.startsWith(WAVE_PROV_PREFIX)) return { valid: false, reason: 'malformed_prefix' };

  const rest = token.slice(WAVE_PROV_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return { valid: false, reason: 'malformed_structure' };
  const payloadB64 = rest.slice(0, dot);
  const sigB64 = rest.slice(dot + 1);

  const sig = b64urlDecode(sigB64);
  if (!sig) return { valid: false, reason: 'malformed_signature' };

  // The MAC is computed over the exact payload segment as transmitted (base64url text) — canonical,
  // so we never have to re-serialize (which could disagree byte-for-byte with the signer).
  const signingInput = enc.encode(payloadB64);

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    ok = await crypto.subtle.verify('HMAC', key, sig, signingInput);
  } catch {
    return { valid: false, reason: 'verify_error' };
  }
  if (!ok) return { valid: false, reason: 'bad_signature' };

  // Signature is valid → now (and only now) trust the payload enough to decode it.
  const payloadBytes = b64urlDecode(payloadB64);
  if (!payloadBytes) return { valid: false, reason: 'malformed_payload' };
  let claim: ProvenanceClaim;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (
      !parsed ||
      typeof parsed.producer !== 'string' ||
      typeof parsed.namespace !== 'string' ||
      typeof parsed.track !== 'string' ||
      typeof parsed.iat !== 'number'
    ) {
      return { valid: false, reason: 'incomplete_claim' };
    }
    claim = parsed as ProvenanceClaim;
  } catch {
    return { valid: false, reason: 'unparseable_payload' };
  }

  if (typeof claim.exp === 'number' && claim.exp <= now) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, claim };
}

/** A C2PA-v2.3-SHAPED provenance attestation binding a MOQT track to a verified producer claim. */
export interface ProvenanceAttestation {
  /** Fixed marker so consumers can detect the SHAPE + version. */
  '@type': 'c2pa.assertion.moqt-binding';
  version: typeof PROVENANCE_STANDARDS.c2pa;
  /** The MOQT track this attestation is bound to. */
  moqt: { namespace: string; track: string; catalogSpec: typeof PROVENANCE_STANDARDS.moqCatalog };
  /** The verified producer + entitlement-envelope reference. */
  producer: { id: string; catSpec: typeof PROVENANCE_STANDARDS.commonAccessToken };
  /** SHA-256 hex digest of the bound content sample (hashType is explicit per C2PA hard-binding norms). */
  contentBinding: { hashType: 'sha256'; hashHex: string };
  /** When the attestation was stamped (ISO-8601). */
  stampedAt: string;
  /** HONEST maturity marker — this is a SHAPE, not a COSE-signed C2PA manifest yet. */
  _maturity: 'shape-not-cose-signed';
}

/** SHA-256 hex of a byte sample (the track's first/keyframe object, or any content-binding sample). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build the C2PA-shaped attestation for a VERIFIED claim, binding it to a content sample. The caller
 * MUST have obtained `claim` from a `verifyProvenanceToken` that returned `valid:true` — this function
 * does no verification of its own (single responsibility; the verify gate is upstream).
 */
export async function buildProvenanceAttestation(
  claim: ProvenanceClaim,
  contentSample: Uint8Array,
  stampedAt: string = new Date().toISOString()
): Promise<ProvenanceAttestation> {
  const hashHex = await sha256Hex(contentSample);
  return {
    '@type': 'c2pa.assertion.moqt-binding',
    version: PROVENANCE_STANDARDS.c2pa,
    moqt: { namespace: claim.namespace, track: claim.track, catalogSpec: PROVENANCE_STANDARDS.moqCatalog },
    producer: { id: claim.producer, catSpec: PROVENANCE_STANDARDS.commonAccessToken },
    contentBinding: { hashType: 'sha256', hashHex },
    stampedAt,
    _maturity: 'shape-not-cose-signed',
  };
}
