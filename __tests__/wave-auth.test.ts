import { describe, it, expect } from 'vitest';
import {
  authRequired,
  extractWaveToken,
  isWaveTokenWellFormed,
  authGate,
  WAVE_TOKEN_PREFIX,
  extractInjectedScopes,
  hasScope,
  scopeGate,
  MOQ_SCOPE_READ,
  MOQ_SCOPE_WRITE,
  WAVE_SCOPES_HEADER,
  WAVE_DECLARED_PROTOCOL_HEADER,
  KNOWN_DECLARABLE_PROTOCOLS,
  stripDeclaredProtocol,
} from '../src/wave-auth';

const GOOD = `${WAVE_TOKEN_PREFIX}abcdef0123456789`;

function req(headers: Record<string, string> = {}, url = 'https://moq.wave.online/v1/subscribe/wave/cam-1') {
  return new Request(url, { headers });
}

/** A request bearing a valid token AND a gateway-injected scopes header. */
function authedReq(scopes: string, url = 'https://moq.wave.online/v1/subscribe/wave/cam-1') {
  return req({ Authorization: `Bearer ${GOOD}`, [WAVE_SCOPES_HEADER]: scopes }, url);
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

describe('canonical MoQ scopes (from #281 — read/write, never invented names)', () => {
  it('uses the gateway scope literals moq:read / moq:write', () => {
    expect(MOQ_SCOPE_READ).toBe('moq:read');
    expect(MOQ_SCOPE_WRITE).toBe('moq:write');
  });
});

describe('extractInjectedScopes (gateway-injected principal)', () => {
  it('returns an empty set when the header is absent', () => {
    expect(extractInjectedScopes(req()).size).toBe(0);
  });
  it('splits a space-delimited scope header (the gateway scopes.join(" ") format)', () => {
    const s = extractInjectedScopes(req({ [WAVE_SCOPES_HEADER]: 'moq:read moq:write me:read' }));
    expect([...s].sort()).toEqual(['me:read', 'moq:read', 'moq:write']);
  });
  it('tolerates repeated / leading / trailing whitespace', () => {
    const s = extractInjectedScopes(req({ [WAVE_SCOPES_HEADER]: '   moq:read    moq:write  ' }));
    expect([...s].sort()).toEqual(['moq:read', 'moq:write']);
  });
});

describe('hasScope (matches gateway wildcard semantics)', () => {
  it('grants an exact scope', () => {
    expect(hasScope(new Set(['moq:read']), 'moq:read')).toBe(true);
  });
  it('denies an absent scope', () => {
    expect(hasScope(new Set(['moq:read']), 'moq:write')).toBe(false);
    expect(hasScope(new Set(), 'moq:read')).toBe(false);
  });
  it('grants via a moq:* protocol wildcard', () => {
    expect(hasScope(new Set(['moq:*']), 'moq:read')).toBe(true);
    expect(hasScope(new Set(['moq:*']), 'moq:write')).toBe(true);
  });
  it('grants via a global * wildcard', () => {
    expect(hasScope(new Set(['*']), 'moq:write')).toBe(true);
  });
  it('does NOT let a different protocol wildcard grant moq', () => {
    expect(hasScope(new Set(['ndi:*']), 'moq:read')).toBe(false);
  });
});

describe('scopeGate — flag OFF (DEFAULT): live relay behaviour is UNCHANGED', () => {
  // The whole point of the default-off flag: anonymous publish AND subscribe keep working today.
  it('allows anonymous publish (no token, no scopes) when MOQ_REQUIRE_AUTH is unset', () => {
    expect(scopeGate(req(), {}, MOQ_SCOPE_WRITE)).toBeNull();
  });
  it('allows anonymous subscribe (no token, no scopes) when MOQ_REQUIRE_AUTH is unset', () => {
    expect(scopeGate(req(), {}, MOQ_SCOPE_READ)).toBeNull();
  });
  it('allows anonymous when the flag is an explicit falsey value', () => {
    expect(scopeGate(req(), { MOQ_REQUIRE_AUTH: 'false' }, MOQ_SCOPE_WRITE)).toBeNull();
    expect(scopeGate(req(), { MOQ_REQUIRE_AUTH: '0' }, MOQ_SCOPE_READ)).toBeNull();
  });
  it('ignores even a present-but-wrong scope when off (no behavioral change)', () => {
    expect(scopeGate(authedReq('ndi:read'), {}, MOQ_SCOPE_WRITE)).toBeNull();
  });
});

describe('scopeGate — flag ON: closes the anonymous-access hole', () => {
  const ON = { MOQ_REQUIRE_AUTH: 'true' };

  it('401s anonymous publish (no token) — anon can no longer publish', () => {
    const r = scopeGate(req(), ON, MOQ_SCOPE_WRITE);
    expect(r?.status).toBe(401);
    expect(r?.headers.get('www-authenticate')).toContain('wave-token-v1');
  });
  it('401s anonymous subscribe (no token) — anon can no longer subscribe', () => {
    expect(scopeGate(req(), ON, MOQ_SCOPE_READ)?.status).toBe(401);
  });
  it('403s a valid token that LACKS the required scope (publish needs moq:write)', () => {
    const r = scopeGate(authedReq('moq:read'), ON, MOQ_SCOPE_WRITE);
    expect(r?.status).toBe(403);
    expect(r?.headers.get('www-authenticate')).toContain('insufficient_scope');
    expect(r?.headers.get('www-authenticate')).toContain('moq:write');
  });
  it('403s a valid token that LACKS the required scope (subscribe needs moq:read)', () => {
    expect(scopeGate(authedReq('moq:write'), ON, MOQ_SCOPE_READ)?.status).toBe(403);
  });
  it('403s a valid token with NO scopes header at all', () => {
    expect(scopeGate(req({ Authorization: `Bearer ${GOOD}` }), ON, MOQ_SCOPE_WRITE)?.status).toBe(403);
  });
  it('allows a scoped principal: moq:write → publish', () => {
    expect(scopeGate(authedReq('moq:write'), ON, MOQ_SCOPE_WRITE)).toBeNull();
  });
  it('allows a scoped principal: moq:read → subscribe', () => {
    expect(scopeGate(authedReq('moq:read'), ON, MOQ_SCOPE_READ)).toBeNull();
  });
  it('allows a principal holding both scopes for either action', () => {
    expect(scopeGate(authedReq('moq:read moq:write'), ON, MOQ_SCOPE_WRITE)).toBeNull();
    expect(scopeGate(authedReq('moq:read moq:write'), ON, MOQ_SCOPE_READ)).toBeNull();
  });
  it('allows a moq:* wildcard principal for either action', () => {
    expect(scopeGate(authedReq('moq:*'), ON, MOQ_SCOPE_WRITE)).toBeNull();
    expect(scopeGate(authedReq('moq:*'), ON, MOQ_SCOPE_READ)).toBeNull();
  });
  it('reads the token from ?access_token for header-less WS clients (scope still enforced)', () => {
    const url = `https://moq.wave.online/v1/subscribe/wave/cam-1?access_token=${GOOD}`;
    // scopes header still required (gateway injects it); token via query is accepted by authGate
    expect(scopeGate(req({ [WAVE_SCOPES_HEADER]: 'moq:read' }, url), ON, MOQ_SCOPE_READ)).toBeNull();
    expect(scopeGate(req({}, url), ON, MOQ_SCOPE_READ)?.status).toBe(403); // token ok, no scope → 403
  });
});

describe('task#14 CONFIRMED under-bill fix — stripDeclaredProtocol', () => {
  it('removes a client-supplied declared-protocol header unconditionally', () => {
    const r = req({ [WAVE_DECLARED_PROTOCOL_HEADER]: 'dante' });
    const out = stripDeclaredProtocol(r);
    expect(out.headers.get(WAVE_DECLARED_PROTOCOL_HEADER)).toBeNull();
  });

  it('is a no-op (still absent) when no declared-protocol header was ever present', () => {
    const r = req({});
    const out = stripDeclaredProtocol(r);
    expect(out.headers.get(WAVE_DECLARED_PROTOCOL_HEADER)).toBeNull();
  });

  it('does not disturb other headers', () => {
    const r = req({ [WAVE_SCOPES_HEADER]: 'moq:write', [WAVE_DECLARED_PROTOCOL_HEADER]: 'dante' });
    const out = stripDeclaredProtocol(r);
    expect(out.headers.get(WAVE_SCOPES_HEADER)).toBe('moq:write');
    expect(out.headers.get(WAVE_DECLARED_PROTOCOL_HEADER)).toBeNull();
  });
});

describe('task#14 — KNOWN_DECLARABLE_PROTOCOLS (relay-side defense-in-depth allow-list)', () => {
  it('recognizes exactly the gateway PROTOCOL_RESOURCES set', () => {
    expect([...KNOWN_DECLARABLE_PROTOCOLS].sort()).toEqual(['dante', 'moq', 'ndi', 'omt', 'srt']);
  });
  it('rejects an arbitrary/unknown string', () => {
    expect(KNOWN_DECLARABLE_PROTOCOLS.has('not-a-real-protocol')).toBe(false);
  });
});
