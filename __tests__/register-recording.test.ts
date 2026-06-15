import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  shouldRegister,
  buildRegisterBody,
  registerRecording,
  type RegisterRecordingArgs,
  type RegisterRecordingEnv,
} from '../register-recording';

const ENV: RegisterRecordingEnv = {
  GATEWAY_BASE_URL: 'https://api.wave.online',
  WAVE_SERVICE_TOKEN: 'svc-token-deadbeef-0123456789',
  MOQ_RECORDINGS_BUCKET: 'wave-moq-recordings',
};
const ORG = '11111111-1111-1111-1111-111111111111';
const REAL: RegisterRecordingArgs = {
  org: ORG,
  r2Key: `${ORG}/recordings/sess-uuid/recording.mp4`,
  sessionId: 'sess-uuid',
};

afterEach(() => vi.restoreAllMocks());

describe('shouldRegister — honesty + provisioning + tenant-boundary gates', () => {
  it('registers only with org + provisioned env + org-prefixed key', () => {
    expect(shouldRegister(ENV, REAL)).toBe(true);
  });

  it('no org → never register (never fabricate an owner)', () => {
    expect(shouldRegister(ENV, { ...REAL, org: null })).toBe(false);
  });

  it('unprovisioned (missing URL / token / bucket) → inert', () => {
    expect(shouldRegister({ ...ENV, GATEWAY_BASE_URL: undefined }, REAL)).toBe(false);
    expect(shouldRegister({ ...ENV, WAVE_SERVICE_TOKEN: undefined }, REAL)).toBe(false);
    expect(shouldRegister({ ...ENV, MOQ_RECORDINGS_BUCKET: undefined }, REAL)).toBe(false);
  });

  it('key not under the org prefix → skip (the gateway would 403 it)', () => {
    expect(shouldRegister(ENV, { ...REAL, r2Key: 'other-org/recordings/x/recording.mp4' })).toBe(false);
    expect(shouldRegister(ENV, { ...REAL, r2Key: '' })).toBe(false);
  });
});

describe('buildRegisterBody — the gateway register envelope', () => {
  it('returns null exactly when shouldRegister is false', () => {
    expect(buildRegisterBody(ENV, { ...REAL, org: null })).toBeNull();
    expect(buildRegisterBody({ ...ENV, WAVE_SERVICE_TOKEN: undefined }, REAL)).toBeNull();
  });

  it('builds the {recordingId, principal:{org}, r2Key, bucket, sourceProtocol, kind} envelope', () => {
    const body = buildRegisterBody(ENV, REAL)!;
    expect(body.recordingId).toBe('sess-uuid'); // sessionId → idempotent by PK
    expect(body.principal.org).toBe(ORG);
    expect(body.r2Key).toBe(REAL.r2Key);
    expect(body.bucket).toBe('wave-moq-recordings');
    expect(body.sourceProtocol).toBe('moq');
    expect(body.kind).toBe('recording');
  });
});

describe('registerRecording — fire-and-forget POST, fail-soft', () => {
  it('POSTs to /v1/internal/recordings/register with the service bearer when provisioned', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await registerRecording(ENV, REAL);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.wave.online/v1/internal/recordings/register');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${ENV.WAVE_SERVICE_TOKEN}`);
    expect(JSON.parse(init.body as string).sourceProtocol).toBe('moq');
  });

  it('strips a trailing slash on GATEWAY_BASE_URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await registerRecording({ ...ENV, GATEWAY_BASE_URL: 'https://api.wave.online/' }, REAL);
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe('https://api.wave.online/v1/internal/recordings/register');
  });

  it('does NO network when the gate is closed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await registerRecording(ENV, { ...REAL, org: null });
    await registerRecording({ ...ENV, WAVE_SERVICE_TOKEN: undefined }, REAL);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fail-soft: a fetch error never throws (bytes are already durable; register is retryable)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(registerRecording(ENV, REAL)).resolves.toBeUndefined();
  });
});
