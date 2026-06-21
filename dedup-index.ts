/**
 * DedupIndex — re-export shim. The implementation now lives in @wave-av/content-hash
 * (one SSOT for StreamingHasher + DedupIndex, with the refcount-correct idempotent
 * claim/addRef model — see V2 in the Slice B activation plan). This file keeps the local
 * './dedup-index' import path stable so single-instance-writer.ts and tests resolve to the
 * consolidated package without churn.
 *
 * Source: @wave-av/content-hash@0.1.0 (wave-foundation). Repin task: SB-P0.8.
 */
export { makeDedupIndex, InMemoryDedupIndex, DEDUP_MIGRATION_SQL } from '@wave-av/content-hash';
export type { DedupIndex, ClaimResult, AddRefResult, ReleaseResult, IndexRow, RefTarget } from '@wave-av/content-hash';
