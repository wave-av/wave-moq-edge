/**
 * REQUEST_UPDATE (draft-20 §message-request-update, type 0x2) — #212 E6, the FINAL serial phase of
 * the draft-18→draft-20 relay-side uplift epic. Landing this completes the E0-E6 chain (E0/E1 #219,
 * E2 #220, E3 #221, E4 #222, E5 #223).
 *
 * Grounded against the TAGGED `draft-ietf-moq-transport-20` source (moq-wg/moq-transport, fetched
 * live 2026-08-31 — not encoded from memory, same fetch E3/E4/E5 grounded against, 6079 lines):
 *   https://raw.githubusercontent.com/moq-wg/moq-transport/draft-ietf-moq-transport-20/draft-ietf-moq-transport.md
 *
 * DISCREPANCY vs the phase brief: the brief frames REQUEST_UPDATE as "the unified control message
 * ... supersedes the older SUBSCRIBE_UPDATE/FETCH-update shapes" and asks whether it "carries a
 * Request ID". It does — but that Request ID is a NEW Request ID this message itself CONSUMES
 * (§request-id: "Each SUBSCRIBE, PUBLISH, FETCH, ..., REQUEST_UPDATE, and TRACK_STATUS message
 * consumes a Request ID"), not a back-reference to the ORIGINAL SUBSCRIBE's Request ID. Correlation
 * to the request being updated is instead implicit in WHICH bidi request stream the REQUEST_UPDATE
 * rides on (§message-request-update: "a REQUEST_UPDATE on the same bidi stream as the request"). This
 * relay has no true per-request bidi stream (single CF Workers WebSocket, one control channel per
 * session — see moq-wire.ts's header) and is already one-subscription-per-session (moq-relay.ts's
 * `subscribers` Map keys on sessionId, matching the E5/E4 precedent), so "same stream" maps onto
 * "same session": a REQUEST_UPDATE from a session updates THAT session's live subscription, and the
 * message's OWN (new) Request ID is only echoed back in the REQUEST_OK/REQUEST_ERROR reply — exactly
 * the convention already used for SUBSCRIBE_NAMESPACE/PUBLISH/PUBLISH_NAMESPACE acks in moq-wire.ts.
 * This is the SAME class of transport-adaptation discrepancy E4 (PUBLISH_STATE_NOTIFY has no Request
 * ID field at all, correlated by "the subscription's bidi stream") and E5 (SUBSCRIBE's brief-assumed
 * "Filter Type enum" doesn't exist in -20) each found — not encoded from memory, verified against the
 * live spec text.
 *
 * Wire shape (§message-request-update, verbatim):
 *   REQUEST_UPDATE Message {
 *     Type (vi64) = 0x2,
 *     Length (16),
 *     Request ID (vi64),
 *     Number of Parameters (vi64),
 *     Parameters (..) ...
 *   }
 * Generic — REQUEST_UPDATE carries NO dedicated fields beyond Request ID; every updatable attribute
 * (Location Filter, Forward State, Fill Parameters, Track Namespace Prefix, ...) rides the SAME
 * Message Parameters block every other request message uses (§message-params). "If a parameter
 * previously set on the request is not present in REQUEST_UPDATE, its value remains unchanged.
 * There is no mechanism to remove a parameter from a request" — EXCEPT LOCATION_FILTER specifically,
 * which is length-prefixed and has its own explicit removal escape hatch: "Length (in bytes)
 * determines how many optional vi64 fields are present. A length of 0 indicates no filter, for
 * example to remove the filter in REQUEST_UPDATE" (§location-filters). So for this codec:
 *   - `locationFilter: undefined` on `RequestUpdateMsg` ⇒ the LOCATION_FILTER parameter is OMITTED
 *     from the wire ⇒ receiver leaves the subscription's current filter unchanged.
 *   - `locationFilter: {}` (all four fields undefined) ⇒ the parameter IS present with Length=0 ⇒
 *     receiver REMOVES the filter (subscription becomes unfiltered/whole-track).
 *   - `locationFilter: {startGroup, ...}` ⇒ the parameter is present non-empty ⇒ "non-zero replaces
 *     it entirely" — the ENTIRE filter is replaced, not merged field-by-field.
 * This three-way distinction is exactly what `moq-wire-fetch.ts`'s `LocationFilter` type already
 * supports (`{}` vs `undefined` are already distinguishable there) — no new type needed.
 *
 * Message Parameters this codec models — searched every "REQUEST_UPDATE" occurrence in the tagged
 * source for parameters whose table entry explicitly lists REQUEST_UPDATE as a message they MAY
 * appear in, scoped (per this phase brief) to the two the volumetric/6DoF per-viewport use case
 * needs, reusing E4/E5's existing codec rather than duplicating it:
 *   - LOCATION_FILTER (0x21, §location-filter) — "MAY appear in a FETCH, SUBSCRIBE, PUBLISH,
 *     REQUEST_UPDATE (for a subscription) or PUBLISH_STATE_NOTIFY message." Reuses the LocationFilter
 *     type/encodeLocationFilter/decodeLocationFilter trio from `moq-wire-fetch.ts` (E3) UNCHANGED —
 *     this is the SAME wire shape/semantics `moq-wire-subscribe.ts` (E5) already wires onto SUBSCRIBE.
 *   - FORWARD (0x10, §forward-parameter) — "MAY appear in SUBSCRIBE, REQUEST_UPDATE (for a
 *     subscription or a SUBSCRIBE_TRACKS request), PUBLISH, SUBSCRIBE_TRACKS and
 *     PUBLISH_STATE_NOTIFY. ... allowed values are 0 (don't forward) or 1 (forward)." Reuses the
 *     SAME 0x10 code / uint8 Value shape `moq-wire-publish.ts`'s PUBLISH_STATE_NOTIFY codec (E4)
 *     already defines — not re-minted here.
 * Other REQUEST_UPDATE-eligible parameters this codec does NOT model (matching the established
 * "relay-relevant subset" convention every prior phase used — PUBLISH_STATE_NOTIFY (E4) modeled 3 of
 * its table's params, moq-wire-fetch.ts's FILL_PARAMETERS models 1 of its table's 8):
 *   - FILL_PARAMETERS (0x23) — opens a new fill-fetch stream; this relay has never wired fill-fetch
 *     stream BEHAVIOR (FILL_PARAMETERS has been codec-surface-only on SUBSCRIBE since E3 — see
 *     moq-wire-fetch.ts's header). Out of scope here for the identical reason.
 *   - TRACK_NAMESPACE_PREFIX (§updating-namespace-subscriptions) — applies to SUBSCRIBE_NAMESPACE/
 *     SUBSCRIBE_TRACKS updates, not subscription (SUBSCRIBE) updates; this relay's SUBSCRIBE_NAMESPACE
 *     handling is a one-shot ack (moq-relay.ts) with no per-subscription-prefix state to update.
 *   - AUTHORIZATION_TOKEN, SUBGROUP_DELIVERY_TIMEOUT, OBJECT_DELIVERY_TIMEOUT, EXPIRES — none of these
 *     are modeled ANYWHERE in this codec yet (not on SUBSCRIBE, not on PUBLISH_STATE_NOTIFY); adding
 *     them only to REQUEST_UPDATE would be new relay-behavioral scope this phase does not ask for.
 * A REQUEST_UPDATE carrying any OTHER Message Parameter Type is rejected as a PROTOCOL_VIOLATION
 * (§message-params: "an endpoint that receives an unknown Message Parameter MUST close the session"),
 * matching `decodePublishStateNotify`'s and `decodeLocationFilterOnlyParams`'s existing strictness.
 *
 * Parameters are ascending-Type-Delta-encoded pairs (§message-params Figure 4), each Value's encoding
 * fixed by its Type (LOCATION_FILTER length-prefixed, FORWARD raw uint8) — same per-Type dispatch
 * `moq-wire-publish.ts` uses (not the single-type `bytesLP()` shortcut `decodeLocationFilterOnlyParams`
 * gets away with, since that helper only ever decodes ONE parameter type). Duplicate Parameter Types
 * are rejected as a PROTOCOL_VIOLATION (§message-params).
 *
 * REQUEST_UPDATE's response is a REQUEST_OK/REQUEST_ERROR (the spec calls this "REQUEST_UPDATE_OK" as
 * shorthand, §message-request-ok: "This document uses the shorthand ... REQUEST_UPDATE_OK ... to
 * refer to a REQUEST_OK sent in response to the corresponding request type" — it is NOT a distinct
 * wire type). This module does not add a new encode/decode pair for it: `moq-wire.ts`'s existing
 * `encodeRequestOk`/`decodeRequestOk` (MOQ_MSG.REQUEST_OK = 0x7) already serves every other request
 * type's ack (PUBLISH_OK, PUBLISH_NAMESPACE_OK, SUBSCRIBE_NAMESPACE_OK) and is reused unchanged here —
 * see moq-relay.ts's REQUEST_UPDATE handler.
 *
 * #212 phase status: this is the FIRST phase to wire REQUEST_UPDATE relay BEHAVIOR (not just codec
 * surface) — moq-relay.ts applies the decoded FORWARD/LOCATION_FILTER to the live subscription's
 * state so subsequent fan-out is filtered by the NEW range/forwarding state (the mid-stream
 * viewport-update payoff this whole epic exists for). NOT modeled: MAX_REQUEST_UPDATES credit
 * enforcement / TOO_MANY_REQUEST_UPDATES session termination (§max-request-updates) — this relay has
 * no per-request-stream outstanding-update counter to enforce it against (no true per-request bidi
 * streams on the WS transport; SETUP's MAX_REQUEST_UPDATES option has been codec-surface-only since
 * E1 — see moq-wire.ts's SetupMsg doc). Left for a future phase, same as every prior "surface now,
 * behavior later" split this epic used.
 *
 * WIRE-COMPAT: additive. REQUEST_UPDATE (type 0x2) was already reserved as a constant in
 * `moq-wire.ts`'s MOQ_MSG table since E1 but had no encode/decode pair or relay handler — sending one
 * to a pre-E6 relay fell through `onControl`'s `default` case, which replies REQUEST_ERROR(NOT_SUPPORTED)
 * using the first-varint-as-requestId heuristic (`readFirstVarint`); post-E6 it is handled properly.
 * No existing message's bytes change.
 */

