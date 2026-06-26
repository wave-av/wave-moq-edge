/**
 * MPEG-TS → MoQ ingest — depacketize an MPEG-2 Transport Stream (ISO/IEC 13818-1) into per-track
 * MoQ objects, splitting a designated caption PID into its OWN MoQ track so subscribers can take
 * captions independently of video (see src/moq-trackset.ts).
 *
 * Intent: the ingest half of "TS-over-MoQ" — a customer encoder that already emits MPEG-TS (the
 * lingua franca of broadcast/SRT/HLS) gets its multiplex demuxed at the edge into MoQ tracks the
 * draft-18 relay (src/moq-relay.ts) already fans out. PURE: Uint8Array in → MoqObject structs out,
 * no I/O, no fetch, no shell — so it is hermetically unit-testable (see __tests__/moq-ingest.test.ts)
 * and safe to run on the hot path.
 *
 * Security: the TS bytes are UNTRUSTED input. Defenses — strict 0x47 sync-byte check on every packet,
 * 188-byte alignment check, an input-size cap, and a bounds-clamped adaptation-field length so an
 * attacker-controlled length byte can never drive a read past the 188-byte packet end. Payloads are
 * copied out as opaque bytes (never interpreted, never interpolated into any sink).
 *
 * What this is NOT (scope boundary): this models captions carried on a SEPARATE PID (DVB subtitle /
 * teletext / SCTE / a dedicated caption service) — the clean per-track case. Inline CEA-608/708
 * embedded in the video ES's SEI/user-data is a downstream-demux concern and is intentionally out of
 * scope for this ingest. It also does not parse PAT/PMT to discover PIDs — the PIDs are supplied by
 * config (the encoder contract names them); PAT/PMT-driven discovery is a deliberate follow-up.
 */
import { MOQ_OBJECT_STATUS, type MoqObject } from './moq-wire';

export const TS_PACKET_SIZE = 188;
export const TS_SYNC_BYTE = 0x47;
export const TS_NULL_PID = 0x1fff; // §2.4.3.2 — null packets (PID 0x1FFF) carry no ES; always skipped
export const TS_MAX_PID = 0x1fff; // PID is a 13-bit field

/** Default cap on a single ingest buffer so a hostile stream can't exhaust memory (16 MiB). */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** adaptation_field_control values (§2.4.3.3): bit pattern in transport packet byte 3, bits 5-4. */
const AFC = { RESERVED: 0b00, PAYLOAD_ONLY: 0b01, ADAPTATION_ONLY: 0b10, ADAPTATION_AND_PAYLOAD: 0b11 } as const;

/** One parsed 188-byte transport packet (header fields + the ES/section payload after the header). */
export interface TsPacket {
  pid: number; // 13-bit Packet Identifier
  pusi: boolean; // payload_unit_start_indicator — a PES packet / PSI section begins in this packet
  adaptationFieldControl: number; // AFC.*
  continuityCounter: number; // 4-bit, wraps per-PID
  payload: Uint8Array; // ES/section bytes after the 4-byte header + adaptation field (may be empty)
}

/**
 * Parse a whole MPEG-TS byte stream into its 188-byte packets. Treats the input as untrusted:
 * rejects a non-188-aligned length, rejects a lost sync byte, caps the input size, and bounds the
 * attacker-controlled adaptation-field length so the payload slice never escapes the packet.
 */
