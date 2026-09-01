/**
 * MoQ Transport FETCH + Location/Fill filtering (draft-20 §10.13 FETCH, §10.14 FETCH_OK, §5.1.2
 * Location Filters, §5.1.3 Fill Semantics, §10.2.9 LOCATION_FILTER Parameter, §10.2.15 FILL_PARAMETERS
 * Parameter). Split out of `moq-wire.ts` (#212 E3) once the wire-codec module crossed the repo's
 * file-size gate (same reason `moq-wire-object.ts` split out in E2); re-exported from `moq-wire.ts`
 * (`export * from './moq-wire-fetch'`) so every existing `from './moq-wire'` import keeps working
 * unchanged. This file is additive plumbing on the split, not a behavior change on its own — the E3
 * behavior change is the FETCH wire-format break documented below.
 *
 * #212 E3 (draft-19 → draft-20 changelog #1673, #1809 — "Replace Joining FETCH with fill fetch
 * streams" / "Restructure the Location Filter"):
 *   - FETCH drops its FetchType field and the STANDALONE/RELATIVE_JOINING/ABSOLUTE_JOINING variant
 *     entirely — "Remove the Joining variant of FETCH and the 'standalone' moniker" (#1673). FETCH is
 *     now unconditionally RequestId(i) + TrackNamespace(tuple) + TrackName(strLP) + Parameters, with
 *     the requested range carried as an OPTIONAL LOCATION_FILTER Message Parameter (0x21) rather than
 *     inline message fields (#1809) — an omitted filter now means "whole track" instead of requiring
 *     an explicit {0,0}..Largest-Object range.
 *   - The historical-replay use case Joining FETCH served (catch a late subscriber up before live
 *     delivery) moves to FILL_PARAMETERS (0x23): its presence on a SUBSCRIBE/REQUEST_UPDATE asks the
 *     publisher to open a separate *fill fetch stream* delivering the backfill range without gating
 *     the subscription's own live delivery on it (§5.1.3). `moq-wire.ts`'s SubscribeMsg does not model
 *     ANY Message Parameters yet (see decodeSubscribe — SUBSCRIBE_OK/SUBSCRIBE round-trip is param-
 *     free today), so FILL_PARAMETERS below is CODEC SURFACE ONLY in this phase: it round-trips the
 *     wire shape, but no fill-fetch-stream behavior is wired into moq-relay.ts. That lands with the
 *     rest of the SUBSCRIBE parameter surface in a later uplift phase (matches the established
 *     "codec surface only" pattern used for SETUP's MAX_REQUEST_UPDATES in E1). moq-relay.ts's
 *     existing FETCH-from-cache path (`onFetch`) already serves the historical-replay role for the
 *     "joining" case this draft retires — see that file for the simplified handler.
 *   - THIS IS A WIRE-COMPAT BREAK on the FETCH request path (message shape changed; old joining-typed
 *     FETCH frames no longer parse). No deployed peer speaks the old shape outside this repo (relay +
 *     moq-client ship together — see moq-wire.ts header), so there is no cross-version negotiation to
 *     preserve.
 */

import { Reader, Writer, MoqProtocolViolationError, frameControl } from './moq-wire';
import { MOQ_MSG } from './moq-wire';

/**
 * Message Parameter type codes (draft-20 §10.2) this module's FETCH/FILL_PARAMETERS codec
 * understands. Both use the shared "Message Parameter" wire shape (§10.2, Figure 4): ascending-order
 * TypeDelta(vi64) + Value(..); for these two, Value is itself length-prefixed (Length(vi64) + bytes).
 */
export const MOQ_PARAM = {
  LOCATION_FILTER: 0x21,
  FILL_PARAMETERS: 0x23,
} as const;

/** A Group/Object location pair (§location). */
export interface MoqLocation {
  group: bigint;
  object: bigint;
}

