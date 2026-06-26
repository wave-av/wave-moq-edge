import { describe, it, expect } from 'vitest';
import {
  parseTsPackets,
  ingestTsToTracks,
  TS_PACKET_SIZE,
  TS_SYNC_BYTE,
  TS_NULL_PID,
} from '../src/moq-ingest';
import { MoqTrackSet } from '../src/moq-trackset';
import {
  MOQ_ROLE,
  MOQ_ERROR,
  parseControl,
  encodeSetup,
  encodeSubscribe,
  encodePublishNamespace,
  encodeObject,
  decodeObject,
  decodeRequestError,
} from '../src/moq-wire';

const VIDEO_PID = 0x0100;
const CAPTION_PID = 0x0101;
const NS = ['wave', 'cam-1'];

/**
 * Build one well-formed 188-byte TS packet whose parsed payload === `payload` exactly. Payloads up to
 * 184 bytes ride afc=01 (payload only); shorter ones use afc=11 with an adaptation-field stuffing pad
 * so the payload lands at the packet tail (the realistic shape — real muxers pad PES with adaptation).
 */
function tsPacket(o: { pid: number; pusi?: boolean; payload: Uint8Array; cc?: number }): Uint8Array {
  const { pid, pusi = false, payload, cc = 0 } = o;
  if (payload.length > 184) throw new Error('payload exceeds one TS packet (max 184)');
  const pkt = new Uint8Array(TS_PACKET_SIZE);
  pkt[0] = TS_SYNC_BYTE;
  pkt[1] = ((pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f)) & 0xff;
  pkt[2] = pid & 0xff;
  if (payload.length === 184) {
    pkt[3] = (0x10 | (cc & 0x0f)) & 0xff; // afc=01 payload-only, continuity
    pkt.set(payload, 4);
  } else {
    pkt[3] = (0x30 | (cc & 0x0f)) & 0xff; // afc=11 adaptation+payload
    const adaptLen = 183 - payload.length; // payloadStart = 5 + adaptLen = 188 - len
    pkt[4] = adaptLen; // adaptation_field_length; bytes[5..] left 0x00 (flags+stuffing)
    pkt.set(payload, TS_PACKET_SIZE - payload.length);
  }
  return pkt;
}

function concat(...packets: Uint8Array[]): Uint8Array {
  const total = packets.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of packets) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('parseTsPackets — framing + untrusted-input defenses', () => {
  it('parses header fields (PID, PUSI, continuity) and the payload', () => {
    const pkt = tsPacket({ pid: VIDEO_PID, pusi: true, payload: enc('hello'), cc: 5 });
    const [p] = parseTsPackets(pkt);
    expect(p.pid).toBe(VIDEO_PID);
    expect(p.pusi).toBe(true);
    expect(p.continuityCounter).toBe(5);
    expect(dec(p.payload)).toBe('hello');
  });

  it('parses a full 184-byte (afc=01, no adaptation) payload', () => {
    const big = new Uint8Array(184).map((_, i) => i & 0xff);
    const [p] = parseTsPackets(tsPacket({ pid: VIDEO_PID, payload: big }));
    expect(p.payload).toEqual(big);
  });

  it('rejects a lost sync byte', () => {
    const pkt = tsPacket({ pid: VIDEO_PID, payload: enc('x') });
    pkt[0] = 0x46; // corrupt the 0x47 sync
    expect(() => parseTsPackets(pkt)).toThrow(/sync/i);
  });

  it('rejects a non-188-aligned / empty buffer', () => {
    expect(() => parseTsPackets(new Uint8Array(187))).toThrow(/multiple/i);
    expect(() => parseTsPackets(new Uint8Array(0))).toThrow(/multiple/i);
  });

  it('rejects an over-cap buffer', () => {
    const two = concat(tsPacket({ pid: VIDEO_PID, payload: enc('a') }), tsPacket({ pid: VIDEO_PID, payload: enc('b') }));
    expect(() => parseTsPackets(two, { maxBytes: TS_PACKET_SIZE })).toThrow(/cap/i);
  });

  it('clamps an attacker-inflated adaptation_field_length to the packet end (no OOB read)', () => {
    const pkt = tsPacket({ pid: VIDEO_PID, payload: enc('x') });
    pkt[3] = 0x30; // afc=11
    pkt[4] = 0xff; // adaptation_field_length way past the packet → payloadStart clamps to 188
    const [p] = parseTsPackets(pkt);
    expect(p.payload.length).toBe(0); // clamped to empty, never reads past byte 188
  });
});

