import { describe, it, expect, vi, afterEach } from 'vitest';
import { shouldEmit, buildMoqUsageBody, emitMoqUsage, type MoqUsageArgs } from '../usage-emit';

const ENV = { GATEWAY_BASE_URL: 'https://api.wave.online', WAVE_SERVICE_TOKEN: 'svc-token-deadbeef-0123456789' };
const REAL: MoqUsageArgs = { org: 'org_abc', trackKey: 'wave/cam-1', sessionId: 'sess-1', bytes: 1_000_000, frames: 300, reconnects: 1, sessionMs: 120_000 };

afterEach(() => vi.restoreAllMocks());

describe('#284 shouldEmit — the honesty + provisioning gates', () => {
  it('emits only when org + provisioned env + real usage are ALL present', () => {
    expect(shouldEmit(ENV, REAL)).toBe(true);
  });

  it('no org → never emit (we never fabricate an org to bill)', () => {
    expect(shouldEmit(ENV, { ...REAL, org: null })).toBe(false);
  });

  it('unprovisioned (missing URL or secret) → inert, never emit', () => {
    expect(shouldEmit({ WAVE_SERVICE_TOKEN: ENV.WAVE_SERVICE_TOKEN }, REAL)).toBe(false);
    expect(shouldEmit({ GATEWAY_BASE_URL: ENV.GATEWAY_BASE_URL }, REAL)).toBe(false);
    expect(shouldEmit({}, REAL)).toBe(false);
  });

  it('zero usage (no bytes/frames/time) → no emit', () => {
    expect(shouldEmit(ENV, { ...REAL, bytes: 0, frames: 0, sessionMs: 0 })).toBe(false);
    // any single real signal is enough:
    expect(shouldEmit(ENV, { ...REAL, bytes: 0, frames: 0, sessionMs: 1 })).toBe(true);
    expect(shouldEmit(ENV, { ...REAL, bytes: 1, frames: 0, sessionMs: 0 })).toBe(true);
  });
});

describe('#284 buildMoqUsageBody — the gateway ingest envelope', () => {
  it('returns null exactly when shouldEmit is false', () => {
    expect(buildMoqUsageBody(ENV, { ...REAL, org: null })).toBeNull();
    expect(buildMoqUsageBody({}, REAL)).toBeNull();
  });

  it('builds the {org, usage:{protocol:"moq", …}} envelope with a per-session event_id', () => {
    const body = buildMoqUsageBody(ENV, REAL)!;
    expect(body.org).toBe('org_abc');
    expect(body.usage.protocol).toBe('moq');
    expect(body.usage.bytes).toBe(1_000_000);
    expect(body.usage.frames).toBe(300);
    expect(body.usage.reconnects).toBe(1);
    expect(body.usage.session_ms).toBe(120_000);
    expect(body.usage.session_id).toBe('sess-1');
    expect(body.usage.event_id).toBe('moq:wave/cam-1:sess-1'); // stable per publisher session → gateway dedupes
  });

  it('omits session_ms when the session had no measured duration', () => {
    const body = buildMoqUsageBody(ENV, { ...REAL, sessionMs: 0 })!;
    expect(body.usage).not.toHaveProperty('session_ms');
    expect(body.usage.bytes).toBe(1_000_000); // still emitted on bytes alone
  });
});

describe('task#14 — publisher-declared protocol bills the matching dimension', () => {
  it('a dante-declared session emits protocol:"dante" (and a dante-prefixed event_id, no collision with moq)', () => {
    const body = buildMoqUsageBody(ENV, { ...REAL, protocol: 'dante' })!;
    expect(body.usage.protocol).toBe('dante');
    expect(body.usage.event_id).toBe('dante:wave/cam-1:sess-1');
  });

  it('an undeclared session still emits "moq" (unchanged default — never fabricate a protocol)', () => {
    const body = buildMoqUsageBody(ENV, REAL)!; // no `protocol` field at all
    expect(body.usage.protocol).toBe('moq');
    expect(body.usage.event_id).toBe('moq:wave/cam-1:sess-1');
  });

  it('no double-bill: exactly ONE protocol dimension is emitted per session (XOR, never both)', () => {
    const danteBody = buildMoqUsageBody(ENV, { ...REAL, protocol: 'dante' })!;
    const moqBody = buildMoqUsageBody(ENV, REAL)!;
    // Each envelope carries a single scalar `usage.protocol` — structurally impossible to double-bill
    // moq+dante from one emit call.
    expect(typeof danteBody.usage.protocol).toBe('string');
    expect(danteBody.usage.protocol).not.toBe(moqBody.usage.protocol);
    expect([danteBody.usage.protocol, moqBody.usage.protocol].sort()).toEqual(['dante', 'moq']);
  });
});

describe('#284 emitMoqUsage — fire-and-forget POST, fail-open', () => {
  it('POSTs to /v1/internal/usage with the service bearer when provisioned + attributed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await emitMoqUsage(ENV, REAL);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.wave.online/v1/internal/usage');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${ENV.WAVE_SERVICE_TOKEN}`);
    expect(JSON.parse(init.body as string).usage.protocol).toBe('moq');
  });

  it('strips a trailing slash on GATEWAY_BASE_URL (no double slash)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await emitMoqUsage({ ...ENV, GATEWAY_BASE_URL: 'https://api.wave.online/' }, REAL);
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe('https://api.wave.online/v1/internal/usage');
  });

  it('does NO network when the gate is closed (no org / unprovisioned)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await emitMoqUsage(ENV, { ...REAL, org: null });
    await emitMoqUsage({}, REAL);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fail-open: a fetch error never throws (a usage emit must not affect the relay)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(emitMoqUsage(ENV, REAL)).resolves.toBeUndefined();
  });
});
