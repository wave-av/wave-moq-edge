/**
 * Multi-viewport MSF catalog — how a client (or an agent) DISCOVERS the viewports and their
 * properties, and how it learns the timing grid it needs to interpret Group and Object IDs.
 *
 * This builds on `catalog.ts` (draft-ietf-moq-catalogformat-01 / draft-ietf-moq-msf) rather than
 * replacing it: same `version` / `streamingFormat` / `commonTrackFields` / `tracks` skeleton, same
 * MSF `loc` packaging. Two things are added.
 *
 *  1. REAL selectionParams. `catalog.ts` emits a clearly-labelled FIXTURE because the KV registry
 *     stores only {namespace, track, region, started_at}. A rig descriptor carries the actual encode
 *     — width, height, rate, codec, bitrate — per viewport, so every track here gets true values and
 *     nothing in this module reads a FIXTURE_ constant.
 *
 *  2. A `wave-viewport` extension block per track, plus a `wave-rig` block at the root. MSF's catalog
 *     is an extensible JSON object; the viewport model needs three things it has no field for:
 *     viewport identity and geometry, the canvas tile map, and the timing grid. They live under
 *     vendor-prefixed keys so an MSF parser that ignores unknown keys still reads a valid catalog and
 *     still sees 17 ordinary video tracks.
 *
 * DISCOVERY SHAPE. `renderGroup` binds every track of one rig (catalogformat §3.2.13) — canvas and
 * viewports are meant to be presented together. `altGroup` binds a viewport's renditions to each
 * other (the CMSF switching-set rule): renditions are ADDITIONAL tracks sharing an altGroup, never
 * subgroups, so a 3-rung ladder over 16 viewports is 48 media tracks and each rung stays
 * independently subscribable, prioritisable and cancellable.
 *
 * AGENT PATH (draft-19). `SUBSCRIBE_TRACKS` + a Track Property filter answers "every track in this
 * namespace where viewport role = follow" with no bespoke API. Until we run -19 the same query is
 * answered by reading this catalog — same fields, one extra round trip. That degradation is the
 * reason the role and the tile map are catalog data and not only wire properties.
 */
import { CATALOG_VERSION, MSF_PACKAGING, MSF_STREAMING_FORMAT, MSF_STREAMING_FORMAT_VERSION, type CatalogTrack, type MsfCatalog } from './catalog';
import {
  CANVAS_TRACK_NAME,
  VIEWPORT_ROLE,
  groupDurationNs,
  viewportTrackName,
  type RationalRate,
  type RigDescriptor,
  type ViewportRole,
} from './viewport-model';

/** Per-track viewport extension block. Vendor-prefixed; unknown keys are ignorable by an MSF parser. */
export interface CatalogViewportBlock {
  /** Stable viewport id, matching the VIEWPORT_ID Object Property on every object of this track. */
  id: number;
  role: ViewportRole;
  rigId: string;
  /** Rig-relative extrinsics at declaration time (per-frame pose rides the Object Property). */
  pose: { position: [number, number, number]; orientation: [number, number, number, number] };
  intrinsics: { fx: number; fy: number; cx: number; cy: number };
  /** Where this viewport appears in the canvas mosaic. */
  canvasTile: { row: number; col: number };
  /** False for a declared-but-not-yet-producing slot — the catalog lists all 16, live or not. */
  active: boolean;
  /** Objects this track emits per group. A track slower than the grid emits sparse Object IDs. */
  objectsPerGroup: number;
}

