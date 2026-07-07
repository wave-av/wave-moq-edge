import { describe, it, expect } from 'vitest';
import {
  timingSafeEqual,
  requestFromGateway,
  sanitizeInjectedHeaders,
  WAVE_GATEWAY_SECRET_HEADER,
  GATEWAY_INJECTED_HEADERS,
  type GatewayTrustEnv,
} from '../src/gateway-trust';

const SECRET = 'wgs_0123456789abcdef0123456789abcdef'; // fixed-length high-entropy stand-in

/** Build a request carrying gateway-injected principal headers (+ optionally the gateway secret). */
function req(headers: Record<string, string> = {}, url = 'https://moq.wave.online/v1/publish/acme/cam-1') {
  return new Request(url, { headers });
}

describe('timingSafeEqual', () => {
  it('is true only for identical strings', () => {
    expect(timingSafeEqual(SECRET, SECRET)).toBe(true);
    expect(timingSafeEqual('', '')).toBe(true);
  });
  it('is false for any difference, including length', () => {
    expect(timingSafeEqual(SECRET, SECRET + 'x')).toBe(false);
    expect(timingSafeEqual(SECRET, SECRET.slice(0, -1))).toBe(false);
    expect(timingSafeEqual(SECRET, SECRET.replace('a', 'b'))).toBe(false);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });
});

describe('requestFromGateway', () => {
  it('is false when no secret is configured (inert)', () => {
    expect(requestFromGateway(req({ [WAVE_GATEWAY_SECRET_HEADER]: SECRET }), {})).toBe(false);
  });
  it('is false when the request omits the secret header', () => {
    expect(requestFromGateway(req(), { WAVE_GATEWAY_SECRET: SECRET })).toBe(false);
  });
  it('is false when the presented secret does not match', () => {
    expect(requestFromGateway(req({ [WAVE_GATEWAY_SECRET_HEADER]: 'wrong' }), { WAVE_GATEWAY_SECRET: SECRET })).toBe(false);
  });
  it('is true when the presented secret matches (case-insensitive header name)', () => {
    expect(requestFromGateway(req({ [WAVE_GATEWAY_SECRET_HEADER]: SECRET }), { WAVE_GATEWAY_SECRET: SECRET })).toBe(true);
    expect(requestFromGateway(req({ 'X-Wave-Gateway-Secret': SECRET }), { WAVE_GATEWAY_SECRET: SECRET })).toBe(true);
  });
});

describe('sanitizeInjectedHeaders', () => {
  const injected = { 'x-wave-org': 'acme', 'x-wave-scopes': 'moq:read moq:write', 'x-wave-tier': 'pro' };

  it('INERT: no secret configured → request returned untouched (live relay unaffected)', () => {
    const r = req({ ...injected });
    const env: GatewayTrustEnv = {}; // WAVE_GATEWAY_SECRET unset
    const out = sanitizeInjectedHeaders(r, env);
    expect(out).toBe(r); // same reference — pure pass-through
    expect(out.headers.get('x-wave-org')).toBe('acme');
  });

  it('TRUSTED: secret set + valid secret header → principal headers preserved, secret header dropped', () => {
    const r = req({ ...injected, [WAVE_GATEWAY_SECRET_HEADER]: SECRET });
    const out = sanitizeInjectedHeaders(r, { WAVE_GATEWAY_SECRET: SECRET });
    expect(out.headers.get('x-wave-org')).toBe('acme');
    expect(out.headers.get('x-wave-scopes')).toBe('moq:read moq:write');
    expect(out.headers.get('x-wave-tier')).toBe('pro');
    // secret is a bearer of trust — never forwarded past the boundary
    expect(out.headers.get(WAVE_GATEWAY_SECRET_HEADER)).toBeNull();
  });

  it('SPOOF: secret set + NO secret header → every injected principal header stripped (fail closed)', () => {
    const r = req({ ...injected }); // a direct client self-stamping org/scopes, no gateway secret
    const out = sanitizeInjectedHeaders(r, { WAVE_GATEWAY_SECRET: SECRET });
    for (const h of GATEWAY_INJECTED_HEADERS) expect(out.headers.get(h)).toBeNull();
    expect(out.headers.get(WAVE_GATEWAY_SECRET_HEADER)).toBeNull();
  });

  it('SPOOF: secret set + WRONG secret header → injected headers stripped (fail closed)', () => {
    const r = req({ ...injected, [WAVE_GATEWAY_SECRET_HEADER]: 'wrong-secret-value-of-same-len-paddd' });
    const out = sanitizeInjectedHeaders(r, { WAVE_GATEWAY_SECRET: SECRET });
    expect(out.headers.get('x-wave-org')).toBeNull();
    expect(out.headers.get('x-wave-scopes')).toBeNull();
  });

  it('preserves method + Upgrade header when reconstructing (WS publish path)', () => {
    const r = new Request('https://moq.wave.online/v1/publish/acme/cam-1', {
      method: 'GET',
      headers: { ...injected, Upgrade: 'websocket' },
    });
    const out = sanitizeInjectedHeaders(r, { WAVE_GATEWAY_SECRET: SECRET });
    expect(out.method).toBe('GET');
    expect(out.headers.get('Upgrade')).toBe('websocket');
    // untrusted (no secret) → org stripped even on the WS path
    expect(out.headers.get('x-wave-org')).toBeNull();
  });
});
