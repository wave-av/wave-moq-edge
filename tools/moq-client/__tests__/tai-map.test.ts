/**
 * Unit tests for `tools/moq-client/src/tai-map.ts` — the shared logic behind the CLI's `tai-map`
 * verb and the MCP `tai_map` tool (E5-INTERNAL-TOOLIZE, exercising E1-TAI-BRIDGE's proven mapping
 * through both internal faces without reimplementing it).
 */
import { describe, expect, it } from 'vitest';
import { taiMap, parseRateFlag, formatTaiMapReport } from '../src/tai-map.ts';
import { groupIdForInstant, rational } from '../../../src/tai-group-mapping.ts';

describe('parseRateFlag', () => {
  it('parses NUM/DEN', () => {
    const r = parseRateFlag('30000/1001');
    expect(r.numerator).toBe(30000n);
    expect(r.denominator).toBe(1001n);
  });

  it('parses a bare integer as NUM/1', () => {
    const r = parseRateFlag('30');
    expect(r.numerator).toBe(30n);
    expect(r.denominator).toBe(1n);
  });

  it('defaults to 30/1 when unset', () => {
    const r = parseRateFlag(undefined);
    expect(r.numerator).toBe(30n);
    expect(r.denominator).toBe(1n);
  });

  it('throws on malformed input', () => {
    expect(() => parseRateFlag('not-a-rate')).toThrow(/malformed --rate/);
  });
});

describe('taiMap', () => {
  it('is a pure function: identical inputs give identical output, called twice', () => {
    const input = { taiNs: 1_893_456_789_000_000_000n, rate: rational(30000, 1001) };
    expect(taiMap(input)).toEqual(taiMap(input));
  });

  it('groupId matches the underlying E1-proven groupIdForInstant directly — no drift from the wrapper', () => {
    const taiNs = 1_893_456_789_000_000_000n;
    const rate = rational(30000, 1001);
    const report = taiMap({ taiNs, rate });
    expect(report.groupId).toBe(groupIdForInstant(taiNs, rate).toString());
  });

  it('includes mediaClockValue only when frameIndex is provided', () => {
    const taiNs = 0n;
    const rate = rational(30, 1);
    expect(taiMap({ taiNs, rate }).mediaClockValue).toBeUndefined();
    expect(taiMap({ taiNs, rate, frameIndex: 10n }).mediaClockValue).toBeDefined();
  });

  it('the property bag is non-empty whenever sourceTaiNs + frameRate are present', () => {
    const report = taiMap({ taiNs: 5n, rate: rational(25, 1) });
    expect(report.propertyBagBytes).toBeGreaterThan(0);
  });

  it('formatTaiMapReport renders every field of a full report', () => {
    const report = taiMap({ taiNs: 1_000_000_000n, rate: rational(30000, 1001), frameIndex: 1n });
    const text = formatTaiMapReport(report);
    expect(text).toContain('groupId');
    expect(text).toContain(report.groupId);
    expect(text).toContain('mediaClockValue');
  });
});
