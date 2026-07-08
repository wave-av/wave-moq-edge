// #58 relay-side join-token verification tests. Proves the relay verify layer accepts a gateway-minted token
// at the addressed resource, derives org/scope from the SIGNED claims, strips spoofable client headers, and
// fail-closes on every rejection. Mints via signJoinToken (the byte-identical shared codec).

import { describe, expect, it } from 'vitest';
import { signJoinToken } from '../src/moq-join-token';
import { joinMode, extractJoinToken, verifyJoin, withVerifiedPrincipal, type JoinEnv } from '../src/moq-join-verify';

const SECRET = 'test-moq-join-secret-do-not-use-in-prod';
const enforce: JoinEnv = { WAVE_MOQ_JOIN_SECRET: SECRET, MOQ_JOIN_ENFORCE: 'enforce' };

const nowReq = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
// verifyJoin uses Date.now() for the exp/iat window, so mint tokens with a NOW-relative validity.
const mintFresh = (over: Partial<{ ns: string; track: string; org: string; scope: string; jti: string }> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return signJoinToken(SECRET, {
    ns: 'wave-crest', track: 'live', org: 'org_abc123', scope: 'moq:write', jti: 'j', iat: now, exp: now + 60, ...over,
  });
};

describe('joinMode', () => {
  it('parses off (default) / shadow / enforce', () => {
    expect(joinMode({})).toBe('off');
    expect(joinMode({ MOQ_JOIN_ENFORCE: '' })).toBe('off');
    expect(joinMode({ MOQ_JOIN_ENFORCE: 'shadow' })).toBe('shadow');
    for (const v of ['enforce', '1', 'true', 'ON']) expect(joinMode({ MOQ_JOIN_ENFORCE: v })).toBe('enforce');
  });
});

describe('extractJoinToken', () => {
  it('reads ?join= (browser WS) and the x-wave-moq-join header (server), else null', () => {
    expect(extractJoinToken(nowReq('https://moq.wave.online/v1/publish/ns/track?join=TKN'))).toBe('TKN');
    expect(extractJoinToken(nowReq('https://moq.wave.online/v1/publish/ns/track', { 'x-wave-moq-join': 'H' }))).toBe('H');
    expect(extractJoinToken(nowReq('https://moq.wave.online/v1/publish/ns/track'))).toBeNull();
  });
});

describe('verifyJoin — fail-closed', () => {
  it('503 when the secret is unset (never admit an unverifiable token)', async () => {
    const r = await verifyJoin({ MOQ_JOIN_ENFORCE: 'enforce' }, nowReq('https://x/?join=whatever'), 'ns', 'track', 'moq:write');
    expect(r).toEqual({ ok: false, code: 'MOQJ_SECRET_UNCONFIGURED', status: 503 });
  });

  it('401 when no token is presented', async () => {
    const r = await verifyJoin(enforce, nowReq('https://moq.wave.online/v1/publish/wave-crest/live'), 'wave-crest', 'live', 'moq:write');
    expect(r).toEqual({ ok: false, code: 'MOQJ_MISSING', status: 401 });
  });

  it('401 on a bad signature (wrong secret at mint)', async () => {
    const bad = await signJoinToken('OTHER-SECRET', { ns: 'wave-crest', track: 'live', org: 'o', scope: 'moq:write', iat: 1, exp: 61, jti: 'j' });
    const r = await verifyJoin(enforce, nowReq(`https://x/?join=${bad}`), 'wave-crest', 'live', 'moq:write');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe('MOQJ_BAD_SIGNATURE'); expect(r.status).toBe(401); }
  });
});

describe('verifyJoin — admits a valid token, IDOR + scope bound', () => {
  it('accepts a publish token at the SAME ns/track and returns the signed org/scope', async () => {
    const fresh = await mintFresh({ jti: 'j2' });
    const r = await verifyJoin(enforce, nowReq(`https://moq.wave.online/v1/publish/wave-crest/live?join=${fresh}`), 'wave-crest', 'live', 'moq:write');
    expect(r).toEqual({ ok: true, org: 'org_abc123', scope: 'moq:write' });
  });

  it('rejects the SAME token at a DIFFERENT namespace (IDOR)', async () => {
    const fresh = await mintFresh({ ns: 'org-a', org: 'org_a', jti: 'j3' });
    const r = await verifyJoin(enforce, nowReq(`https://x/?join=${fresh}`), 'org-b', 'live', 'moq:write');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe('MOQJ_NS_MISMATCH'); expect(r.status).toBe(401); }
  });

  it('403 when a read-only token is used to publish (scope insufficient)', async () => {
    const readTok = await mintFresh({ org: 'o', scope: 'moq:read', jti: 'j4' });
    const r = await verifyJoin(enforce, nowReq(`https://x/?join=${readTok}`), 'wave-crest', 'live', 'moq:write');
    expect(r).toEqual({ ok: false, code: 'MOQJ_SCOPE_INSUFFICIENT', status: 403 });
  });
});

describe('withVerifiedPrincipal — strips spoofable client headers, injects verified', () => {
  it('overwrites client-supplied x-wave-org / x-wave-scopes with the signed values', () => {
    const req = nowReq('https://moq.wave.online/v1/publish/wave-crest/live', {
      'x-wave-org': 'org_ATTACKER',
      'x-wave-scopes': 'moq:write moq:read *',
    });
    const out = withVerifiedPrincipal(req, 'org_REAL', 'moq:write');
    expect(out.headers.get('x-wave-org')).toBe('org_REAL');
    expect(out.headers.get('x-wave-scopes')).toBe('moq:write');
  });
});
