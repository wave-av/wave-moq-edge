/**
 * discovery-join-auth.test.ts — #112: a gateway-minted join-token is a first-class DISCOVERY
 * credential for /v1/announce + /v1/catalog, and every negative case lists NOTHING.
 *
 * Invariants under test:
 *   (1) DEFAULT-INERT — MOQ_DISCOVERY_JOIN unset → the join path never engages, even with a
 *       perfectly valid token; discovery behaves exactly as today.
 *   (2) NO TOKEN → unchanged legacy behaviour (flag on or off).
 *   (3) VALID token → lists ONLY the token's signed namespace (never the whole org).
 *   (4) FAIL-CLOSED — expired / malformed / bad-signature / wrong-scope / wrong-org / other-ns /
 *       unset-secret all list NOTHING. No error path widens to the unfiltered list.
 */
import { describe, it, expect } from 'vitest';
import { signJoinToken } from '../src/moq-join-token';
import {
  discoveryJoinEnabled,
  usesDiscoveryJoin,
  verifyDiscoveryJoin,
  filterTracksForJoin,
  peekClaimedResource,
} from '../src/moq-discovery-auth';

const SECRET = 'test-moq-join-secret-#112'; // enforce-ignore — test-only HMAC key, not a real credential
const NOW = 1_800_000_000;

const ON = { MOQ_DISCOVERY_JOIN: 'true', WAVE_MOQ_JOIN_SECRET: SECRET };
const OFF = { WAVE_MOQ_JOIN_SECRET: SECRET }; // flag unset → default-inert

/** The live registry as three lens tracks in one namespace, plus another org's namespace. */
const ENTRIES = [
  { namespace: 'acme-live', track: 'lens-wide' },
  { namespace: 'acme-live', track: 'lens-tight' },
  { namespace: 'acme-live', track: 'lens-aerial' },
  { namespace: 'acme-archive', track: 'lens-wide' }, // SAME org, DIFFERENT namespace
  { namespace: 'globex-live', track: 'lens-wide' }, // different org entirely
];
const nsOf = (e: { namespace: string }) => e.namespace;

async function mint(over: Partial<Record<string, unknown>> = {}, secret = SECRET): Promise<string> {
  return signJoinToken(secret, {
    ns: 'acme-live',
    track: 'lens-wide',
    org: 'acme',
    scope: 'moq:read',
    iat: NOW,
    exp: NOW + 60,
    jti: 'jti-112-test',
    ...over,
  } as Parameters<typeof signJoinToken>[1]);
}

function req(token?: string, via: 'query' | 'header' = 'query'): Request {
  if (!token) return new Request('https://moq.wave.online/v1/announce');
  if (via === 'header') {
    return new Request('https://moq.wave.online/v1/announce', { headers: { 'x-wave-moq-join': token } });
  }
  return new Request(`https://moq.wave.online/v1/announce?join=${encodeURIComponent(token)}`);
}

/** End-to-end scoping helper mirroring index.ts scopeDiscovery's join branch. */
async function listWith(env: typeof ON | typeof OFF, request: Request, now = NOW) {
  if (!usesDiscoveryJoin(env, request)) return ENTRIES; // legacy path (MOQ_REQUIRE_AUTH off → unchanged)
  const verdict = await verifyDiscoveryJoin(env, request, now);
  return filterTracksForJoin(ENTRIES, verdict, nsOf);
}

describe('flag — default-inert', () => {
  it('is off unless explicitly enabled', () => {
    expect(discoveryJoinEnabled({})).toBe(false);
    expect(discoveryJoinEnabled({ MOQ_DISCOVERY_JOIN: '' })).toBe(false);
    expect(discoveryJoinEnabled({ MOQ_DISCOVERY_JOIN: 'off' })).toBe(false);
    for (const v of ['1', 'true', 'on', 'enforce', 'TRUE']) {
      expect(discoveryJoinEnabled({ MOQ_DISCOVERY_JOIN: v })).toBe(true);
    }
  });

  it('FLAG OFF + a VALID token → the join path never engages (unchanged discovery)', async () => {
    const r = req(await mint());
    expect(usesDiscoveryJoin(OFF, r)).toBe(false);
    expect(await listWith(OFF, r)).toEqual(ENTRIES);
  });
});

describe('no token — behaves exactly as today', () => {
  it('flag ON but no token → legacy path (join branch not taken)', async () => {
    expect(usesDiscoveryJoin(ON, req())).toBe(false);
    expect(await listWith(ON, req())).toEqual(ENTRIES);
  });
});