import { Reader, Writer, MoqProtocolViolationError, frameControl, MOQ_MSG } from './moq-wire.ts';
import { MOQ_PARAM, decodeLocationFilter, encodeLocationFilter, type LocationFilter } from './moq-wire-fetch.ts';
import { PUBLISH_STATE_NOTIFY_PARAM } from './moq-wire-publish.ts';

/** Message Parameter type codes this module's REQUEST_UPDATE codec understands — reused UNCHANGED
 * from the modules that already mint them (see file header for why no new codes are minted here). */
export const REQUEST_UPDATE_PARAM = {
  FORWARD: PUBLISH_STATE_NOTIFY_PARAM.FORWARD, // 0x10 — shared code with PUBLISH_STATE_NOTIFY (E4)
  LOCATION_FILTER: MOQ_PARAM.LOCATION_FILTER, // 0x21 — shared code with FETCH/SUBSCRIBE/PUBLISH_STATE_NOTIFY
} as const;

export interface RequestUpdateMsg {
  /** This message's OWN Request ID (§request-id: REQUEST_UPDATE consumes a new one) — NOT the
   * original SUBSCRIBE's Request ID. See file header discrepancy note for how this relay correlates
   * "which subscription" without a per-request bidi stream to key on. */
  requestId: bigint;
  /** LOCATION_FILTER (0x21) — omitted ⇒ unchanged; `{}` (all fields undefined) ⇒ explicit remove
   * (subscription becomes unfiltered); any other value ⇒ replaces the current filter ENTIRELY (never
   * merged field-by-field) per §location-filters / §message-request-update. */
  locationFilter?: LocationFilter;
  /** FORWARD (0x10) — Forwarding State to apply; omitted ⇒ unchanged. 0 = don't forward, 1 = forward. */
  forward?: 0 | 1;
}

