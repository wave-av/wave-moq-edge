import { describe, it, expect } from 'vitest';
import { authRequired, extractWaveToken, isWaveTokenWellFormed, authGate, WAVE_TOKEN_PREFIX } from '../src/wave-auth';

const GOOD = `${WAVE_TOKEN_PREFIX}abcdef0123456789`;

function req(headers: Record<string, string> = {}, url = 'https://moq.wave.online/v1/subscribe/wave/cam-1') {
  return new Request(url, { headers });
}

describe('wave-token-v1 enforcement flag', () => {
  it('is off by default and for falsey values', () => {
    expect(authRequired({})).toBe(false);
    for (const v of ['', 'false', '0', 'off', 'no']) expect(authRequired({ MOQ_REQUIRE_AUTH: v })).toBe(false);
  });
  it('is on for truthy values (case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'On']) expect(authRequired({ MOQ_REQUIRE_AUTH: v })).toBe(true);
  });
});

describe('wave-token-v1 token extraction', () => {
  it('reads a Bearer header (case-insensitive scheme + header name)', () => {
    expect(extractWaveToken(req({ Authorization: `Bearer ${GOOD}` }))).toBe(GOOD);
    expect(extractWaveToken(req({ authorization: `bearer ${GOOD}` }))).toBe(GOOD);
  });
  it('falls back to ?access_token= query for header-less WS clients', () => {
    expect(extractWaveToken(req({}, `https://moq.wave.online/v1/subscribe/wave/cam-1?access_token=${GOOD}`))).toBe(GOOD);
  });
  it('prefers the header over the query param', () => {
    expect(extractWaveToken(req({ Authorization: `Bearer ${GOOD}` }, `https://moq.wave.online/x?access_token=other`))).toBe(GOOD);
  });
  it('returns null when no token is present', () => {
    expect(extractWaveToken(req())).toBeNull();
  });
});

describe('wave-token-v1 format validation', () => {
  it('accepts a well-formed token', () => {
    expect(isWaveTokenWellFormed(GOOD)).toBe(true);
  });
  it('rejects wrong prefix, empty body, stub body, and null', () => {
    expect(isWaveTokenWellFormed(null)).toBe(false);
    expect(isWaveTokenWellFormed('Bearer xyz')).toBe(false);
    expect(isWaveTokenWellFormed('jwt.aaaaaaaa')).toBe(false);
    expect(isWaveTokenWellFormed(WAVE_TOKEN_PREFIX)).toBe(false); // empty body
    expect(isWaveTokenWellFormed(`${WAVE_TOKEN_PREFIX}short`)).toBe(false); // <8 chars
  });
});

describe('authGate front-door behaviour', () => {
  it('is a no-op (null) when enforcement is off — live relay unchanged', () => {
    expect(authGate(req(), {})).toBeNull();
    expect(authGate(req(), { MOQ_REQUIRE_AUTH: 'false' })).toBeNull();
  });
  it('allows a valid token when enforced', () => {
    expect(authGate(req({ Authorization: `Bearer ${GOOD}` }), { MOQ_REQUIRE_AUTH: 'true' })).toBeNull();
  });
  it('401s a missing token when enforced (with WWW-Authenticate)', () => {
    const r = authGate(req(), { MOQ_REQUIRE_AUTH: 'true' });
    expect(r?.status).toBe(401);
    expect(r?.headers.get('www-authenticate')).toContain('wave-token-v1');
  });
  it('401s a malformed token when enforced', () => {
    expect(authGate(req({ Authorization: 'Bearer jwt.nope' }), { MOQ_REQUIRE_AUTH: 'true' })?.status).toBe(401);
  });
});
