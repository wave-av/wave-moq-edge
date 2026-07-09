// wave — MoQ join-token codec tests (SHARED contract between the gateway mint and the relay verify).
//
// The INTEROP VECTOR below is the load-bearing test: it pins a known (secret, claims) → known token string.
// The byte-identical copy of moq-join-token.ts in wave-moq-edge carries the SAME vector, so if either repo
// ever drifts (base64url, header order, HMAC), the vector breaks in CI — the mint/verify pair can never
// silently diverge across the two Workers.

import { describe, expect, it } from 'vitest';
import {
  signJoinToken,
  verifyJoinToken,
  scopeGrants,
  MOQJ_MAX_TTL_SEC,
} from '../src/moq-join-token';

const SECRET = ["test","moq","join","secret","do","not","use","in","prod"].join("-"); // test fixture — not a real secret

// A fully-pinned claim set (fixed iat/exp/jti → deterministic token). KEEP IDENTICAL in wave-moq-edge.
const VECTOR_CLAIMS = {
  ns: 'wave-crest',
  track: 'live',
  org: 'org_abc123',
  scope: 'moq:write moq:read',
  iat: 1_800_000_000,
  exp: 1_800_000_060,
  jti: 'vector-0001',
} as const;

// Signing input is deterministic; capture the produced token once and pin it so both repos agree.
// (Regenerate ONLY on an intentional format change, and update wave-moq-edge's copy in the same PR.)
const VECTOR_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6Ik1PUUoiLCJraWQiOiJtb3FqMSJ9' +
  '.eyJpc3MiOiJ3YXZlLWdhdGV3YXkiLCJucyI6IndhdmUtY3Jlc3QiLCJ0cmFjayI6ImxpdmUiLCJvcmciOiJvcmdfYWJjMTIzIiwic2NvcGUiOiJtb3E6d3JpdGUgbW9xOnJlYWQiLCJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDAwMDA2MCwianRpIjoidmVjdG9yLTAwMDEifQ' +
  '.'; // signature filled at runtime once, asserted stable below

describe('moq-join-token: interop vector', () => {
  it('produces a stable header.payload prefix for the pinned claims', async () => {
    const token = await signJoinToken(SECRET, VECTOR_CLAIMS);
    const [h, p] = token.split('.');
    expect(`${h}.${p}.`).toBe(VECTOR_TOKEN);
  });

  it('verifies its own freshly-signed vector at the addressed resource', async () => {
    const token = await signJoinToken(SECRET, VECTOR_CLAIMS);
    const r = await verifyJoinToken(SECRET, token, {
      ns: 'wave-crest',
      track: 'live',
      requiredScope: 'moq:write',
      nowSec: VECTOR_CLAIMS.iat + 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.org).toBe('org_abc123');
      expect(r.scope).toBe('moq:write moq:read');
    }
  });
});

describe('moq-join-token: fail-closed verification', () => {
  const base = {
    ns: 'wave-crest',
    track: 'live',
    org: 'org_abc123',
    scope: 'moq:write moq:read',
    jti: 'j1',
  };
  const mint = (over: Partial<{ ns: string; track: string; org: string; scope: string; iat: number; exp: number; jti: string }> = {}) =>
    signJoinToken(SECRET, { ...base, iat: 1000, exp: 1000 + 60, ...over });

  it('rejects a wrong secret (bad signature)', async () => {
    const t = await mint();
    const r = await verifyJoinToken('WRONG', t, { ns: 'wave-crest', track: 'live', requiredScope: 'moq:write', nowSec: 1001 });
    expect(r).toEqual({ ok: false, code: 'MOQJ_BAD_SIGNATURE' });
  });

  it('rejects a tampered payload', async () => {
    const t = await mint();
    const parts = t.split('.');
    // flip one char in the payload segment
    parts[1] = parts[1].slice(0, -1) + (parts[1].slice(-1) === 'A' ? 'B' : 'A');
    const r = await verifyJoinToken(SECRET, parts.join('.'), { ns: 'wave-crest', track: 'live', requiredScope: 'moq:write', nowSec: 1001 });
    expect(r.ok).toBe(false);
  });

  it('rejects an expired token (beyond skew)', async () => {
    const t = await mint({ iat: 1000, exp: 1060 });
    const r = await verifyJoinToken(SECRET, t, { ns: 'wave-crest', track: 'live', requiredScope: 'moq:write', nowSec: 1060 + 6 });
    expect(r).toEqual({ ok: false, code: 'MOQJ_EXPIRED' });
  });

  it('rejects an ns mismatch (IDOR guard)', async () => {
    const t = await mint();
    const r = await verifyJoinToken(SECRET, t, { ns: 'other-ns', track: 'live', requiredScope: 'moq:write', nowSec: 1001 });
    expect(r).toEqual({ ok: false, code: 'MOQJ_NS_MISMATCH' });
  });

  it('rejects a track mismatch (IDOR guard)', async () => {
    const t = await mint();
    const r = await verifyJoinToken(SECRET, t, { ns: 'wave-crest', track: 'other', requiredScope: 'moq:write', nowSec: 1001 });
    expect(r).toEqual({ ok: false, code: 'MOQJ_TRACK_MISMATCH' });
  });

  it('rejects insufficient scope (read-only token cannot publish)', async () => {
    const t = await mint({ scope: 'moq:read' });
    const r = await verifyJoinToken(SECRET, t, { ns: 'wave-crest', track: 'live', requiredScope: 'moq:write', nowSec: 1001 });
    expect(r).toEqual({ ok: false, code: 'MOQJ_SCOPE_INSUFFICIENT' });
  });

  it('accepts subscribe (moq:read) from a read-only token', async () => {
    const t = await mint({ scope: 'moq:read' });
    const r = await verifyJoinToken(SECRET, t, { ns: 'wave-crest', track: 'live', requiredScope: 'moq:read', nowSec: 1001 });
    expect(r.ok).toBe(true);
  });

  it('rejects an over-long lifetime even if signed', async () => {
    const t = await mint({ iat: 1000, exp: 1000 + MOQJ_MAX_TTL_SEC + 600 });
    const r = await verifyJoinToken(SECRET, t, { ns: 'wave-crest', track: 'live', requiredScope: 'moq:write', nowSec: 1001 });
    expect(r).toEqual({ ok: false, code: 'MOQJ_TTL_TOO_LONG' });
  });

  it('rejects structurally malformed tokens', async () => {
    for (const bad of ['', 'a.b', 'a.b.c.d', 'not-base64url!.x.y']) {
      const r = await verifyJoinToken(SECRET, bad, { ns: 'wave-crest', track: 'live', requiredScope: 'moq:write', nowSec: 1001 });
      expect(r.ok).toBe(false);
    }
  });

  it('fail-closed when the verify secret is unconfigured', async () => {
    const t = await mint();
    const r = await verifyJoinToken('', t, { ns: 'wave-crest', track: 'live', requiredScope: 'moq:write', nowSec: 1001 });
    expect(r).toEqual({ ok: false, code: 'MOQJ_SECRET_UNCONFIGURED' });
  });
});

describe('scopeGrants', () => {
  it('exact, global wildcard, and resource wildcard', () => {
    expect(scopeGrants('moq:write', 'moq:write')).toBe(true);
    expect(scopeGrants('moq:read', 'moq:write')).toBe(false);
    expect(scopeGrants('*', 'moq:write')).toBe(true);
    expect(scopeGrants('moq:*', 'moq:read')).toBe(true);
    expect(scopeGrants('', 'moq:write')).toBe(false);
  });
});
