import { describe, it, expect } from 'vitest';
import {
  handleMoqSfuFanout,
  moqSfuFanoutActivated,
  notActivatedBody,
  MOQ_SFU_SCOPES,
  MOQ_SFU_RETRY_AFTER_SECONDS,
  type MoqSfuFanoutEnv,
  type ContainerBinding,
} from '../src/moq-sfu-fanout';

const TRACK = { namespace: 'wave', name: 'cam-1' };
const POST = () => new Request('https://moq.wave.online/v1/fanout/sfu/wave/cam-1', { method: 'POST' });
const GET = () => new Request('https://moq.wave.online/v1/fanout/sfu/wave/cam-1', { method: 'GET' });

/** A fake container binding that records whether it was ever invoked. */
function fakeBinding(): ContainerBinding & { calls: number } {
  const b = {
    calls: 0,
    async fetch(_req: Request): Promise<Response> {
      b.calls += 1;
      return new Response('forwarded', { status: 201 });
    },
  };
  return b;
}

describe('#55 moqSfuFanoutActivated — flag AND binding both required', () => {
  it('false when both absent (the only real state today)', () => {
    expect(moqSfuFanoutActivated({})).toBe(false);
  });
  it('false when flag on but binding absent (no fake transport)', () => {
    expect(moqSfuFanoutActivated({ MOQ_SFU_FANOUT_ENABLED: 'true' })).toBe(false);
  });
  it('false when binding present but flag off', () => {
    expect(moqSfuFanoutActivated({ MOQ_SFU_FANOUT: fakeBinding() })).toBe(false);
  });
  it('false when flag is a non-"true" truthy-ish string (strict "true" only)', () => {
    expect(moqSfuFanoutActivated({ MOQ_SFU_FANOUT_ENABLED: '1', MOQ_SFU_FANOUT: fakeBinding() })).toBe(false);
    expect(moqSfuFanoutActivated({ MOQ_SFU_FANOUT_ENABLED: 'on', MOQ_SFU_FANOUT: fakeBinding() })).toBe(false);
  });
  it('true only when flag === "true" AND binding present', () => {
    expect(moqSfuFanoutActivated({ MOQ_SFU_FANOUT_ENABLED: 'true', MOQ_SFU_FANOUT: fakeBinding() })).toBe(true);
  });
});

describe('#55 handleMoqSfuFanout — INERT: honest typed 501, never fakes transport', () => {
  it('returns 501 MOQ_SFU_FANOUT_NOT_ACTIVATED when unprovisioned', async () => {
    const res = await handleMoqSfuFanout(POST(), {}, TRACK);
    expect(res.status).toBe(501);
    const body = (await res.json()) as ReturnType<typeof notActivatedBody>;
    expect(body.error).toBe('MOQ_SFU_FANOUT_NOT_ACTIVATED');
    expect(body.protocol).toBe('moq');
    expect(body.leg).toBe('moq->sfu');
    expect(body.live).toBe(false);
    expect(body.metered).toBe(false);
    expect(body.required_scope).toBe(MOQ_SFU_SCOPES.write); // POST → write
    expect(res.headers.get('retry-after')).toBe(String(MOQ_SFU_RETRY_AFTER_SECONDS));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('still 501 when the flag is flipped on but no binding (fail-closed)', async () => {
    const env: MoqSfuFanoutEnv = { MOQ_SFU_FANOUT_ENABLED: 'true' };
    const res = await handleMoqSfuFanout(POST(), env, TRACK);
    expect(res.status).toBe(501);
  });

  it('GET status read advertises moq:read in the typed 501', async () => {
    const res = await handleMoqSfuFanout(GET(), {}, TRACK);
    const body = (await res.json()) as ReturnType<typeof notActivatedBody>;
    expect(body.required_scope).toBe(MOQ_SFU_SCOPES.read);
  });

  it('never invokes the binding while inert (flag off, binding present)', async () => {
    const binding = fakeBinding();
    const res = await handleMoqSfuFanout(POST(), { MOQ_SFU_FANOUT: binding }, TRACK);
    expect(res.status).toBe(501);
    expect(binding.calls).toBe(0); // no fabricated transport — the container is never touched
  });

  it('forwards to the container ONLY when fully activated (flag + binding), threading track identity', async () => {
    const binding = fakeBinding();
    const env: MoqSfuFanoutEnv = { MOQ_SFU_FANOUT_ENABLED: 'true', MOQ_SFU_FANOUT: binding };
    const res = await handleMoqSfuFanout(POST(), env, TRACK);
    expect(binding.calls).toBe(1);
    expect(res.status).toBe(201); // the fake container's reply, proving the forward SHAPE is reached
  });
});

describe('#55 notActivatedBody — honest, machine-readable blockers', () => {
  it('lists the container-build + CF-Containers + flag blockers (no hidden magic)', () => {
    const body = notActivatedBody('POST');
    expect(body.status).toBe('not_activated');
    expect(body.blockers.length).toBeGreaterThanOrEqual(4);
    expect(body.blockers.some((b) => /container image/i.test(b))).toBe(true);
    expect(body.blockers.some((b) => /CF Containers/i.test(b))).toBe(true);
    expect(body.blockers.some((b) => /MOQ_SFU_FANOUT_ENABLED=true/i.test(b))).toBe(true);
  });
});
