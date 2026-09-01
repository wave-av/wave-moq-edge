/**
 * MoQ relay control-message dispatch fallback helper. Split out of `moq-relay.ts` (#212 file-size
 * follow-up, epic #212) once that module crossed the repo's file-size gate — a small, single-purpose
 * module in its own right (the same size class as `moq-wire-subscribe.ts`), not folded into
 * `moq-relay-filter.ts` since it is unrelated to LOCATION_FILTER resolution: it is a generic
 * best-effort Request-ID peek used only by `onControl`'s `default` case, to reply REQUEST_ERROR to a
 * request-shaped message type this relay does not implement.
 */

/** Read the first varint of a control payload (the Request ID of request-type messages), or null. */
export function readFirstVarint(payload: Uint8Array): bigint | null {
  try {
    const b0 = payload[0];
    let lead = 0;
    let probe = b0;
    while (lead < 8 && probe & 0x80) {
      lead++;
      probe = (probe << 1) & 0xff;
    }
    if (lead === 8) {
      let v = 0n;
      for (let i = 1; i <= 8; i++) v = (v << 8n) | BigInt(payload[i]);
      return v;
    }
    const n = lead + 1;
    let v = BigInt(b0 & (0xff >> n));
    for (let i = 1; i < n; i++) v = (v << 8n) | BigInt(payload[i]);
    return v;
  } catch {
    return null;
  }
}
