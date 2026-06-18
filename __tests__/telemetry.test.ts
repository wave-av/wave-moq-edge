import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { emitMoqSessionSpan, captureMoqError } from '../telemetry';
import { __setFetchImpl } from '../otlp-trace';

const DIMS = { sessionMs: 120_000, bytes: 1_000_000, frames: 300, reconnects: 1, status: 'ok' as const };

describe('B.4 moq session telemetry — OTLP export (https-only, default-OFF, no-PII)', () => {
  const calls: Array<{ url: string; body: string }> = [];
  beforeEach(() => {
    calls.length = 0;
    __setFetchImpl((url, init) => {
      calls.push({ url, body: init.body });
      return Promise.resolve({ ok: true });
    });
  });
  afterEach(() => __setFetchImpl(null));

  it('default-OFF (no endpoint) and non-https are both no-ops', async () => {
    await emitMoqSessionSpan({}, DIMS);
    await emitMoqSessionSpan({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://insecure.example' }, DIMS);
    expect(calls.length).toBe(0);
  });

  it('POSTs ONE session span to <endpoint>/v1/traces with the aggregate metrics, over https', async () => {
    await emitMoqSessionSpan({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/' }, DIMS);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://otlp.example/v1/traces');
    const body = calls[0].body;
    expect(body).toContain('moq.session');
    expect(body).toContain('wave.moq.bytes');
    expect(body).toContain('wave.moq.duration_ms');
    expect(body).toContain('1000000'); // the bytes aggregate is present
  });

  it('NEVER leaks org / track key / sessionId (CWE-200) — only aggregates leave the worker', async () => {
    await emitMoqSessionSpan({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example' }, DIMS);
    expect(calls[0].body).not.toMatch(/\borg\b|trackKey|track_key|sessionId|session_id|namespace|wave\/cam/i);
  });

  it('is fail-soft: never throws even on a hostile transport', async () => {
    __setFetchImpl(() => {
      throw new Error('network boom');
    });
    await expect(emitMoqSessionSpan({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example' }, DIMS)).resolves.toBeUndefined();
    await expect(captureMoqError({ OPS_WEBHOOK_URL: 'https://ops.example' }, new Error('x'), 'relay')).resolves.toBeUndefined();
  });
});
