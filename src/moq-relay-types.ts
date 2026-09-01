/**
 * MoQ relay state shapes — the data types `moq-relay.ts`'s pub/sub state machine and
 * `moq-relay-filter.ts`'s LOCATION_FILTER handlers share. Split out of `moq-relay.ts` (#212
 * file-size follow-up, epic #212) once that module crossed the repo's file-size gate; the
 * `Outbound` / `RelayEvent` / `ControlResult` re-export from `moq-relay.ts` keeps every existing
 * `from './moq-relay'` import working unchanged (`Subscriber` / `CachedGroup` / `PendingObject` /
 * `ResolvedRange` were never part of that module's public surface and stay internal-only, imported
 * directly from here by the two modules that need them). PURE type declarations — no runtime code,
 * so this file carries zero behavior of its own; every field/shape below is moved verbatim.
 */
import type { MoqLocation } from './moq-wire.ts';

/** A frame to deliver to a specific session (control reply or fanned-out object). */
export interface Outbound {
  to: string;
  frame: Uint8Array;
  kind: 'control' | 'object';
}

/** A relay observation the DO folds into the R4 metering (maps to MetricsCollector.MoqMetric.kind). */
export interface RelayEvent {
  kind: 'publish_start' | 'publish_end' | 'subscribe' | 'unsubscribe' | 'object_received' | 'group_complete';
  sessionId: string;
  bytes?: number;
  /** The decoded object payload, present on `object_received` only — so the DO can persist it (the
   * recording write path) without re-decoding the frame on the hot path. Publisher objects only. */
  payload?: Uint8Array;
}

/** An absolute Location range (#212 E5) — the resolved form of an absolute LOCATION_FILTER. `end`
 * undefined ⇒ open-ended (§location-filters: "When EndGroupDelta and EndObject are omitted from a
 * subscription filter, the subscription is open-ended"). `endGroupOpen` true ⇒ EndObject was omitted,
 * so the whole End Group passes (§location-filters: "the filter includes all objects in the End
 * Group"). Relative-to-Largest-Object forms are NOT representable here — see
 * `moq-relay-filter.ts`'s `resolveLocationFilter`. */
export interface ResolvedRange {
  start: MoqLocation;
  end?: MoqLocation;
  endGroupOpen: boolean;
}

export interface Subscriber {
  requestId: bigint;
  /** Resolved absolute LOCATION_FILTER range (#212 E5, updatable in-place by #212 E6's REQUEST_UPDATE)
   * — the per-viewport filter. `undefined` means the subscription carried no filter (or was decoded
   * with one that resolved to unfiltered): forward every object, byte-identical to pre-E5 fan-out. */
  range?: ResolvedRange;
  /** FORWARD state (#212 E6, §forward-parameter) — 0 = paused, 1/undefined = forwarding. Only
   * REQUEST_UPDATE sets this today (SUBSCRIBE itself carries no FORWARD parameter in this codec — see
   * moq-wire-subscribe.ts); `undefined` is the default forwarding-ON state, matching every
   * pre-E6 subscriber's behavior byte-for-byte. */
  forward?: 0 | 1;
}

/** One cached group: the forwarded object frames of a single Group ID, in arrival order. */
export interface CachedGroup {
  groupId: bigint;
  objects: Array<{ objectId: bigint; frame: Uint8Array }>;
}

/** One object buffered by the E1 scheduler awaiting its group's flush (scheduler ON only). */
export interface PendingObject {
  groupId: bigint;
  objectId: bigint;
  frame: Uint8Array;
  priority?: number; // non-wire hint (see MoqObject.priority)
  deadlineMs?: number; // non-wire hint (see MoqObject.deadlineMs)
}

/** What a control frame produces: control replies, fanned-out objects (late-joiner replay), events. */
export interface ControlResult {
  replies: Outbound[];
  objects: Outbound[];
  events: RelayEvent[];
}