/**
 * Location Filter (§5.1.2) — the optional-field range selector carried as the LOCATION_FILTER
 * Message Parameter (0x21, §10.2.9). Fields are POSITIONAL and length-determined: only a contiguous
 * 0/1/2/3/4-field prefix is legal — [], [startGroup], [startGroup, startObject], [startGroup,
 * startObject, endGroupDelta], or all four. The 1-field form, and the 2-field form with both fields
 * literally 0, carry RELATIVE-to-Largest-Object semantics ("N groups back" / "Next Object"); every
 * other combination is absolute, with EndGroupDelta delta-encoded from StartGroup. `endObject`
 * omitted (3-field form) means "the whole End Group". This type/codec models the wire shape only —
 * resolving the relative forms against a Largest Object is caller (relay) responsibility; see
 * `moq-relay.ts`'s `onFetch`, which supports the absolute forms and rejects the relative ones as
 * NOT_SUPPORTED (this relay's bounded per-track cache does not track Largest Object independently).
 */
export interface LocationFilter {
  startGroup?: bigint;
  startObject?: bigint;
  endGroupDelta?: bigint;
  endObject?: bigint;
}

/** Encode a LOCATION_FILTER Parameter Value: the positional-prefix optional-field body (no Length —
 * callers wrap this in `bytesLP` as the parameter Value, per the Message Parameter shape). */
export function encodeLocationFilter(f: LocationFilter): Uint8Array {
  if (f.startObject !== undefined && f.startGroup === undefined) throw new RangeError('LOCATION_FILTER: startObject requires startGroup');
  if (f.endGroupDelta !== undefined && f.startObject === undefined) throw new RangeError('LOCATION_FILTER: endGroupDelta requires startGroup+startObject');
  if (f.endObject !== undefined && f.endGroupDelta === undefined) throw new RangeError('LOCATION_FILTER: endObject requires endGroupDelta');
  const w = new Writer();
  if (f.startGroup !== undefined) w.varint(f.startGroup);
  if (f.startObject !== undefined) w.varint(f.startObject);
  if (f.endGroupDelta !== undefined) w.varint(f.endGroupDelta);
  if (f.endObject !== undefined) w.varint(f.endObject);
  return w.bytes();
}

/** Decode a LOCATION_FILTER Parameter Value — reads however many of the four positional vi64 fields
 * fit in `bytes` (0..4); more than 4 is a PROTOCOL_VIOLATION (the parameter has no fifth field). */
export function decodeLocationFilter(bytes: Uint8Array): LocationFilter {
  const r = new Reader(bytes);
  const out: LocationFilter = {};
  if (r.remaining > 0) out.startGroup = r.varint();
  if (r.remaining > 0) out.startObject = r.varint();
  if (r.remaining > 0) out.endGroupDelta = r.varint();
  if (r.remaining > 0) out.endObject = r.varint();
  if (r.remaining > 0) throw new MoqProtocolViolationError('LOCATION_FILTER: more than 4 positional fields present');
  return out;
}

/** Write a message's Parameters block (`Number of Parameters(vi64)` + ascending TypeDelta+length-
 * prefixed-Value entries) carrying at most a single LOCATION_FILTER — the "0|1 params, LOCATION_FILTER
 * only" shape shared by FETCH, FILL_PARAMETERS, and SUBSCRIBE (`moq-wire-subscribe.ts`, #212 E5). An
 * `undefined` filter emits Number of Parameters=0 (§location-filters: "omitted ⇒ unfiltered"). */
export function encodeLocationFilterOnlyParams(w: Writer, f: LocationFilter | undefined): void {
  if (f !== undefined) {
    w.varint(1).varint(MOQ_PARAM.LOCATION_FILTER).bytesLP(encodeLocationFilter(f));
  } else {
    w.varint(0);
  }
}

/** Read a message's Parameters block (`Number of Parameters(vi64)` + ascending TypeDelta+length-
 * prefixed-Value entries), resolving only LOCATION_FILTER (this relay's only modeled Message
 * Parameter today) and rejecting anything else as a PROTOCOL_VIOLATION per §10.2 ("an endpoint that
 * receives an unknown Message Parameter MUST close the session"). Shared by decodeFetch below,
 * decodeFillParameters (FILL_PARAMETERS' Value is itself "a sequence of Parameters", §10.2.15), and
 * decodeSubscribe (`moq-wire-subscribe.ts`, #212 E5 — SUBSCRIBE's Parameters block has the identical
 * shape per draft-20 §message-subscribe-req). Exported (not file-local) so that split-out module can
 * reuse it instead of re-implementing the same ascending-Type-Delta parse loop a fourth time. */