export function parseTsPackets(bytes: Uint8Array, opts: { maxBytes?: number } = {}): TsPacket[] {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes.length > maxBytes) throw new RangeError(`TS input ${bytes.length} bytes exceeds cap ${maxBytes}`);
  if (bytes.length === 0 || bytes.length % TS_PACKET_SIZE !== 0) {
    throw new RangeError(`TS input ${bytes.length} bytes is not a positive multiple of ${TS_PACKET_SIZE}`);
  }
  const packets: TsPacket[] = [];
  for (let off = 0; off < bytes.length; off += TS_PACKET_SIZE) {
    if (bytes[off] !== TS_SYNC_BYTE) {
      throw new RangeError(`lost TS sync at byte ${off}: 0x${bytes[off].toString(16)} != 0x47`);
    }
    const b1 = bytes[off + 1];
    const b2 = bytes[off + 2];
    const b3 = bytes[off + 3];
    const pid = ((b1 & 0x1f) << 8) | b2;
    const pusi = (b1 & 0x40) !== 0;
    const afc = (b3 >> 4) & 0x3;
    const continuityCounter = b3 & 0x0f;

    let payloadStart = 4;
    if (afc === AFC.ADAPTATION_ONLY || afc === AFC.RESERVED) {
      payloadStart = TS_PACKET_SIZE; // no payload in this packet
    } else if (afc === AFC.ADAPTATION_AND_PAYLOAD) {
      // byte[4] = adaptation_field_length — ATTACKER-CONTROLLED; clamp so the slice can't run past 188.
      const adaptLen = bytes[off + 4];
      payloadStart = 5 + adaptLen;
      if (payloadStart > TS_PACKET_SIZE) payloadStart = TS_PACKET_SIZE;
    }
    // .slice() COPIES (vs subarray's view) so the ingested object owns its bytes — the relay caches
    // forwarded frames, so an aliasing view into the caller's buffer would be a correctness hazard.
    const payload = bytes.slice(off + payloadStart, off + TS_PACKET_SIZE);
    packets.push({ pid, pusi, adaptationFieldControl: afc, continuityCounter, payload });
  }
  return packets;
}

export interface IngestOptions {
  videoPid: number;
  captionPid: number;
  videoTrackAlias?: bigint; // default 1
  captionTrackAlias?: bigint; // default 2
  maxBytes?: number;
}

export interface IngestedTracks {
  video: MoqObject[];
  captions: MoqObject[];
}

function assertPid(name: string, pid: number): void {
  if (!Number.isInteger(pid) || pid < 0 || pid > TS_MAX_PID) {
    throw new RangeError(`${name} ${pid} is not a valid 13-bit PID (0..${TS_MAX_PID})`);
  }
  if (pid === TS_NULL_PID) throw new RangeError(`${name} cannot be the null PID 0x1FFF`);
}

/**
 * Demux an MPEG-TS stream into a video MoQ track and a caption MoQ track by PID. Each track's packets
 * are packetized independently: a new MoQ Group begins at every payload_unit_start (a PES/section
 * boundary — a natural random-access point), one MoQ Object per TS packet carrying ES bytes. Packets
 * on any other PID (PAT/PMT/null/unknown) are ignored.
 */
export function ingestTsToTracks(bytes: Uint8Array, opts: IngestOptions): IngestedTracks {
  assertPid('videoPid', opts.videoPid);
  assertPid('captionPid', opts.captionPid);
  if (opts.videoPid === opts.captionPid) {
    throw new RangeError(`videoPid and captionPid must differ (both ${opts.videoPid})`);
  }
  const packets = parseTsPackets(bytes, { maxBytes: opts.maxBytes });
  return {
    video: packetizeTrack(packets, opts.videoPid, opts.videoTrackAlias ?? 1n),
    captions: packetizeTrack(packets, opts.captionPid, opts.captionTrackAlias ?? 2n),
  };
}

/** Map the packets of ONE PID to MoQ objects: new Group at each PUSI, one Object per non-empty packet. */
function packetizeTrack(packets: TsPacket[], pid: number, trackAlias: bigint): MoqObject[] {
  const objects: MoqObject[] = [];
  let groupId = -1n; // first PES/section start → group 0
  let objectId = 0n;
  let started = false;
  for (const p of packets) {
    if (p.pid !== pid) continue;
    if (p.pusi || !started) {
      groupId += 1n; // start a new group on each PES/section boundary (and on the track's first packet)
      objectId = 0n;
      started = true;
    }
    if (p.payload.length === 0) continue; // adaptation-only / empty — no ES bytes to carry
    objects.push({ trackAlias, groupId, objectId, status: MOQ_OBJECT_STATUS.NORMAL, payload: p.payload });
    objectId += 1n;
  }
  return objects;
}
