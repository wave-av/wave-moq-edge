/**
 * StreamingHasher — re-export shim. The implementation now lives in @wave-av/content-hash
 * (one SSOT). Keeps the local './streaming-hasher' import path stable. Repin task: SB-P0.8.
 *
 * Source: @wave-av/content-hash@0.1.0 (wave-foundation).
 */
export { StreamingHasher } from '@wave-av/content-hash';
