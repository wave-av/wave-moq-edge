/**
 * tenant-isolation.test.ts — task #45: namespace→org binding proves Org 1 cannot
 * publish/subscribe/enumerate Org 2's MoQ streams. Two invariants under test:
 *   (1) FLAG OFF (default) → every gate is a no-op; the live relay is unchanged.
 *   (2) FLAG ON → a principal may only touch namespaces its gateway-injected org
 *       owns (prefix-ownership, dash-delimited), and discovery is org-scoped.
 */
import { describe, it, expect } from 'vitest';
import {
  WAVE_ORG_HEADER,
  extractInjectedOrg,
  orgOwnsNamespace,
  orgGate,
  filterTracksForOrg,
} from '../src/wave-auth';

const OFF = {}; // MOQ_REQUIRE_AUTH unset → enforcement off (default)
const ON = { MOQ_REQUIRE_AUTH: 'true' };

function req(org?: string): Request {
  const h = new Headers();
  if (org !== undefined) h.set(WAVE_ORG_HEADER, org);
  return new Request('https://moq.wave.online/v1/publish/ns/track', { headers: h });
}

describe('extractInjectedOrg', () => {
  it('reads and trims the canonical header; null when absent/empty', () => {
    expect(extractInjectedOrg(req('acme'))).toBe('acme');
    expect(extractInjectedOrg(req('  acme  '))).toBe('acme');
    expect(extractInjectedOrg(req(''))).toBeNull();
    expect(extractInjectedOrg(req())).toBeNull();
  });
});

describe('orgOwnsNamespace (pure prefix-ownership)', () => {
  it('org owns its exact namespace and dash-prefixed children', () => {
    expect(orgOwnsNamespace('acme', 'acme')).toBe(true);
    expect(orgOwnsNamespace('acme', 'acme-live')).toBe(true);
    expect(orgOwnsNamespace('acme', 'acme-crest-cam1')).toBe(true);
  });
  it('the dash separator prevents prefix-confusion (the load-bearing test)', () => {
    // 'acme' must NOT own 'acmecorp' or 'acmecorp-live' — only exact or `acme-*`.
    expect(orgOwnsNamespace('acme', 'acmecorp')).toBe(false);
    expect(orgOwnsNamespace('acme', 'acmecorp-live')).toBe(false);
  });
  it('an org never owns another org’s namespace', () => {
    expect(orgOwnsNamespace('acme', 'globex')).toBe(false);
    expect(orgOwnsNamespace('acme', 'globex-live')).toBe(false);
  });
  it('empty/null org owns nothing (fail-closed)', () => {
    expect(orgOwnsNamespace(null, 'acme')).toBe(false);
    expect(orgOwnsNamespace('', 'acme')).toBe(false);
    expect(orgOwnsNamespace('', '')).toBe(false);
  });
});

describe('orgGate — FLAG OFF (no behavioral change)', () => {
  it('always returns null regardless of org/namespace, even with no org header', () => {
    expect(orgGate(req(), OFF, 'anything')).toBeNull();
    expect(orgGate(req('acme'), OFF, 'globex-live')).toBeNull(); // cross-org allowed when off
  });
});

describe('orgGate — FLAG ON (tenant boundary enforced)', () => {
  it('allows an org to touch its own namespace', () => {
    expect(orgGate(req('acme'), ON, 'acme')).toBeNull();
    expect(orgGate(req('acme'), ON, 'acme-live')).toBeNull();
  });
  it('DENIES cross-org publish/subscribe with 403', () => {
    const r = orgGate(req('globex'), ON, 'acme-live');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(403);
  });
  it('DENIES a missing org header with 403 (gateway must inject it)', () => {
    const r = orgGate(req(), ON, 'acme-live');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(403);
  });
  it('403 body is problem+json naming the namespace', async () => {
    const r = orgGate(req('globex'), ON, 'acme-live')!;
    const body = (await r.json()) as { status: number; namespace: string; detail: string };
    expect(body.status).toBe(403);
    expect(body.namespace).toBe('acme-live');
    expect(body.detail).toContain('globex');
  });
});

describe('filterTracksForOrg — discovery scoping', () => {
  const tracks = [
    { namespace: 'acme', track: 'live' },
    { namespace: 'acme-cam2', track: 'live' },
    { namespace: 'globex', track: 'live' },
    { namespace: 'acmecorp', track: 'live' }, // must NOT leak to acme
  ];
  const ns = (t: { namespace: string }) => t.namespace;

  it('FLAG OFF → returns ALL tracks unchanged (relay directory unchanged)', () => {
    expect(filterTracksForOrg(tracks, req('acme'), OFF, ns)).toHaveLength(4);
    expect(filterTracksForOrg(tracks, req(), OFF, ns)).toHaveLength(4);
  });
  it('FLAG ON → returns only the caller-org’s tracks', () => {
    const out = filterTracksForOrg(tracks, req('acme'), ON, ns);
    expect(out.map(ns).sort()).toEqual(['acme', 'acme-cam2']);
    // globex + acmecorp are NOT visible to acme
    expect(out.some((t) => t.namespace === 'globex')).toBe(false);
    expect(out.some((t) => t.namespace === 'acmecorp')).toBe(false);
  });
  it('FLAG ON + no org → empty (fail-closed, not a full directory)', () => {
    expect(filterTracksForOrg(tracks, req(), ON, ns)).toHaveLength(0);
  });
  it('FLAG ON → a different org sees only its own', () => {
    const out = filterTracksForOrg(tracks, req('globex'), ON, ns);
    expect(out.map(ns)).toEqual(['globex']);
  });
});
