/**
 * Scheme-relative paths must never reach chassis makeFetch.
 *
 * Chassis 0.20.0 (this lockfile) federates unmatched paths with
 * `new URL(path, origin)`. `//example.com/` is a WHATWG path on this host
 * and that constructor yields https://example.com/ — an open proxy.
 */
import { describe, it, expect } from 'vitest';
import { isUnsafeFederationPath } from '../src/federation-guard';

const GATEWAY = 'https://api.wave.online';
const RELAY = 'https://moq.wave.online';

describe('isUnsafeFederationPath', () => {
  it('refuses scheme-relative pathnames', () => {
    expect(isUnsafeFederationPath('//example.com/')).toBe(true);
    expect(isUnsafeFederationPath('//evil.example/steal')).toBe(true);
    expect(isUnsafeFederationPath('//example.com/foo?q=1'.split('?')[0])).toBe(true);
  });

  it('allows the landing page, health, metrics, and /v1 API', () => {
    expect(isUnsafeFederationPath('/')).toBe(false);
    expect(isUnsafeFederationPath('/health')).toBe(false);
    expect(isUnsafeFederationPath('/metrics')).toBe(false);
    expect(isUnsafeFederationPath('/v1/announce')).toBe(false);
    expect(isUnsafeFederationPath('/v1/publish/acme/cam1')).toBe(false);
    expect(isUnsafeFederationPath('/_wave/nav.js')).toBe(false);
  });
});

describe('WHATWG resolution (why the guard exists)', () => {
  it('resolves //host against the gateway origin to that host', () => {
    const federated = new URL('//example.com/', GATEWAY);
    expect(federated.href).toBe('https://example.com/');
    expect(federated.host).toBe('example.com');
  });

  it('resolves //host against the relay origin the same way', () => {
    const federated = new URL('//example.com/', RELAY);
    expect(federated.href).toBe('https://example.com/');
    expect(federated.host).toBe('example.com');
  });

  it('keeps a normal /v1 path on the relay origin', () => {
    const local = new URL('/v1/announce', RELAY);
    expect(local.host).toBe('moq.wave.online');
    expect(local.pathname).toBe('/v1/announce');
  });
});
