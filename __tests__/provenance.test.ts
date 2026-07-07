import { describe, it, expect } from 'vitest';
import {
  verifyProvenanceToken,
  buildProvenanceAttestation,
  sha256Hex,
  WAVE_PROV_PREFIX,
  PROVENANCE_STANDARDS,
  type ProvenanceClaim,
} from '../src/provenance';

const SECRET = 'test-provenance-secret-0123456789';
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a valid wave-prov-v1 token the SAME way a signer would (HMAC over the base64url payload text). */
async function mintToken(claim: ProvenanceClaim, secret: string): Promise<string> {
  const payloadB64 = b64url(enc.encode(JSON.stringify(claim)));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64)));
  return `${WAVE_PROV_PREFIX}${payloadB64}.${b64url(sig)}`;
}

const now = 1_800_000_000;
const goodClaim: ProvenanceClaim = { producer: 'orgA', namespace: 'orgA-live', track: 'cam1', iat: now - 10, exp: now + 3600 };

describe('provenance (#144) — HMAC verify FAIL-CLOSED + C2PA-shaped stamp', () => {
  it('verifies a well-formed token (HMAC roundtrip)', async () => {
    const token = await mintToken(goodClaim, SECRET);
    const r = await verifyProvenanceToken(token, SECRET, now);
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.claim.producer).toBe('orgA');
  });

  it('FAIL-CLOSED: wrong secret → invalid (never throws)', async () => {
    const token = await mintToken(goodClaim, SECRET);
    const r = await verifyProvenanceToken(token, 'WRONG-secret-key', now);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('bad_signature');
  });

  it('FAIL-CLOSED: missing secret, missing token, bad prefix, tampered payload, expired', async () => {
    expect((await verifyProvenanceToken(await mintToken(goodClaim, SECRET), undefined, now)).valid).toBe(false);
    expect((await verifyProvenanceToken(null, SECRET, now)).valid).toBe(false);
    expect((await verifyProvenanceToken('not-a-prov-token', SECRET, now)).valid).toBe(false);
    expect((await verifyProvenanceToken(`${WAVE_PROV_PREFIX}onlyonepart`, SECRET, now)).valid).toBe(false);
    // tampered payload → signature no longer matches
    const t = await mintToken(goodClaim, SECRET);
    const tampered = t.replace(WAVE_PROV_PREFIX, `${WAVE_PROV_PREFIX}A`);
    expect((await verifyProvenanceToken(tampered, SECRET, now)).valid).toBe(false);
    // expired
    const expiredTok = await mintToken({ ...goodClaim, exp: now - 1 }, SECRET);
    const er = await verifyProvenanceToken(expiredTok, SECRET, now);
    expect(er.valid).toBe(false);
    if (!er.valid) expect(er.reason).toBe('expired');
  });

  it('builds a C2PA-v2.3-shaped attestation binding the MOQT track to a content digest', async () => {
    const sample = enc.encode('keyframe-bytes');
    const att = await buildProvenanceAttestation(goodClaim, sample);
    expect(att['@type']).toBe('c2pa.assertion.moqt-binding');
    expect(att.version).toBe(PROVENANCE_STANDARDS.c2pa);
    expect(att.moqt).toEqual({ namespace: 'orgA-live', track: 'cam1', catalogSpec: PROVENANCE_STANDARDS.moqCatalog });
    expect(att.producer.catSpec).toBe(PROVENANCE_STANDARDS.commonAccessToken);
    expect(att.contentBinding.hashHex).toBe(await sha256Hex(sample));
    expect(att._maturity).toBe('shape-not-cose-signed'); // HONEST: not a COSE-signed manifest yet
  });

  it('MEASURE (honest): verify+stamp latency — pure crypto.subtle, NOT a real MoQ relay hop', async () => {
    const token = await mintToken(goodClaim, SECRET);
    const sample = enc.encode('x'.repeat(1024));
    const N = 200;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const r = await verifyProvenanceToken(token, SECRET, now);
      if (r.valid) await buildProvenanceAttestation(r.claim, sample);
    }
    const perOp = (performance.now() - t0) / N;
    // eslint-disable-next-line no-console
    console.log(`[#144 MEASURE] verify+stamp mean over ${N} iters = ${perOp.toFixed(3)} ms/op (host clock)`);
    expect(perOp).toBeGreaterThan(0);
  });
});
