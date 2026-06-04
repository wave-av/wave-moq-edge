import { describe, it, expect } from 'vitest';
import { newUsage, usageJson, edgeClock, WaveUsage } from '../src/wave-usage';
import { MetricsCollector, MoqMetric } from '../metrics-collector';

// Minimal Env stub — MetricsCollector only touches env behind `void this.env`.
const env = { MOQ_TRACK_REGISTRY: {} as any, ENVIRONMENT: 'test', MOQ_DRAFT_VERSION: 'draft-17' };

const ev = (kind: MoqMetric['kind'], trackKey: string, bytes?: number): MoqMetric => ({
  ts: '2026-06-04T00:00:00.000Z',
  kind,
  trackKey,
  sessionId: 's1',
  bytes,
});

describe('wave-usage R4 schema (mirror of engine/wave-media-adapter.h)', () => {
  it('newUsage zeroes every field and stamps the edge clock', () => {
    const u = newUsage('moq', 'out');
    expect(u.protocol).toBe('moq');
    expect(u.direction).toBe('out');
    expect(u.frames).toBe(0);
    expect(u.bytes).toBe(0);
    expect(u.res).toBe('0x0');
    expect(u.integrity).toEqual({ checked: 0, matches: 0, mismatches: 0, reorders: 0, gaps: 0 });
    expect(u.clock).toEqual({ source: 'edge', offset_ns: 0, locked: true, gm: '' });
  });

  it('usageJson carries the exact engine field set and nesting', () => {
    const parsed = JSON.parse(usageJson(newUsage('moq', 'out')));
    expect(Object.keys(parsed)).toEqual([
      'protocol', 'direction', 'frames', 'bytes', 'fps', 'audio_samples', 'sample_rate',
      'channels', 'av_drift_ms', 'reconnects', 'rate_n', 'rate_d', 'res', 'integrity', 'clock',
    ]);
    expect(Object.keys(parsed.integrity)).toEqual(['checked', 'matches', 'mismatches', 'reorders', 'gaps']);
    expect(Object.keys(parsed.clock)).toEqual(['source', 'offset_ns', 'locked', 'gm']);
  });

  it('edgeClock reports NTP-disciplined edge time (no PTP at the edge)', () => {
    expect(edgeClock()).toEqual({ source: 'edge', offset_ns: 0, locked: true, gm: '' });
  });
});

describe('MetricsCollector folds MoQ events into the R4 meter', () => {
  it('counts objects as frames+bytes with intact integrity', async () => {
    const mc = new MetricsCollector(env);
    await mc.record(ev('object_received', 'ns/track', 1200));
    await mc.record(ev('object_received', 'ns/track', 800));
    await mc.record(ev('group_complete', 'ns/track'));
    const u: WaveUsage = mc.usage('ns/track');
    expect(u.frames).toBe(2);
    expect(u.bytes).toBe(2000);
    expect(u.integrity.checked).toBe(2);
    expect(u.integrity.matches).toBe(2);
    expect(u.integrity.mismatches).toBe(0);
  });

  it('republish onto a track that already carried media counts a reconnect', async () => {
    const mc = new MetricsCollector(env);
    await mc.record(ev('publish_start', 'ns/t')); // first publisher — no reconnect
    await mc.record(ev('object_received', 'ns/t', 10));
    await mc.record(ev('publish_start', 'ns/t')); // republish after media flowed
    expect(mc.usage('ns/t').reconnects).toBe(1);
  });

  it('keeps separate meters per track key', async () => {
    const mc = new MetricsCollector(env);
    await mc.record(ev('object_received', 'a', 5));
    await mc.record(ev('object_received', 'b', 7));
    expect(mc.usage('a').bytes).toBe(5);
    expect(mc.usage('b').bytes).toBe(7);
  });

  it('unknown track returns a zeroed meter (never throws)', () => {
    const mc = new MetricsCollector(env);
    expect(mc.usage('nope').frames).toBe(0);
    expect(() => JSON.parse(mc.usageLine('nope'))).not.toThrow();
  });
});
