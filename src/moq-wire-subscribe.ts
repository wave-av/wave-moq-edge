/**
 * SUBSCRIBE + Range Filters (draft-20 §message-subscribe-req, §5.1.2 Location Filters) — #212 E5.
 *
 * Grounded against the TAGGED `draft-ietf-moq-transport-20` source (moq-wg/moq-transport, fetched
 * live 2026-08-31 — not encoded from memory):
 *   https://raw.githubusercontent.com/moq-wg/moq-transport/draft-ietf-moq-transport-20/draft-ietf-moq-transport.md
 * (6079 lines, same fetch E3/E4 grounded against).
 *
 * DISCREPANCY vs the phase brief: the brief's premise was a dedicated SUBSCRIBE "Filter Type" field
 * with type codes (AbsoluteStart, AbsoluteRange, LargestObject, NextGroupStart, ...) — that shape is
 * an EARLIER draft's (pre-19) FilterType enum. draft-20 has NO such field. #1809 ("Restructure the
 * Location Filter") unified FETCH's and SUBSCRIBE's range selection onto the SAME optional
 * LOCATION_FILTER Message Parameter (0x21, §location-filter) `moq-wire-fetch.ts` already codecs for
 * FETCH/FILL_PARAMETERS (E3) and PUBLISH_STATE_NOTIFY (E4). There is no separate "filter type" wire
 * field to encode — the filter's 0/1/2/3/4-field length IS the type discriminant (§location-filters:
 * "Length (in bytes) determines how many optional vi64 fields are present"). This module's job is
 * therefore wiring that ALREADY-CODED LocationFilter onto SUBSCRIBE's Parameters block, not inventing
 * a new filter-type codec.
 *
 * Wire shape (§message-subscribe-req, verbatim):
 *   SUBSCRIBE Message {
 *     Type (vi64) = 0x3, Length (16),
 *     Request ID (vi64),
 *     Track Namespace (..),
 *     Track Name Length (vi64), Track Name (..),
 *     Number of Parameters (vi64),
 *     Parameters (..) ...
 *   }
 * IDENTICAL shape to FETCH post-E3 (RequestId + TrackNamespace tuple + TrackName strLP + Params) —
 * this module reuses `encodeLocationFilterOnlyParams`/`decodeLocationFilterOnlyParams` from
 * `moq-wire-fetch.ts` rather than re-implementing the ascending-Type-Delta parse/encode loop a third
 * time (matches this repo's "don't duplicate the shared LOCATION_FILTER plumbing" convention —
 * PUBLISH_STATE_NOTIFY (E4) reused the LocationFilter TYPE but had a different Parameters shape
 * [multiple heterogeneous parameter Types, not length-bounded] so it couldn't reuse the FUNCTION; here
 * the Parameters block shape is identical to FETCH's, so the whole helper is reused unchanged).
 *
 * FIX vs pre-E5 base: `moq-wire.ts`'s SubscribeMsg previously modeled ZERO Message Parameters — not
 * "no Location Filter", but literally no `Number of Parameters` field on the wire at all (see the E3
 * header note this replaces). draft-20 §message-subscribe-req requires this field unconditionally
 * (every SUBSCRIBE carries it, `0` when unfiltered). THIS IS A WIRE-COMPAT BREAK on SUBSCRIBE: every
 * encoded frame now carries one more byte (`Number of Parameters`) than before. No deployed peer
 * outside this repo speaks the old shape (relay + moq-client ship together — see `moq-wire.ts`'s
 * header), so there is no cross-version negotiation to preserve, matching the FETCH precedent (E3).
 *
 * §5.1.2 relative-to-Largest-Object forms (a lone StartGroup, or StartGroup=StartObject=0) are decoded
 * (the wire shape is unambiguous — see `decodeLocationFilter`) but resolving them requires the
 * publisher's current Largest Object, which this one-track-per-DO relay does not track independently
 * of the small last-N-groups cache it retains (`moq-relay.ts`'s `onFetch` rejects the same forms as
 * NOT_SUPPORTED for the identical reason — see that file). `moq-relay.ts`'s SUBSCRIBE handler mirrors
 * that: relative filters are rejected with REQUEST_ERROR(NOT_SUPPORTED); only the four ABSOLUTE forms
 * (unfiltered, start-only, start+end-group, full start+end range) filter live delivery. This is the
 * form the Nodal1 6DoF/volumetric per-viewport use case needs: a viewer names an absolute
 * Group/Object range covering the spatial-partition objects currently in its viewport, not a
 * relative-to-live-edge range.
 */

import { Reader, Writer, frameControl, MOQ_MSG } from './moq-wire';
import { encodeLocationFilterOnlyParams, decodeLocationFilterOnlyParams, type LocationFilter } from './moq-wire-fetch';

export interface SubscribeMsg {
  requestId: bigint;
  trackNamespace: string[]; // tuple
  trackName: string;
  /** LOCATION_FILTER Message Parameter (0x21, §location-filter, #212 E5) — omitted ⇒ unfiltered
   * subscription (all Objects published/received via upstream subscriptions pass, §location-filters).
   * This is the per-viewport range selector: a subscriber names the Group/Object range of the objects
   * it wants (e.g. the spatial partition currently in view), and the publisher/relay forwards only
   * Locations inside that inclusive range. */
  locationFilter?: LocationFilter;
}

// SUBSCRIBE (§message-subscribe-req, 0x3) — identical Parameters-block shape to FETCH (§10.13, E3):
// RequestId(i) + TrackNamespace(tuple) + TrackName(strLP) + Params(0|1, LOCATION_FILTER only).
export function encodeSubscribe(m: SubscribeMsg): Uint8Array {
  const w = new Writer().varint(m.requestId).tuple(m.trackNamespace).strLP(m.trackName);
  encodeLocationFilterOnlyParams(w, m.locationFilter);
  return frameControl(MOQ_MSG.SUBSCRIBE, w.bytes());
}
export function decodeSubscribe(payload: Uint8Array): SubscribeMsg {
  const r = new Reader(payload);
  const requestId = r.varint();
  const trackNamespace = r.tuple();
  const trackName = r.strLP();
  const locationFilter = decodeLocationFilterOnlyParams(r, 'SUBSCRIBE');
  return { requestId, trackNamespace, trackName, locationFilter };
}
