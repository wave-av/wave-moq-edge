/**
 * Viewport Object Properties — per-object viewport identity, PTP capture instant, clock state and
 * pose, carried on the SAME object as the frame it describes.
 *
 * WHY NOT A SIDECAR TRACK. The obvious design is a parallel metadata track carrying pose. We rejected
 * it. A sibling track has its OWN subscription, its OWN delivery timeout and its OWN scheduling slot,
 * so pose and frame decouple exactly when the network is worst — and it re-creates the many-track
 * desync that published MoQ measurement reports at the relay beyond N≈5 tracks (arXiv:2412.07889).
 * Riding the object means pose cannot arrive without its frame, or vice versa, by construction.
 *
 * WHY IT WORKS ON A RELAY. draft-19 §2.5 is explicit: "If a Relay does not support a Property, it MUST
 * NOT be modified, MUST be forwarded, and MUST be cached with the Track or Object", and -19's release
 * notes recommend Immutable Properties precisely for relay-visible unmodifiable data. draft-18 — what
 * we run today (`MOQ_ALPN = 'moqt-18'`) — already reserves the SUBGROUP_HEADER PROPERTIES flag (0x01)
 * and a length-prefixed per-object property block, which `moq-wire.ts:skipObjectProperties` already
 * walks. So the block is expressible on the wire we actually run; this module supplies the codec for
 * its contents and `MoqObject.properties` carries it verbatim through the relay.
 *
 * CODEPOINTS ARE PROVISIONAL. draft-19 reserves 0x4000–0x7FFF for MANDATORY Track Properties: an
 * endpoint that receives an unsupported mandatory property "MUST NOT process or forward that track".
 * We deliberately sit OUTSIDE that range so a relay that has never heard of a viewport still forwards
 * the media — fail-open on metadata, because dropping video because a relay did not understand a pose
 * field is the wrong trade. The 0xFF00–0xFF0F values below are PROVISIONAL private use and MUST be
 * replaced by IANA-registered codepoints before any interop claim.
 *
 * PURE module: bytes in / structs out.
 */
import { Writer, Reader } from './moq-wire';
import { CLOCK_STATE, type ClockState, type ViewportPose, type ViewportIntrinsics } from './viewport-model';

/**
 * Provisional Object Property codepoints. Outside draft-19's mandatory 0x4000–0x7FFF range on
 * purpose (see the header). All are conceptually IMMUTABLE: a relay must forward them unchanged.
 */
export const VIEWPORT_PROP = {
  /** varint — the viewport id this object belongs to. Redundant with the track, and deliberately so:
   *  it survives a track alias remap and makes a recorded object self-describing. */
  VIEWPORT_ID: 0xff00,
  /** varint — the exact PTP capture instant, TAI nanoseconds. THIS is the timestamp MoQ lacks. */
  CAPTURE_TAI_NS: 0xff01,
  /** varint — CLOCK_STATE.*: whether the timestamp above can be trusted. */
  CLOCK_STATE: 0xff02,
  /** 28 bytes — position xyz + orientation quaternion xyzw, seven big-endian float32s. */
  POSE: 0xff03,
  /** 16 bytes — fx, fy, cx, cy as four big-endian float32s. */
  INTRINSICS: 0xff04,
  /** UTF-8 — the rig this viewport belongs to. */
  RIG_ID: 0xff05,
} as const;

/**
 * The decoded contents of a viewport property block. Every field is optional on the wire.
 *
 * #212 E2 note (draft-20 #1844): `OBJECT_DELIVERY_TIMEOUT` now starts counting at the LAST HEADER
 * BYTE — i.e. the end of this Properties block when one is present (or the end of the length-prefixed
 * Payload when it is absent) — rather than the first Payload byte as in draft-18/-19. This block's own
 * encode/decode (`encodeViewportProperties`/`decodeViewportProperties`) is a pure byte-in/byte-out
 * codec and neither computes nor enforces any delivery-timeout deadline, so this module needs no code
 * change for the shift; it is documented here because a FUTURE delivery-timeout implementation reading
 * `ViewportObjectMeta` must anchor its clock to "this block finished decoding" (matching the trailing
 * placement of `MoqObject.properties` on this repo's WS-binding — see moq-wire-object.ts), NOT to the
 * first payload byte the pre-E2 draft would have implied.
 */