/** Root-level rig block: the timing grid and the canvas tile map — everything needed to interpret IDs. */
export interface CatalogRigBlock {
  rigId: string;
  timing: {
    /** MUST be 'TAI'. A UTC-derived clock replays a second at a leap second and duplicates Group IDs. */
    timescale: 'TAI';
    gridRate: { num: number; den: number };
    framesPerGroup: number;
    groupDurationNs: string; // decimal string — exceeds Number.MAX_SAFE_INTEGER in the general case
    /** 0 = Group IDs are absolute TAI-derived (stateless, and what we recommend). */
    groupEpochTaiNs: string;
    /** The formula, restated in the catalog so an implementer never has to guess it. */
    mapping: 'frameIndex = round(t_TAI_ns * gridRate.num / (gridRate.den * 1e9)); groupId = floor(frameIndex / framesPerGroup); objectId = frameIndex mod framesPerGroup';
  };
  canvas: {
    trackName: string;
    rows: number;
    cols: number;
    /** Row-major tile map: tileOrder[row * cols + col] = viewport id, or null for an empty tile. */
    tileOrder: Array<number | null>;
  };
  /** The measured guidance, published so a client does not have to rediscover it the hard way. */
  recommendedMaxConcurrentSubscriptions: number;
}

/** A catalog track carrying the viewport extension. */
export interface ViewportCatalogTrack extends CatalogTrack {
  altGroup?: number;
  'wave-viewport'?: CatalogViewportBlock;
}

/** The full multi-viewport catalog document. */
export interface ViewportCatalog extends MsfCatalog {
  tracks: ViewportCatalogTrack[];
  'wave-rig': CatalogRigBlock;
}

/** Objects a track emits per group: (track rate / grid rate) × framesPerGroup, exact and integral. */
export function objectsPerGroup(trackRate: RationalRate, rig: RigDescriptor): number {
  const grid = rig.grid;
  // objectsPerGroup = (trackRate / gridRate) * framesPerGroup, as EXACT integer ratio arithmetic.
  // The rate is rational on purpose: 60000/1001 is a real broadcast rate, and an integer-only
  // framerate silently desyncs against a 1000/1001-pulldown source — see viewport-model.ts.
  const numer = trackRate.num * grid.rate.den * grid.framesPerGroup;
  const denom = trackRate.den * grid.rate.num;
  if (numer % denom !== 0) {
    throw new RangeError(`track rate ${trackRate.num}/${trackRate.den} does not divide the grid ${grid.rate.num}/${grid.rate.den} into whole objects per group`);
  }
  return numer / denom;
}

/**
 * Build the multi-viewport catalog: one canvas track + one track per declared viewport.
 *
 * Track order is canvas-first, then viewports by ascending id. That is not cosmetic — the canvas is
 * what a joining client subscribes to first, and putting it at index 0 means a client that reads the
 * catalog top-down can issue its first SUBSCRIBE before it has finished parsing.
 */
