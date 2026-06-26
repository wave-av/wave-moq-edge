/**
 * MoqTrackSet — route control/object frames to a per-track MoqRelay so a subscriber can subscribe to
 * ONE named track (e.g. 'captions') independently of the others (e.g. 'video') within a single
 * namespace. The base MoqRelay (src/moq-relay.ts) serves exactly one track; this is the thin router
 * that gives a namespace its set of named tracks and dispatches by track name.
 *
 * Intent: this is what makes "per-track caption subscription" concrete — the ingest (src/moq-ingest.ts)
 * splits an MPEG-TS multiplex into a video track + a caption track, and a viewer that only wants
 * captions SUBSCRIBEs the 'captions' track and is fanned out ONLY caption objects. PURE +
 * transport-agnostic, exactly like the relay it wraps: the Durable Object (moq-session-do.ts) keeps
 * owning auth/metering/sockets and decides a frame's track from its subscription key, then calls in.
 *
 * Track selection is by EXPLICIT name argument (the DO already knows the track from the subscription),
 * not re-derived from each frame — unambiguous, and it keeps the wire frames exactly draft-18. An
 * unknown track name is rejected with REQUEST_ERROR(DOES_NOT_EXIST), never silently accepted.
 */
import { MoqRelay, type ControlResult, type Outbound, type RelayEvent } from './moq-relay';
import { Reader, parseControl, encodeRequestError, MOQ_ERROR } from './moq-wire';

export class MoqTrackSet {
  private readonly tracks = new Map<string, MoqRelay>();

  /** Create a namespace with a fixed set of named tracks, each backed by its own one-track relay. */
  constructor(trackNames: string[], opts: { cachedGroups?: number } = {}) {
    if (trackNames.length === 0) throw new RangeError('a track set needs at least one track name');
    for (const name of trackNames) {
      if (this.tracks.has(name)) throw new RangeError(`duplicate track name ${name}`);
      this.tracks.set(name, new MoqRelay(opts));
    }
  }

  get trackNames(): string[] {
    return [...this.tracks.keys()];
  }
  relay(trackName: string): MoqRelay | undefined {
    return this.tracks.get(trackName);
  }
  hasTrack(trackName: string): boolean {
    return this.tracks.has(trackName);
  }
  hasPublisher(trackName: string): boolean {
    return this.tracks.get(trackName)?.hasPublisher ?? false;
  }
  subscriberCount(trackName: string): number {
    return this.tracks.get(trackName)?.subscriberCount ?? 0;
  }

  /**
   * Route one control frame to the named track's relay. An unknown track name yields a
   * REQUEST_ERROR(DOES_NOT_EXIST) addressed back to the caller (fail loud, never silent-accept).
   */
  onControl(trackName: string, sessionId: string, frame: Uint8Array): ControlResult {
    const relay = this.tracks.get(trackName);
    if (!relay) {
      const replies: Outbound[] = [];
      const requestId = readRequestId(frame);
      if (requestId !== null) {
        replies.push({
          to: sessionId,
          kind: 'control',
          frame: encodeRequestError({ requestId, errorCode: MOQ_ERROR.DOES_NOT_EXIST, reason: `unknown track ${trackName}` }),
        });
      }
      return { replies, objects: [], events: [] };
    }
    return relay.onControl(sessionId, frame);
  }

  /** Route one OBJECT frame to the named track's relay (only that track's publisher fans out). */
  onObject(trackName: string, sessionId: string, frame: Uint8Array): { fanout: Outbound[]; events: RelayEvent[] } {
    const relay = this.tracks.get(trackName);
    if (!relay) return { fanout: [], events: [] };
    return relay.onObject(sessionId, frame);
  }

  /** Drop a session (publisher or subscriber) from EVERY track on disconnect; returns all events. */
  removeSession(sessionId: string): RelayEvent[] {
    const events: RelayEvent[] = [];
    for (const relay of this.tracks.values()) events.push(...relay.removeSession(sessionId));
    return events;
  }
}

/** Read the Request ID (leading varint of a control payload) from a control frame, or null if unparseable. */
function readRequestId(frame: Uint8Array): bigint | null {
  try {
    const { payload } = parseControl(frame);
    return new Reader(payload).varint();
  } catch {
    return null;
  }
}
