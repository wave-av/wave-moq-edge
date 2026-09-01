/**
 * PUBLISH_STATE_NOTIFY (draft-20 §ps-notify, type 0x22) — #212 E4.
 *
 * Grounded against the TAGGED `draft-ietf-moq-transport-20` source (moq-wg/moq-transport, fetched
 * live 2026-08-31 — not encoded from memory):
 *   https://raw.githubusercontent.com/moq-wg/moq-transport/draft-ietf-moq-transport-20/draft-ietf-moq-transport.md
 * Section anchors below (`§ps-notify`, `§message-params`, `§largest-param`, `§forward-parameter`,
 * `§location-filter`) are the draft's own kramdown anchors; the changelog entry is "Add
 * PUBLISH_STATE_NOTIFY message (#1820)" — this is a NEW message in draft-20, not a rename/move of an
 * earlier one, so it gets its own module from day one rather than growing `moq-wire.ts` further past
 * the repo's file-size gate (same reasoning `moq-wire-object.ts` / `moq-wire-fetch.ts` split out in
 * E2/E3 — see `moq-wire.ts`'s re-export comment for this file).
 *
 * Wire shape (§ps-notify, verbatim):
 *   PUBLISH_STATE_NOTIFY Message {
 *     Type (vi64) = 0x22,
 *     Length (16),
 *     Number of Parameters (vi64),
 *     Parameters (..) ...
 *   }
 * Framed like every other control message via `frameControl` (Type/Length/Body — §10). Notably there
 * is NO Request ID field on the wire: like FETCH_OK (`moq-wire-fetch.ts`), the request is implied by
 * the bidi Request stream the message rides on (§ps-notify: "A publisher sends PUBLISH_STATE_NOTIFY
 * on a subscription's bidirectional stream").
 *
 * Semantics (§ps-notify): a publisher-initiated, UNILATERAL notification — "the receiver does not
 * respond with REQUEST_OK or REQUEST_ERROR, and the message is not subject to the
 * MAX_REQUEST_UPDATES limit." It applies only to subscriptions and is sent only by the publisher; an
 * endpoint that receives one for any other request type, or from the subscriber, MUST close the
 * session with PROTOCOL_VIOLATION (session-layer enforcement — see moq-relay.ts's handler comment for
 * why this codec module does not itself decide session closure). It carries only the parameters whose
 * values CHANGED (an absent parameter means "unchanged"), and the publisher MUST include
 * LARGEST_OBJECT if known.
 *
 * Message Parameters this codec models — the draft-20 §message-params table entries that explicitly
 * list PUBLISH_STATE_NOTIFY as a message they MAY appear in (searched every "PUBLISH_STATE_NOTIFY"
 * occurrence in the tagged source; these three are the complete set):
 *   - LOCATION_FILTER (0x21, §location-filter) — length-prefixed value; the same LocationFilter type
 *     `moq-wire-fetch.ts` already defines for FETCH/FILL_PARAMETERS. "When sent in
 *     PUBLISH_STATE_NOTIFY, it reports the Location Filter now in effect at the publisher."
 *   - LARGEST_OBJECT (0x9, §largest-param) — value encoding "Location: Two consecutive varints
 *     (Group, Object)" per §message-params' Value-encoding list. NOT length-prefixed (unlike
 *     LOCATION_FILTER) — the decoder must know each parameter Type's Value shape up front, because
 *     §message-params explicitly bounds the parameter block by COUNT, not length: "Because unknown
 *     parameters cannot be skipped, the block is bounded by a parameter count rather than a length."
 *   - FORWARD (0x10, §forward-parameter) — value encoding "uint8" (also NOT length-prefixed); legal
 *     values are 0 (don't forward) or 1 (forward) — "If an endpoint receives a value outside this
 *     range, it MUST close the session with PROTOCOL_VIOLATION."
 * GROUP_ORDER (§group-order) is the other draft-20 parameter with a table entry, but its message list
 * is "SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS, or FETCH, or inside FILL_PARAMETERS" — PUBLISH_STATE_NOTIFY
 * is NOT listed, so it is correctly excluded here (an endpoint that received it "MUST close the
 * connection with a PROTOCOL_VIOLATION" per §message-params' "Parameter Scope" rule, so a strict
 * decoder deliberately does not special-case it).
 *
 * Parameters are serialized/parsed as ascending-Type-Delta-encoded pairs (§message-params, Figure 4:
 * `TypeDelta(vi64) + Value(..)`), each Value's encoding fixed by its Type (uint8 / varint / Location /
 * length-prefixed — no single generic wrapper). Per-Type dispatch below therefore differs from
 * `moq-wire-fetch.ts`'s `decodeLocationFilterOnlyParams` helper, which can get away with an
 * unconditional `bytesLP()` only because the ONE parameter type it currently decodes (LOCATION_FILTER)
 * happens to be length-prefixed; that shortcut would silently misparse LARGEST_OBJECT/FORWARD here.
 * Duplicate Parameter Types are rejected as a PROTOCOL_VIOLATION (§message-params: "Senders MUST NOT
 * repeat the same Parameter Type... Receivers SHOULD check... and close the session... if found").
 *
 * #212 phase status — CODEC SURFACE ONLY, matching this repo's established convention for landing a
 * draft-20 message type ahead of full behavioral wiring (SETUP's MAX_REQUEST_UPDATES in E1;
 * FILL_PARAMETERS in E3): encode/decode round-trip and PROTOCOL_VIOLATION detection are implemented
 * and tested; moq-relay.ts (E4) adds ONLY the minimum relay-side correctness fix this message
 * requires — accepting it silently instead of misinterpreting its leading "Number of Parameters"
 * varint as a Request ID and replying with a spurious REQUEST_ERROR (see that file's handler comment)
 * — because applying the notified LOCATION_FILTER/LARGEST_OBJECT/FORWARD state to a live subscription
 * needs per-subscription parameter state this relay's SUBSCRIBE flow does not model yet (SubscribeMsg
 * carries no Message Parameters — see moq-wire-fetch.ts's header). That lands with the rest of the
 * SUBSCRIBE parameter surface in a later uplift phase.
 *
 * WIRE-COMPAT: strictly additive. A new control message type/parameter set does not change any
 * existing message's bytes; peers that never send PUBLISH_STATE_NOTIFY (e.g. because they only
 * SUBSCRIBE and never see this relay act as a publisher toward them post-notify) are unaffected.
 */

