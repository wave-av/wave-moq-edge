/**
 * TAI → MoQ group-identity mapping — E1-TAI-BRIDGE (volumetric-delivery-proof epic).
 *
 * THE PROBLEM. A frame arriving on a professional-video network (ST 2110) carries an absolute
 * timestamp disciplined to a shared PTP/TAI clock. MoQ's base object model (draft-ietf-moq-
 * transport-18 §11) carries no timestamp at all — a Group Id is an opaque, publisher-assigned
 * varint with no defined relationship to wall-clock time. Two independent senders watching the
 * SAME source (e.g. a redundant ST 2110-22 pair, or a primary/backup encoder) have no way to agree
 * on group identity without negotiating — unless the mapping from absolute time to group id is a
 * PURE, DETERMINISTIC function that both sides compute independently and get the same answer.
 *
 * THE MAPPING. `groupIdForInstant` is that pure function: given an absolute source time in TAI
 * nanoseconds and an exact frame rate (as a rational, never a rounded decimal — see WHY RATIONAL
 * below), it returns the group id both senders MUST agree on. It is:
 *   - a pure function of its two inputs — same inputs give the same output on any machine, in any
 *     process, with no shared state, no negotiation, and no wall-clock read at encode time;
 *   - computed entirely in exact BigInt arithmetic — no floating point anywhere in the hot path —
 *     so non-integer frame rates (e.g. 30000/1001 ≈ 29.97) survive without accumulated drift;
 *   - a floor-division of the frame index by nothing else: groupId IS the frame index at the given
 *     instant, i.e. group boundaries are frame boundaries. This is deliberately the simplest
 *     correct choice for E1; a coarser GOP-aligned grouping is a P2+ concern for a later phase and
 *     is out of scope here (this phase proves the timestamp bridge, not GOP structure).
 *
 * WHY RATIONAL, NOT A ROUNDED DECIMAL. Broadcast frame rates are famously NOT whole numbers
 * (29.97, 59.94, 23.976 — all NTSC-legacy 1000/1001 scalings). A frame rate carried as a rounded
 * decimal (e.g. `29.97`) is already lossy: two implementations that "round to the same 2 decimal
 * places" will still diverge over a long-enough run because the true value is 30000/1001 repeating.
 * Carrying `{ numerator: 30000n, denominator: 1001n }` and doing the whole computation in exact
 * BigInt integer arithmetic means there is no rounding step, anywhere, ever — the two independent
 * senders this phase proves against literally cannot drift from floating-point non-associativity.
 *
 * WIRE PIN. This module's property-bag codec (`st2110-timing-properties.ts`) targets
 * draft-ietf-moq-transport-19's Object Properties semantics — see PIN-DECISION.md in this
 * directory and `scripts/check-tai-mapping-draft-pin.sh` for the drift gate. The relay's own
 * negotiated ALPN (`moqt-18`, draft-18) is UNCHANGED by this phase — draft-18 already reserves the
 * SUBGROUP_HEADER PROPERTIES flag and the length-prefixed block this codec fills (see
 * `viewport-properties.ts`, which pins the same way for the same reason).
 */

/** An exact rational number — used exclusively for frame rate (frames per second). Never reduce to
 *  a float anywhere on the mapping's hot path; only convert to a float for human-readable display. */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** Construct a Rational from plain numbers/bigints, validating strict positivity. */
export function rational(numerator: number | bigint, denominator: number | bigint): Rational {
  const n = typeof numerator === 'bigint' ? numerator : BigInt(numerator);
  const d = typeof denominator === 'bigint' ? denominator : BigInt(denominator);
  if (n <= 0n) throw new RangeError(`Rational numerator must be > 0, got ${n}`);
  if (d <= 0n) throw new RangeError(`Rational denominator must be > 0, got ${d}`);
  return { numerator: n, denominator: d };
}

const NS_PER_SECOND = 1_000_000_000n;