describe('ingestTsToTracks — demux by PID into separate MoQ tracks', () => {
  it('routes each PID to its track and ignores PAT/null/unknown PIDs', () => {
    const stream = concat(
      tsPacket({ pid: 0x0000, pusi: true, payload: enc('PAT') }), // program association table — ignored
      tsPacket({ pid: VIDEO_PID, pusi: true, payload: enc('V0') }),
      tsPacket({ pid: CAPTION_PID, pusi: true, payload: enc('C0') }),
      tsPacket({ pid: TS_NULL_PID, payload: new Uint8Array(0) }), // null packet — ignored
      tsPacket({ pid: VIDEO_PID, payload: enc('V1') }),
      tsPacket({ pid: 0x0fff, pusi: true, payload: enc('OTHER') }), // unconfigured PID — ignored
    );
    const { video, captions } = ingestTsToTracks(stream, { videoPid: VIDEO_PID, captionPid: CAPTION_PID });
    expect(video.map((o) => dec(o.payload))).toEqual(['V0', 'V1']);
    expect(captions.map((o) => dec(o.payload))).toEqual(['C0']);
  });

  it('starts a new Group at each PUSI and increments Object IDs within a group', () => {
    const stream = concat(
      tsPacket({ pid: VIDEO_PID, pusi: true, payload: enc('g0o0') }),
      tsPacket({ pid: VIDEO_PID, payload: enc('g0o1') }),
      tsPacket({ pid: VIDEO_PID, payload: enc('g0o2') }),
      tsPacket({ pid: VIDEO_PID, pusi: true, payload: enc('g1o0') }),
    );
    const { video } = ingestTsToTracks(stream, { videoPid: VIDEO_PID, captionPid: CAPTION_PID });
    expect(video.map((o) => [o.groupId, o.objectId])).toEqual([
      [0n, 0n],
      [0n, 1n],
      [0n, 2n],
      [1n, 0n],
    ]);
  });

  it('rejects an invalid or colliding PID config (fail loud)', () => {
    const s = tsPacket({ pid: VIDEO_PID, payload: enc('x') });
    expect(() => ingestTsToTracks(s, { videoPid: VIDEO_PID, captionPid: VIDEO_PID })).toThrow(/differ/i);
    expect(() => ingestTsToTracks(s, { videoPid: 0x2000, captionPid: CAPTION_PID })).toThrow(/PID/i);
    expect(() => ingestTsToTracks(s, { videoPid: VIDEO_PID, captionPid: TS_NULL_PID })).toThrow(/null/i);
  });
});

describe('MoqTrackSet — per-track subscription (the #64 verdict)', () => {
  it('rejects a SUBSCRIBE to an unknown track with REQUEST_ERROR(DOES_NOT_EXIST)', () => {
    const ts = new MoqTrackSet(['video', 'captions']);
    const { replies } = ts.onControl('ghost', 'sub', encodeSubscribe({ requestId: 9n, trackNamespace: NS, trackName: 'ghost' }));
    expect(replies).toHaveLength(1);
    const err = decodeRequestError(parseControl(replies[0].frame).payload);
    expect(err.requestId).toBe(9n);
    expect(err.errorCode).toBe(MOQ_ERROR.DOES_NOT_EXIST);
  });

  it('end-to-end: ingest TS → publish per track → a captions-only subscriber receives ONLY captions', () => {
    // Interleaved multiplex: 2 video PES units (one continued), 2 caption objects, plus PAT + null noise.
    const stream = concat(
      tsPacket({ pid: 0x0000, pusi: true, payload: enc('PAT') }),
      tsPacket({ pid: VIDEO_PID, pusi: true, payload: enc('VIDEO-0') }),
      tsPacket({ pid: CAPTION_PID, pusi: true, payload: enc('CAPTION-0') }),
      tsPacket({ pid: VIDEO_PID, payload: enc('VIDEO-0b') }),
      tsPacket({ pid: TS_NULL_PID, payload: new Uint8Array(0) }),
      tsPacket({ pid: CAPTION_PID, pusi: true, payload: enc('CAPTION-1') }),
      tsPacket({ pid: VIDEO_PID, pusi: true, payload: enc('VIDEO-1') }),
    );
    const { video, captions } = ingestTsToTracks(stream, { videoPid: VIDEO_PID, captionPid: CAPTION_PID });
    expect(video.map((o) => dec(o.payload))).toEqual(['VIDEO-0', 'VIDEO-0b', 'VIDEO-1']);
    expect(captions.map((o) => dec(o.payload))).toEqual(['CAPTION-0', 'CAPTION-1']);

    const set = new MoqTrackSet(['video', 'captions']);
    // attach a publisher to each track
    set.onControl('video', 'vid-pub', encodePublishNamespace({ requestId: 1n, trackNamespace: NS }));
    set.onControl('captions', 'cap-pub', encodePublishNamespace({ requestId: 2n, trackNamespace: NS }));
    // each viewer subscribes to exactly ONE track (with a SETUP first, like a real client)
    set.onControl('video', 'vid-sub', encodeSetup({ role: MOQ_ROLE.SUBSCRIBER, maxSubscriptions: 1n }));
    set.onControl('video', 'vid-sub', encodeSubscribe({ requestId: 10n, trackNamespace: NS, trackName: 'video' }));
    set.onControl('captions', 'cap-sub', encodeSetup({ role: MOQ_ROLE.SUBSCRIBER, maxSubscriptions: 1n }));
    set.onControl('captions', 'cap-sub', encodeSubscribe({ requestId: 11n, trackNamespace: NS, trackName: 'captions' }));

    const got: Record<string, string[]> = { 'vid-sub': [], 'cap-sub': [] };
    const publish = (track: string, pub: string, objs: typeof video) => {
      for (const obj of objs) {
        const { fanout } = set.onObject(track, pub, encodeObject(obj));
        for (const out of fanout) {
          if (out.to in got) got[out.to].push(dec(decodeObject(out.frame).payload));
        }
      }
    };
    publish('video', 'vid-pub', video);
    publish('captions', 'cap-pub', captions);

    // The verdict: the captions-only subscriber received exactly the caption payloads and ZERO video.
    expect(got['cap-sub']).toEqual(['CAPTION-0', 'CAPTION-1']);
    expect(got['vid-sub']).toEqual(['VIDEO-0', 'VIDEO-0b', 'VIDEO-1']);
    expect(got['cap-sub'].some((s) => s.startsWith('VIDEO'))).toBe(false);

    // and a disconnect drops the session from every track
    const events = set.removeSession('cap-sub');
    expect(events.some((e) => e.kind === 'unsubscribe' && e.sessionId === 'cap-sub')).toBe(true);
    expect(set.subscriberCount('captions')).toBe(0);
  });
});