import { Reader, Writer, MoqProtocolViolationError, frameControl, MOQ_MSG } from './moq-wire';
import { MOQ_PARAM, decodeLocationFilter, encodeLocationFilter, type LocationFilter, type MoqLocation } from './moq-wire-fetch';

/** Message Parameter type codes this module's PUBLISH_STATE_NOTIFY codec understands (§message-params
 * table entries that list PUBLISH_STATE_NOTIFY — see file header for the full grounding). */
export const PUBLISH_STATE_NOTIFY_PARAM = {
  LARGEST_OBJECT: 0x9,
  FORWARD: 0x10,
  LOCATION_FILTER: MOQ_PARAM.LOCATION_FILTER, // 0x21 — shared code/type with FETCH/FILL_PARAMETERS
} as const;

export interface PublishStateNotifyMsg {
  /** LARGEST_OBJECT (0x9, §largest-param) — the largest Location the publisher has observed. Absent
   * means "unchanged" per §ps-notify (or "nothing published/received yet" in other host messages). */
  largestObject?: MoqLocation;
  /** FORWARD (0x10, §forward-parameter) — Forwarding State now in effect at the publisher. 0 = don't
   * forward, 1 = forward. Absent means "unchanged" (§forward-parameter's PUBLISH_STATE_NOTIFY carve-out). */
  forward?: 0 | 1;
  /** LOCATION_FILTER (0x21, §location-filter) — the Location Filter now in effect at the publisher.
   * Absent means "unchanged" (§location-filter's PUBLISH_STATE_NOTIFY carve-out). */
  locationFilter?: LocationFilter;
}

