/// <reference types="@cloudflare/workers-types" />
/**
 * remote-dedup-index — adapt the wave-storage-meter `DedupRpc` service binding into the local
 * `DedupIndex` contract that SingleInstanceWriter calls (Slice B, SB-P2.1).
 *
 * moq-edge holds NO D1 of its own: the one canonical per-org dedup index lives in wave-storage-meter.
 * A Cloudflare service binding (env.WAVE_STORAGE_METER → entrypoint `DedupRpc`) exposes the index's six
 * methods as RPC; this thin adapter forwards each call so the writer is unaware it is talking across a
 * worker boundary. The method shapes mirror @wave-av/content-hash's DedupIndex exactly (the SSOT), so the
 * adapter is a pure pass-through — no logic, no divergence. Fail-safe (D1 down / RPC error) is the
 * writer's concern: it catches a throwing claim() and keeps the streamed object un-deduped.
 */
import type {
  DedupIndex,
  ClaimResult,
  AddRefResult,
  ReleaseResult,
  IndexRow,
  RefTarget,
} from './dedup-index';

/**
 * The structural shape of the wave-storage-meter `DedupRpc` service binding. Declared locally (rather
 * than imported from storage-meter) so moq-edge keeps full typing without a cross-repo dependency; it
 * mirrors the DedupIndex contract method-for-method, which is what makes the binding a drop-in index.
 */
export interface DedupService {
  claim(org: string, hash: string, key: string, bucket: string, bytes: number): Promise<ClaimResult>;
  addRef(org: string, refKey: string, hash: string, bucket: string): Promise<AddRefResult>;
  release(org: string, hash: string, bucket: string): Promise<ReleaseResult>;
  lookup(org: string, hash: string, bucket: string): Promise<IndexRow | null>;
  lookupRef(org: string, refKey: string): Promise<RefTarget | null>;
  refCountForHash(org: string, hash: string, bucket: string): Promise<number>;
}

/** Wrap a cross-worker DedupRpc service binding as the local DedupIndex the writer consumes. */
export function makeRemoteDedupIndex(svc: DedupService): DedupIndex {
  return {
    claim: (org, hash, key, bucket, bytes) => svc.claim(org, hash, key, bucket, bytes),
    addRef: (org, refKey, hash, bucket) => svc.addRef(org, refKey, hash, bucket),
    release: (org, hash, bucket) => svc.release(org, hash, bucket),
    lookup: (org, hash, bucket) => svc.lookup(org, hash, bucket),
    lookupRef: (org, refKey) => svc.lookupRef(org, refKey),
    refCountForHash: (org, hash, bucket) => svc.refCountForHash(org, hash, bucket),
  };
}