/**
 * Derive the MoQ group id for an absolute TAI instant, given the exact frame rate in effect at
 * that instant.
 *
 * PURE FUNCTION CONTRACT: no globals, no Date.now(), no I/O, no randomness. Two calls with
 * identical (taiNs, frameRate) values — in different processes, on different machines, at
 * different wall-clock times — MUST return the identical bigint. This is the entire basis of the
 * P3 two-independent-senders determinism proof.
 *
 * MATH: groupId = floor(taiNs * frameRate.numerator / (frameRate.denominator * 1e9))
 *              = floor(taiNs [seconds, exact] * frameRate [frames/second, exact])
 * Computed as one BigInt multiply-then-divide (never a two-step divide-then-multiply, which would
 * introduce truncation error before the final floor). BigInt division truncates toward zero; since
 * both operands are non-negative here that is exactly floor().
 *
 * BOUNDARY CASE — a frame exactly on a period boundary. If taiNs is an EXACT multiple of the frame
 * period (period = denominator * 1e9 / numerator seconds, exactly, when it divides evenly), the
 * result lands exactly on the integer group id with no off-by-one: e.g. at 30 fps (30/1) the
 * period is exactly 1/30 s = 33_333_333.33... ns — NOT integral — so "exact boundary" for a
 * non-integer-ns period is defined as the numerator-domain boundary (taiNs * num is an exact
 * multiple of den * 1e9), which the BigInt math resolves exactly, unlike a float period computed
 * as `1e9 * den / num` first and compared with tolerance.
 */
export function groupIdForInstant(taiNs: bigint, frameRate: Rational): bigint {
  if (taiNs < 0n) throw new RangeError(`taiNs must be non-negative, got ${taiNs}`);
  if (frameRate.numerator <= 0n || frameRate.denominator <= 0n) {
    throw new RangeError('frameRate must be strictly positive');
  }
  return (taiNs * frameRate.numerator) / (frameRate.denominator * NS_PER_SECOND);
}

/**
 * The exact frame period, in nanoseconds, as a Rational (never collapsed to a float). Useful for
 * property-bag round-trips and for computing the TAI instant that begins a given group id.
 */
export function framePeriodNs(frameRate: Rational): Rational {
  return { numerator: frameRate.denominator * NS_PER_SECOND, denominator: frameRate.numerator };
}

/**
 * Inverse of `groupIdForInstant`: the TAI instant (ns) at which the given group id BEGINS, i.e.
 * the smallest taiNs for which `groupIdForInstant(taiNs, frameRate) === groupId`. Exact BigInt
 * ceil-free floor-domain inverse — used by tests to assert the boundary round-trips exactly.
 */
export function instantForGroupStart(groupId: bigint, frameRate: Rational): bigint {
  if (groupId < 0n) throw new RangeError(`groupId must be non-negative, got ${groupId}`);
  const period = framePeriodNs(frameRate);
  // taiNs = ceil(groupId * period) in the exact rational sense: smallest integer taiNs such that
  // floor(taiNs * num / (den * 1e9)) === groupId. Since period = den*1e9/num exactly,
  // taiNs_min = ceil(groupId * den * 1e9 / num) computed as an exact BigInt ceiling division.
  const numAll = groupId * period.numerator;
  const denAll = period.denominator;
  const q = numAll / denAll;
  const r = numAll % denAll;
  return r === 0n ? q : q + 1n;
}

/** One media-clock (RTP-style) sample-domain timestamp derived from an exact frame count and rate,
 *  for carrying alongside TAI time in the property bag (ST 2110 media clock, not TAI). Kept as a
 *  pure exact computation for the same reason as the group id. */
export function mediaClockValue(frameIndex: bigint, mediaClockRateHz: bigint, frameRate: Rational): bigint {
  if (mediaClockRateHz <= 0n) throw new RangeError('mediaClockRateHz must be > 0');
  // ticks = frameIndex * (mediaClockRateHz / frameRate) = frameIndex * mediaClockRateHz * den / num
  const num = frameIndex * mediaClockRateHz * frameRate.denominator;
  return num / frameRate.numerator;
}