/** Encode a PUBLISH_STATE_NOTIFY message. Only the parameters present on `m` are emitted — an absent
 * field means "unchanged" per §ps-notify, never a wire-level default. Parameters are emitted in
 * ascending Type order with delta-encoded Types (§message-params), independent of field order on `m`. */
export function encodePublishStateNotify(m: PublishStateNotifyMsg): Uint8Array {
  const params: Array<[number, Uint8Array]> = [];
  if (m.largestObject !== undefined) {
    params.push([PUBLISH_STATE_NOTIFY_PARAM.LARGEST_OBJECT, new Writer().varint(m.largestObject.group).varint(m.largestObject.object).bytes()]);
  }
  if (m.forward !== undefined) {
    if (m.forward !== 0 && m.forward !== 1) throw new RangeError('PUBLISH_STATE_NOTIFY: forward must be 0 or 1');
    params.push([PUBLISH_STATE_NOTIFY_PARAM.FORWARD, new Writer().u8(m.forward).bytes()]);
  }
  if (m.locationFilter !== undefined) {
    params.push([PUBLISH_STATE_NOTIFY_PARAM.LOCATION_FILTER, new Writer().bytesLP(encodeLocationFilter(m.locationFilter)).bytes()]);
  }
  params.sort((a, b) => a[0] - b[0]);
  const w = new Writer().varint(params.length);
  let prevType = 0;
  for (const [type, value] of params) {
    w.varint(type - prevType).raw(value);
    prevType = type;
  }
  return frameControl(MOQ_MSG.PUBLISH_STATE_NOTIFY, w.bytes());
}

/** Decode a PUBLISH_STATE_NOTIFY message body. Throws `MoqProtocolViolationError` for an unsupported
 * Message Parameter Type (§message-params: "An endpoint that receives an unknown Message Parameter
 * MUST close the session with PROTOCOL_VIOLATION"), a repeated Parameter Type (§message-params: "MUST
 * NOT repeat the same Parameter Type"), or an out-of-range FORWARD value (§forward-parameter). */
export function decodePublishStateNotify(payload: Uint8Array): PublishStateNotifyMsg {
  const r = new Reader(payload);
  const nParams = r.varintNum();
  const out: PublishStateNotifyMsg = {};
  const seen = new Set<number>();
  let prevType = 0;
  for (let i = 0; i < nParams; i++) {
    const type = prevType + r.varintNum(); // Type Delta, ascending order per §message-params
    if (seen.has(type)) throw new MoqProtocolViolationError(`PUBLISH_STATE_NOTIFY: repeated Message Parameter type 0x${type.toString(16)}`);
    seen.add(type);
    prevType = type;
    switch (type) {
      case PUBLISH_STATE_NOTIFY_PARAM.LARGEST_OBJECT:
        out.largestObject = { group: r.varint(), object: r.varint() };
        break;
      case PUBLISH_STATE_NOTIFY_PARAM.FORWARD: {
        const v = r.u8();
        if (v !== 0 && v !== 1) throw new MoqProtocolViolationError(`PUBLISH_STATE_NOTIFY: FORWARD value out of range (0x${v.toString(16)})`);
        out.forward = v;
        break;
      }
      case PUBLISH_STATE_NOTIFY_PARAM.LOCATION_FILTER:
        out.locationFilter = decodeLocationFilter(r.bytesLP());
        break;
      default:
        throw new MoqProtocolViolationError(`PUBLISH_STATE_NOTIFY: unsupported Message Parameter type 0x${type.toString(16)}`);
    }
  }
  return out;
}