// REQUEST_UPDATE (§message-request-update, 0x2): RequestId(i) + Params(0..2, ascending Type order).
export function encodeRequestUpdate(m: RequestUpdateMsg): Uint8Array {
  const params: Array<[number, Uint8Array]> = [];
  if (m.forward !== undefined) {
    if (m.forward !== 0 && m.forward !== 1) throw new RangeError('REQUEST_UPDATE: forward must be 0 or 1');
    params.push([REQUEST_UPDATE_PARAM.FORWARD, new Writer().u8(m.forward).bytes()]);
  }
  if (m.locationFilter !== undefined) {
    params.push([REQUEST_UPDATE_PARAM.LOCATION_FILTER, new Writer().bytesLP(encodeLocationFilter(m.locationFilter)).bytes()]);
  }
  params.sort((a, b) => a[0] - b[0]);
  const w = new Writer().varint(m.requestId).varint(params.length);
  let prevType = 0;
  for (const [type, value] of params) {
    w.varint(type - prevType).raw(value);
    prevType = type;
  }
  return frameControl(MOQ_MSG.REQUEST_UPDATE, w.bytes());
}

/** Decode a REQUEST_UPDATE message body. Throws `MoqProtocolViolationError` for an unsupported
 * Message Parameter Type, a repeated Parameter Type, or an out-of-range FORWARD value — matching
 * `decodePublishStateNotify`'s strictness (same per-Type-dispatch shape). */
export function decodeRequestUpdate(payload: Uint8Array): RequestUpdateMsg {
  const r = new Reader(payload);
  const requestId = r.varint();
  const nParams = r.varintNum();
  const out: RequestUpdateMsg = { requestId };
  const seen = new Set<number>();
  let prevType = 0;
  for (let i = 0; i < nParams; i++) {
    const type = prevType + r.varintNum(); // Type Delta, ascending order per §message-params
    if (seen.has(type)) throw new MoqProtocolViolationError(`REQUEST_UPDATE: repeated Message Parameter type 0x${type.toString(16)}`);
    seen.add(type);
    prevType = type;
    switch (type) {
      case REQUEST_UPDATE_PARAM.FORWARD: {
        const v = r.u8();
        if (v !== 0 && v !== 1) throw new MoqProtocolViolationError(`REQUEST_UPDATE: FORWARD value out of range (0x${v.toString(16)})`);
        out.forward = v;
        break;
      }
      case REQUEST_UPDATE_PARAM.LOCATION_FILTER:
        out.locationFilter = decodeLocationFilter(r.bytesLP());
        break;
      default:
        throw new MoqProtocolViolationError(`REQUEST_UPDATE: unsupported Message Parameter type 0x${type.toString(16)}`);
    }
  }
  return out;
}