export interface ViewportObjectMeta {
  viewportId?: number;
  captureTaiNs?: bigint;
  clockState?: ClockState;
  pose?: ViewportPose;
  intrinsics?: ViewportIntrinsics;
  rigId?: string;
}

function f32be(values: number[]): Uint8Array {
  const buf = new ArrayBuffer(values.length * 4);
  const dv = new DataView(buf);
  values.forEach((v, i) => dv.setFloat32(i * 4, v, false));
  return new Uint8Array(buf);
}
function readF32be(bytes: Uint8Array, count: number): number[] {
  if (bytes.length !== count * 4) throw new RangeError(`expected ${count * 4} bytes of float32, got ${bytes.length}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, i) => dv.getFloat32(i * 4, false));
}

/**
 * Encode a viewport property block: a bag of (Type varint, Length-prefixed Value) pairs, in ascending
 * type order so the encoding is canonical and byte-comparable across implementations.
 *
 * NOTE the block is emitted WITHOUT its own outer length prefix — `MoqObject.properties` is written
 * with `bytesLP`, and `SUBGROUP_HEADER`'s property block is likewise length-prefixed by its carrier.
 * The block is the payload of that length, matching what `skipObjectProperties` walks.
 */
export function encodeViewportProperties(m: ViewportObjectMeta): Uint8Array {
  const w = new Writer();
  if (m.viewportId !== undefined) w.varint(VIEWPORT_PROP.VIEWPORT_ID).bytesLP(new Writer().varint(m.viewportId).bytes());
  if (m.captureTaiNs !== undefined) w.varint(VIEWPORT_PROP.CAPTURE_TAI_NS).bytesLP(new Writer().varint(m.captureTaiNs).bytes());
  if (m.clockState !== undefined) w.varint(VIEWPORT_PROP.CLOCK_STATE).bytesLP(new Writer().varint(m.clockState).bytes());
  if (m.pose !== undefined) w.varint(VIEWPORT_PROP.POSE).bytesLP(f32be([...m.pose.position, ...m.pose.orientation]));
  if (m.intrinsics !== undefined) {
    w.varint(VIEWPORT_PROP.INTRINSICS).bytesLP(f32be([m.intrinsics.fx, m.intrinsics.fy, m.intrinsics.cx, m.intrinsics.cy]));
  }
  if (m.rigId !== undefined) w.varint(VIEWPORT_PROP.RIG_ID).strLP(m.rigId);
  return w.bytes();
}

/**
 * Decode a viewport property block. Unknown property types are SKIPPED, never fatal — that is the
 * fail-open contract that keeps a future property from breaking today's subscribers, and it mirrors
 * the relay rule (forward what you do not understand).
 */
export function decodeViewportProperties(bytes: Uint8Array): ViewportObjectMeta {
  const r = new Reader(bytes);
  const out: ViewportObjectMeta = {};
  while (r.remaining > 0) {
    const type = r.varintNum();
    const value = r.bytesLP();
    switch (type) {
      case VIEWPORT_PROP.VIEWPORT_ID:
        out.viewportId = new Reader(value).varintNum();
        break;
      case VIEWPORT_PROP.CAPTURE_TAI_NS:
        out.captureTaiNs = new Reader(value).varint();
        break;
      case VIEWPORT_PROP.CLOCK_STATE: {
        const v = new Reader(value).varintNum();
        out.clockState = (Object.values(CLOCK_STATE) as number[]).includes(v) ? (v as ClockState) : CLOCK_STATE.FREERUN;
        break;
      }
      case VIEWPORT_PROP.POSE: {
        const f = readF32be(value, 7);
        out.pose = { position: [f[0], f[1], f[2]], orientation: [f[3], f[4], f[5], f[6]] };
        break;
      }
      case VIEWPORT_PROP.INTRINSICS: {
        const f = readF32be(value, 4);
        out.intrinsics = { fx: f[0], fy: f[1], cx: f[2], cy: f[3] };
        break;
      }
      case VIEWPORT_PROP.RIG_ID:
        out.rigId = new TextDecoder().decode(value);
        break;
      default:
        break; // unknown property — skipped, not fatal
    }
  }
  return out;
}