export function buildViewportCatalog(rig: RigDescriptor): ViewportCatalog {
  assertRig(rig);

  const canvasTrack: ViewportCatalogTrack = {
    name: CANVAS_TRACK_NAME,
    packaging: MSF_PACKAGING,
    renderGroup: 1,
    selectionParams: {
      codec: rig.canvas.codec,
      mimeType: rig.canvas.mimeType,
      width: rig.canvas.width,
      height: rig.canvas.height,
      framerate: rig.canvas.rate.num / rig.canvas.rate.den,
      bitrate: rig.canvas.bitrate,
    },
    'wave-viewport': {
      id: -1,
      role: VIEWPORT_ROLE.CANVAS,
      rigId: rig.rigId,
      pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
      intrinsics: { fx: 0, fy: 0, cx: 0, cy: 0 },
      canvasTile: { row: -1, col: -1 },
      active: true,
      objectsPerGroup: objectsPerGroup(rig.canvas.rate, rig),
    },
  };

  const viewportTracks: ViewportCatalogTrack[] = [...rig.viewports]
    .sort((a, b) => a.id - b.id)
    .map((v) => ({
      name: viewportTrackName(v.id),
      packaging: MSF_PACKAGING,
      renderGroup: 1,
      // Each viewport is its own switching set: renditions of THIS viewport share this altGroup.
      // Distinct per viewport, so viewport 3's 720p rung is never mistaken for an alternate of
      // viewport 4 (which is a different camera, not a different quality of the same camera).
      altGroup: v.id + 1,
      selectionParams: {
        codec: v.codec,
        mimeType: v.mimeType,
        width: v.width,
        height: v.height,
        framerate: v.rate.num / v.rate.den,
        bitrate: v.bitrate,
      },
      'wave-viewport': {
        id: v.id,
        role: v.role,
        rigId: rig.rigId,
        pose: v.pose,
        intrinsics: v.intrinsics,
        canvasTile: v.canvasTile,
        active: v.active,
        objectsPerGroup: objectsPerGroup(v.rate, rig),
      },
    }));

  const tileOrder: Array<number | null> = Array.from({ length: rig.canvas.rows * rig.canvas.cols }, () => null);
  for (const v of rig.viewports) tileOrder[v.canvasTile.row * rig.canvas.cols + v.canvasTile.col] = v.id;

  return {
    version: CATALOG_VERSION,
    streamingFormat: MSF_STREAMING_FORMAT,
    streamingFormatVersion: MSF_STREAMING_FORMAT_VERSION,
    // Viewports come and go — a rig is dynamic — so the catalog track is delta-updatable. The first
    // catalog object of a new group is still complete and independent (MSF §5).
    supportsDeltaUpdates: true,
    commonTrackFields: { packaging: MSF_PACKAGING, namespace: rig.namespace.join('/') },
    tracks: [canvasTrack, ...viewportTracks],
    'wave-rig': {
      rigId: rig.rigId,
      timing: {
        timescale: 'TAI',
        gridRate: { num: rig.grid.rate.num, den: rig.grid.rate.den },
        framesPerGroup: rig.grid.framesPerGroup,
        groupDurationNs: groupDurationNs(rig.grid).toString(),
        groupEpochTaiNs: rig.grid.groupEpochTaiNs.toString(),
        mapping:
          'frameIndex = round(t_TAI_ns * gridRate.num / (gridRate.den * 1e9)); groupId = floor(frameIndex / framesPerGroup); objectId = frameIndex mod framesPerGroup',
      },
      canvas: { trackName: CANVAS_TRACK_NAME, rows: rig.canvas.rows, cols: rig.canvas.cols, tileOrder },
      recommendedMaxConcurrentSubscriptions: 4,
    },
  };
}

/** Every track name this rig publishes, canvas first — the set a relay must be configured with. */
export function rigTrackNames(rig: RigDescriptor): string[] {
  return [CANVAS_TRACK_NAME, ...[...rig.viewports].sort((a, b) => a.id - b.id).map((v) => viewportTrackName(v.id))];
}

function assertRig(rig: RigDescriptor): void {
  if (rig.viewports.length === 0) throw new RangeError('a rig needs at least one viewport');
  if (rig.viewports.length > rig.canvas.rows * rig.canvas.cols) {
    throw new RangeError(`rig has ${rig.viewports.length} viewports but the canvas is only ${rig.canvas.rows}x${rig.canvas.cols}`);
  }
  const ids = new Set<number>();
  const tiles = new Set<string>();
  for (const v of rig.viewports) {
    if (ids.has(v.id)) throw new RangeError(`duplicate viewport id ${v.id}`);
    ids.add(v.id);
    const tile = `${v.canvasTile.row},${v.canvasTile.col}`;
    if (tiles.has(tile)) throw new RangeError(`duplicate canvas tile ${tile}`);
    tiles.add(tile);
    if (v.canvasTile.row < 0 || v.canvasTile.row >= rig.canvas.rows || v.canvasTile.col < 0 || v.canvasTile.col >= rig.canvas.cols) {
      throw new RangeError(`viewport ${v.id} tile ${tile} is outside the ${rig.canvas.rows}x${rig.canvas.cols} canvas`);
    }
    objectsPerGroup(v.rate, rig); // throws if the rate does not divide the grid
  }
}
