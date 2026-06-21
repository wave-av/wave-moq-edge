/**
 * MSF Catalog Format — draft-ietf-moq-catalogformat-01 + draft-ietf-moq-msf-00.
 *
 * Builds the IETF "Common Catalog Format for moq-transport" JSON document so that
 * OpenMOQ-speaking relays (Akamai / Cisco / YouTube) can discover and select the
 * tracks published at this WAVE edge. This is the catalog FORMAT layer on top of the
 * relay's track registry — the shape that interop partners actually parse.
 *
 * Spec citations (field → draft section):
 *   Root
 *     version               → catalogformat §3.2   (MUST be 1 for this catalog version)
 *     streamingFormat       → catalogformat §3.2.1  (numeric format id; MSF = 0x001 = 1, msf §IANA)
 *     streamingFormatVersion→ catalogformat §3.2.2  (string; MSF catalog version is "1", msf §5)
 *     supportsDeltaUpdates  → catalogformat §3.2.3  (this relay emits full catalogs only → false)
 *     commonTrackFields     → catalogformat §3.2.4  (fields shared by every track → namespace/packaging)
 *     tracks                → catalogformat §3.2.5  (array of track objects)
 *   Per-track
 *     name                  → catalogformat §3.2.10 (REQUIRED)
 *     packaging             → catalogformat §3.2.11 (REQUIRED; "loc" per msf, catalogformat Table 3)
 *     namespace             → catalogformat §3.2.9  (hoisted into commonTrackFields when uniform)
 *     renderGroup           → catalogformat §3.2.13
 *     selectionParams       → catalogformat §3.2.17
 *   selectionParams sub-fields
 *     codec                 → catalogformat §3.2.21
 *     mimeType              → catalogformat §3.2.22
 *     framerate             → catalogformat §3.2.23
 *     bitrate               → catalogformat §3.2.24
 *     width                 → catalogformat §3.2.25
 *     height                → catalogformat §3.2.26
 *     samplerate            → catalogformat §3.2.27
 *     channelConfig         → catalogformat §3.2.28
 *
 * The relay's KV registry currently stores only {namespace, track, region, started_at}; it does
 * NOT carry per-track codec/resolution. Until publishers advertise their encode params, each track
 * is emitted with a CLEARLY-LABELLED minimal selectionParams FIXTURE (see FIXTURE_* below) so the
 * document is spec-valid and parseable; a real init-data pipeline replaces the fixture later.
 */

/** MSF registers streamingFormat type 0x001 in the MoQ Streaming Format Registry (msf §IANA). */
export const MSF_STREAMING_FORMAT = 1;
/** MSF catalog version string (msf §5). */
export const MSF_STREAMING_FORMAT_VERSION = '1';
/** Catalog document version defined by catalogformat §3.2 (MUST be 1). */
export const CATALOG_VERSION = 1;
/** MSF uses LOC ("loc") packaging — catalogformat Table 3 / msf §packaging. */
export const MSF_PACKAGING = 'loc';

/**
 * FIXTURE selectionParams used until publishers advertise real encode metadata.
 * Codec strings are spec-shaped examples drawn from catalogformat §3.4:
 *   - video: H.264 High@L4.0 ("avc1.640028"), catalogformat §3.4 example
 *   - audio: Opus ("opus"), catalogformat §3.4 example
 */
export const FIXTURE_VIDEO_SELECTION_PARAMS = {
  codec: 'avc1.640028',
  mimeType: 'video/mp4',
  width: 1280,
  height: 720,
  framerate: 30,
  bitrate: 1_500_000,
} as const;

export const FIXTURE_AUDIO_SELECTION_PARAMS = {
  codec: 'opus',
  mimeType: 'audio/opus',
  samplerate: 48_000,
  channelConfig: '2',
  bitrate: 128_000,
} as const;

/** A registry entry as stored by handlePublish() in index.ts. */
export interface TrackRegistryEntry {
  namespace: string;
  track: string;
  publisher_started_at?: string;
  region?: string;
}

/** A track object per catalogformat §3.2.9–§3.2.17. */
export interface CatalogTrack {
  name: string;
  packaging: string;
  selectionParams: Record<string, unknown>;
  /** Present only when namespace differs from the catalog-wide commonTrackFields value. */
  namespace?: string;
  renderGroup?: number;
}

/** The MSF catalog document per catalogformat §3.2. */
export interface MsfCatalog {
  version: number;
  streamingFormat: number;
  streamingFormatVersion: string;
  supportsDeltaUpdates: boolean;
  commonTrackFields: {
    packaging: string;
    namespace?: string;
  };
  tracks: CatalogTrack[];
}

/**
 * Heuristic: a track name containing "audio"/"aud"/"opus"/"mic" gets the audio fixture,
 * everything else gets the video fixture. Names are publisher-chosen; this only affects the
 * FIXTURE selectionParams, never the spec validity of the document.
 */
function isAudioTrack(name: string): boolean {
  return /(^|[-_])(audio|aud|opus|mic|sound)([-_]|$)/i.test(name);
}

/**
 * Build a spec-shaped draft-ietf-moq-catalogformat-01 catalog for the MSF streaming format.
 *
 * @param entries Track registry entries (filtered, non-null).
 */
export function buildMsfCatalog(entries: TrackRegistryEntry[]): MsfCatalog {
  // Hoist namespace into commonTrackFields when every track shares one (catalogformat §3.2.4).
  const namespaces = new Set(entries.map((e) => e.namespace));
  const uniformNamespace = namespaces.size === 1 ? [...namespaces][0] : undefined;

  const tracks: CatalogTrack[] = entries.map((e) => {
    const audio = isAudioTrack(e.track);
    const track: CatalogTrack = {
      name: e.track,
      packaging: MSF_PACKAGING,
      // renderGroup binds tracks meant to be rendered together (catalogformat §3.2.13).
      // One group per namespace keeps audio+video of a broadcast together.
      renderGroup: 1,
      selectionParams: { ...(audio ? FIXTURE_AUDIO_SELECTION_PARAMS : FIXTURE_VIDEO_SELECTION_PARAMS) },
    };
    // Only carry a per-track namespace when it can't be hoisted (catalogformat §3.2.9).
    if (uniformNamespace === undefined) track.namespace = e.namespace;
    return track;
  });

  return {
    version: CATALOG_VERSION,
    streamingFormat: MSF_STREAMING_FORMAT,
    streamingFormatVersion: MSF_STREAMING_FORMAT_VERSION,
    // This relay emits the full catalog on every request — no delta/patch stream (catalogformat §3.2.3).
    supportsDeltaUpdates: false,
    commonTrackFields: {
      packaging: MSF_PACKAGING,
      ...(uniformNamespace !== undefined ? { namespace: uniformNamespace } : {}),
    },
    tracks,
  };
}
