/**
 * MSF Catalog Format unit tests — asserts the document shape matches
 * draft-ietf-moq-catalogformat-01 (root + per-track required fields) and that the
 * MSF (draft-ietf-moq-msf-00) streamingFormat id (0x001) + LOC packaging are emitted.
 */
import { describe, it, expect } from 'vitest';
import {
  buildMsfCatalog,
  MSF_STREAMING_FORMAT,
  MSF_STREAMING_FORMAT_VERSION,
  CATALOG_VERSION,
  MSF_PACKAGING,
  type TrackRegistryEntry,
} from '../src/catalog';

const VIDEO: TrackRegistryEntry = { namespace: 'wave', track: 'cam-1', region: 'ewr', publisher_started_at: '2026-06-21T00:00:00Z' };
const AUDIO: TrackRegistryEntry = { namespace: 'wave', track: 'audio-main', region: 'ewr' };
const OTHER_NS: TrackRegistryEntry = { namespace: 'other', track: 'screen', region: 'lhr' };

describe('buildMsfCatalog — root document (catalogformat §3.2)', () => {
  it('emits the three REQUIRED root fields with MSF identifiers', () => {
    const cat = buildMsfCatalog([VIDEO]);
    // §3.2 version MUST be 1
    expect(cat.version).toBe(CATALOG_VERSION);
    expect(cat.version).toBe(1);
    // §3.2.1 streamingFormat — MSF registry type 0x001 (msf §IANA)
    expect(cat.streamingFormat).toBe(MSF_STREAMING_FORMAT);
    expect(cat.streamingFormat).toBe(1);
    // §3.2.2 streamingFormatVersion — string "1" (msf §5)
    expect(cat.streamingFormatVersion).toBe(MSF_STREAMING_FORMAT_VERSION);
    expect(typeof cat.streamingFormatVersion).toBe('string');
  });

  it('declares no delta-update support (§3.2.3) — relay emits full catalogs', () => {
    expect(buildMsfCatalog([VIDEO]).supportsDeltaUpdates).toBe(false);
  });

  it('hoists a uniform namespace + packaging into commonTrackFields (§3.2.4)', () => {
    const cat = buildMsfCatalog([VIDEO, AUDIO]);
    expect(cat.commonTrackFields.packaging).toBe(MSF_PACKAGING);
    expect(cat.commonTrackFields.namespace).toBe('wave');
    // Hoisted → tracks omit per-track namespace (§3.2.9)
    expect(cat.tracks.every((t) => t.namespace === undefined)).toBe(true);
  });

  it('keeps per-track namespace when namespaces differ (§3.2.9)', () => {
    const cat = buildMsfCatalog([VIDEO, OTHER_NS]);
    expect(cat.commonTrackFields.namespace).toBeUndefined();
    expect(cat.tracks.map((t) => t.namespace).sort()).toEqual(['other', 'wave']);
  });

  it('returns an empty tracks array (still spec-valid) for no publishers', () => {
    const cat = buildMsfCatalog([]);
    expect(cat.tracks).toEqual([]);
    expect(cat.version).toBe(1);
  });
});

describe('buildMsfCatalog — per-track fields (catalogformat §3.2.10–§3.2.21)', () => {
  it('every track carries the REQUIRED name + packaging fields', () => {
    const cat = buildMsfCatalog([VIDEO, AUDIO]);
    for (const t of cat.tracks) {
      expect(typeof t.name).toBe('string'); // §3.2.10 REQUIRED
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.packaging).toBe('loc'); // §3.2.11 REQUIRED — MSF uses LOC
      expect(t.renderGroup).toBe(1); // §3.2.13
    }
  });

  it('video track gets a spec-shaped H.264 codec string in selectionParams (§3.2.17/§3.2.21)', () => {
    const t = buildMsfCatalog([VIDEO]).tracks[0];
    expect(t.name).toBe('cam-1');
    expect(t.selectionParams.codec).toBe('avc1.640028');
    expect(t.selectionParams.width).toBe(1280);
    expect(t.selectionParams.height).toBe(720);
    expect(t.selectionParams.framerate).toBe(30);
    expect(t.selectionParams.bitrate).toBeTypeOf('number');
  });

  it('audio track gets an Opus codec + samplerate/channelConfig (§3.2.21/§3.2.27/§3.2.28)', () => {
    const t = buildMsfCatalog([AUDIO]).tracks[0];
    expect(t.name).toBe('audio-main');
    expect(t.selectionParams.codec).toBe('opus');
    expect(t.selectionParams.samplerate).toBe(48_000);
    expect(t.selectionParams.channelConfig).toBe('2');
  });

  it('serializes to JSON round-trip identically (wire-shape stability)', () => {
    const cat = buildMsfCatalog([VIDEO, AUDIO]);
    expect(JSON.parse(JSON.stringify(cat))).toEqual(cat);
  });
});