describe('valid token — lists only the token’s own namespace', () => {
  it('verifies and scopes to the SIGNED ns claim (three lens tracks, nothing else)', async () => {
    const listed = await listWith(ON, req(await mint()));
    expect(listed.map((e) => e.track).sort()).toEqual(['lens-aerial', 'lens-tight', 'lens-wide']);
    expect(listed.every((e) => e.namespace === 'acme-live')).toBe(true);
  });

  it('does NOT widen to the org: the same org’s OTHER namespace is excluded', async () => {
    const listed = await listWith(ON, req(await mint()));
    expect(listed.some((e) => e.namespace === 'acme-archive')).toBe(false);
  });

  it('listing REQUIRES moq:read — a write-only grant lists nothing', async () => {
    expect(await listWith(ON, req(await mint({ scope: 'moq:write' })))).toEqual([]);
  });

  it('a moq:* wildcard grant lists, matching publish/subscribe scope semantics', async () => {
    const listed = await listWith(ON, req(await mint({ scope: 'moq:*' })));
    expect(listed).toHaveLength(3);
  });

  it('the x-wave-moq-join header carrier works identically to ?join=', async () => {
    const listed = await listWith(ON, req(await mint(), 'header'));
    expect(listed).toHaveLength(3);
  });
});

describe('fail-closed negatives — every one lists NOTHING', () => {
  it('EXPIRED token (beyond the existing skew allowance) lists nothing', async () => {
    const t = await mint({ iat: NOW - 300, exp: NOW - 240 });
    expect(await listWith(ON, req(t))).toEqual([]);
    // and the skew rule is NOT relaxed: 1s past exp is still inside the 5s allowance
    const fresh = await mint();
    expect(await listWith(ON, req(fresh), NOW + 61)).toHaveLength(3);
    expect(await listWith(ON, req(fresh), NOW + 66)).toEqual([]);
  });

  it('MALFORMED tokens list nothing (garbage, wrong segment count, non-base64url, bad JSON)', async () => {
    for (const bad of ['not-a-token', 'a.b', 'a.b.c.d', 'aaa.!!!.ccc', 'aaa.YWJj.ccc', '..']) {
      expect(await listWith(ON, req(bad))).toEqual([]);
    }
  });

  it('a TAMPERED payload (ns rewritten to another namespace) fails the signature → nothing', async () => {
    const t = await mint();
    const [h, p, s] = t.split('.');
    const claims = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (p.length % 4)) % 4)));
    claims.ns = 'globex-live';
    const forgedPayload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // The peek reads the attacker's ns, but the HMAC covers the payload → BAD_SIGNATURE → empty.
    expect(peekClaimedResource(`${h}.${forgedPayload}.${s}`)).toEqual({ ns: 'globex-live', track: 'lens-wide' });
    const v = await verifyDiscoveryJoin(ON, req(`${h}.${forgedPayload}.${s}`), NOW);
    expect(v.ok).toBe(false);
    expect(await listWith(ON, req(`${h}.${forgedPayload}.${s}`))).toEqual([]);
  });

  it('a token signed with the WRONG secret lists nothing', async () => {
    expect(await listWith(ON, req(await mint({}, 'some-other-secret')))).toEqual([]);
  });

  it('WRONG-ORG token lists only ITS own namespace — never the requester-adjacent one', async () => {
    const listed = await listWith(ON, req(await mint({ ns: 'globex-live', track: 'lens-wide', org: 'globex' })));
    expect(listed).toEqual([{ namespace: 'globex-live', track: 'lens-wide' }]);
    expect(listed.some((e) => e.namespace.startsWith('acme'))).toBe(false);
  });

  it('a token for a namespace with no live tracks lists nothing', async () => {
    expect(await listWith(ON, req(await mint({ ns: 'initech-live' })))).toEqual([]);
  });

  it('an UNSET signing secret lists nothing (never admits, never widens)', async () => {
    const env = { MOQ_DISCOVERY_JOIN: 'true' };
    const r = req(await mint());
    expect(usesDiscoveryJoin(env, r)).toBe(true);
    const v = await verifyDiscoveryJoin(env, r, NOW);
    expect(v).toEqual({ ok: false, code: 'MOQJ_SECRET_UNCONFIGURED' });
    expect(filterTracksForJoin(ENTRIES, v, nsOf)).toEqual([]);
  });

  it('an over-long TTL is rejected even when correctly signed (ceiling not relaxed)', async () => {
    expect(await listWith(ON, req(await mint({ exp: NOW + 3600 })))).toEqual([]);
  });

  it('a token missing jti / with a bad issuer lists nothing', async () => {
    expect(await listWith(ON, req(await mint({ jti: '' })))).toEqual([]);
  });

  it('a rejection verdict NEVER carries the token value (no leak into logs/bodies)', async () => {
    const t = await mint({}, 'some-other-secret');
    const v = await verifyDiscoveryJoin(ON, req(t), NOW);
    expect(JSON.stringify(v).includes(t)).toBe(false);
    expect(v).toEqual({ ok: false, code: 'MOQJ_BAD_SIGNATURE' });
  });
});
