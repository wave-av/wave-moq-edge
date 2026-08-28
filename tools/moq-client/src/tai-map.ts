/**
 * `tai-map` verb logic — E1-TAI-BRIDGE toolization (E5-INTERNAL-TOOLIZE phase). Thin wrapper
 * around the pure `groupIdForInstant` mapping from `src/tai-group-mapping.ts`, shared between the
 * CLI verb (`cli.ts`) and the MCP tool (`mcp.ts`) so neither reimplements the arithmetic — both
 * call this one function, which itself calls only the E1-proven pure mapping. No network, no I/O.
 */
import {
  groupIdForInstant,
  framePeriodNs,
  instantForGroupStart,
  mediaClockValue,
  rational,
  type Rational,
} from '../../../src/tai-group-mapping.ts';
import { encodeSt2110TimingProperties } from '../../../src/st2110-timing-properties.ts';

export interface TaiMapInput {
  taiNs: bigint;
  rate: Rational;
  frameIndex?: bigint;
  mediaClockRateHz?: bigint;
}

export interface TaiMapReport {
  taiNs: string;
  frameRate: { numerator: string; denominator: string };
  groupId: string;
  framePeriodNs: { numerator: string; denominator: string };
  groupStartTaiNs: string;
  mediaClockValue?: string;
  propertyBagBytes: number;
}

/** Parse `--rate=30000/1001` (or a bare integer, `--rate=30`) into a Rational. Throws on malformed
 *  input rather than silently defaulting, so a CLI/MCP typo fails loudly. */
export function parseRateFlag(raw: string | undefined): Rational {
  if (!raw) return rational(30, 1);
  const [numStr, denStr] = raw.split('/');
  const num = Number(numStr);
  const den = denStr !== undefined ? Number(denStr) : 1;
  if (!Number.isFinite(num) || !Number.isFinite(den)) {
    throw new RangeError(`malformed --rate value ${JSON.stringify(raw)}; expected NUM or NUM/DEN`);
  }
  return rational(num, den);
}

/** Compute the full tai-map report: group id, inverse round-trip check, optional media clock
 *  value, and the property-bag byte length that would carry this timing on a real MoQ object. */
export function taiMap(input: TaiMapInput): TaiMapReport {
  const groupId = groupIdForInstant(input.taiNs, input.rate);
  const period = framePeriodNs(input.rate);
  const groupStart = instantForGroupStart(groupId, input.rate);
  const clockValue =
    input.frameIndex !== undefined
      ? mediaClockValue(input.frameIndex, input.mediaClockRateHz ?? 90_000n, input.rate)
      : undefined;
  const bag = encodeSt2110TimingProperties({
    sourceTaiNs: input.taiNs,
    frameRate: input.rate,
    mediaClockValue: clockValue,
  });
  return {
    taiNs: input.taiNs.toString(),
    frameRate: { numerator: input.rate.numerator.toString(), denominator: input.rate.denominator.toString() },
    groupId: groupId.toString(),
    framePeriodNs: { numerator: period.numerator.toString(), denominator: period.denominator.toString() },
    groupStartTaiNs: groupStart.toString(),
    mediaClockValue: clockValue?.toString(),
    propertyBagBytes: bag.length,
  };
}

export function formatTaiMapReport(r: TaiMapReport): string {
  const rate = `${r.frameRate.numerator}/${r.frameRate.denominator}`;
  const lines = [
    `tai-map`,
    `  taiNs            ${r.taiNs}`,
    `  frameRate        ${rate}`,
    `  groupId          ${r.groupId}`,
    `  framePeriodNs    ${r.framePeriodNs.numerator}/${r.framePeriodNs.denominator}`,
    `  groupStartTaiNs  ${r.groupStartTaiNs}  (round-trip via instantForGroupStart)`,
  ];
  if (r.mediaClockValue !== undefined) lines.push(`  mediaClockValue  ${r.mediaClockValue}`);
  lines.push(`  propertyBagBytes ${r.propertyBagBytes}`);
  return `${lines.join('\n')}\n`;
}