export function decodeLocationFilterOnlyParams(r: Reader, context: string): LocationFilter | undefined {
  const nParams = r.varintNum();
  let locationFilter: LocationFilter | undefined;
  let prevType = 0;
  for (let i = 0; i < nParams; i++) {
    const type = prevType + r.varintNum(); // Type Delta, ascending order per §10.2
    prevType = type;
    const value = r.bytesLP();
    if (type === MOQ_PARAM.LOCATION_FILTER) locationFilter = decodeLocationFilter(value);
    else throw new MoqProtocolViolationError(`${context}: unsupported Message Parameter type 0x${type.toString(16)}`);
  }
  return locationFilter;
}

export interface FetchMsg {
  requestId: bigint;
  trackNamespace: string[]; // tuple
  trackName: string;
  /** LOCATION_FILTER Message Parameter (0x21, §10.2.9) — omitted ⇒ unfiltered fetch (whole track, per
   * §5.1.2 "Fetch requests without a filter include all Locations from {0, 0} up to Largest Object"). */
  locationFilter?: LocationFilter;
}
// FETCH (§10.13, 0x16) — pull past objects. draft-20 #1673/#1809 drop FetchType and the joining/
// standalone variant entirely: RequestId(i) + TrackNamespace(tuple) + TrackName(strLP) + Params(0|1).
export function encodeFetch(m: FetchMsg): Uint8Array {
  const w = new Writer().varint(m.requestId).tuple(m.trackNamespace).strLP(m.trackName);
  encodeLocationFilterOnlyParams(w, m.locationFilter);
  return frameControl(MOQ_MSG.FETCH, w.bytes());
}
export function decodeFetch(payload: Uint8Array): FetchMsg {
  const r = new Reader(payload);
  const requestId = r.varint();
  const trackNamespace = r.tuple();
  const trackName = r.strLP();
  const locationFilter = decodeLocationFilterOnlyParams(r, 'FETCH');
  return { requestId, trackNamespace, trackName, locationFilter };
}

export interface FetchOkMsg {
  endOfTrack: boolean;
  end: MoqLocation; // largest available group/object
}
// FETCH_OK (§10.14, 0x18) — first response on the FETCH bidi stream. No Request ID (it is implied by
// the stream). EndOfTrack(8) + EndLocation(i,i) + Params(0) + TrackProps(empty). Unchanged by E3.
export function encodeFetchOk(m: FetchOkMsg): Uint8Array {
  const w = new Writer().u8(m.endOfTrack ? 1 : 0).varint(m.end.group).varint(m.end.object).varint(0);
  return frameControl(MOQ_MSG.FETCH_OK, w.bytes());
}
export function decodeFetchOk(payload: Uint8Array): FetchOkMsg {
  const r = new Reader(payload);
  return { endOfTrack: r.u8() === 1, end: { group: r.varint(), object: r.varint() } };
}

/**
 * FILL_PARAMETERS Message Parameter (0x23, §10.2.15) — draft-20 #1673's SUBSCRIBE/REQUEST_UPDATE-
 * side replacement for "Joining FETCH": its presence requests a publisher-opened fill fetch stream
 * (§5.1.3) carrying historical objects on a separate stream from the live subscription, without
 * gating live delivery on the backfill completing. Its Value is itself a nested Parameter list
 * (§10.2.15 Table 6: FILL_TIMEOUT, SUBSCRIBER_PRIORITY, LOCATION_FILTER, GROUP_ORDER, and the Range
 * Filter family) — this module models only the LOCATION_FILTER member (the fill range), matching the
 * subset FETCH itself understands above; none of the other Table 6 parameters are modeled anywhere
 * else in this codec today. CODEC SURFACE ONLY in this phase — see the file header for why.
 */
export interface FillParameters {
  locationFilter?: LocationFilter;
}
export function encodeFillParameters(m: FillParameters): Uint8Array {
  const w = new Writer();
  encodeLocationFilterOnlyParams(w, m.locationFilter);
  return w.bytes();
}
export function decodeFillParameters(bytes: Uint8Array): FillParameters {
  const r = new Reader(bytes);
  const locationFilter = decodeLocationFilterOnlyParams(r, 'FILL_PARAMETERS');
  return { locationFilter };
}
