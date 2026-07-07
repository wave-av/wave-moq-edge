/**
 * DARK publish-time provenance + isolation hook (#144) — the composition point.
 *
 * Wires the two #144 primitives into ONE flag-gated decision the publish handler calls:
 *   1. per-publisher microVM isolation routing (src/publisher-isolation.ts) + LAW-#130 guard, and
 *   2. bearer-token provenance verify + C2PA-shaped attestation stamp (src/provenance.ts).
 *
 * DEFAULT-OFF: when MOQ_MICROVM_ISOLATION is off, this is a pure no-op (`{ action: 'noop' }`) and the
 * live publish path is byte-for-byte unchanged. It only ever ADDS a response header / fail-closes a
 * bad provenance token when the operator has explicitly flipped the flag. It NEVER fabricates a live
 * isolated cell: with the flag on but no real MOQ_MICROVM binding, it reports the honest 501 shape.
 *
 * PURE decision (no I/O beyond crypto.subtle via the provenance verify). The caller applies the result.
 */
import {
  isolationEnabled,
  isolationCellFor,
  rejectsLocalForClient,
  microVmActivated,
  notActivatedBody,
  type IsolationEnv,
  type IsolationCell,
} from './publisher-isolation';
import {
  verifyProvenanceToken,
  buildProvenanceAttestation,
  WAVE_PROV_PREFIX,
  type ProvenanceAttestation,
} from './provenance';

/** Env this hook reads. */
export interface ProvenanceHookEnv extends IsolationEnv {
  /** Shared per-deployment provenance secret (HMAC key). Set via `wrangler secret put WAVE_PROVENANCE_SECRET`.
   *  Absent → provenance verify always fails closed. */
  WAVE_PROVENANCE_SECRET?: string;
}

/** The hook's decision. The publish handler applies whichever variant it gets. */
export type ProvenanceHookResult =
  | { action: 'noop' } //                     flag off → live path unchanged
  | { action: 'not_activated'; body: ReturnType<typeof notActivatedBody> } // flag on, no real binding
  | { action: 'reject'; status: number; reason: string } //  LAW-#130 or fail-closed provenance
  | { action: 'stamp'; cell: IsolationCell; attestation: ProvenanceAttestation }; // verified + bound

/** Pull the provenance token from `x-wave-provenance` header (server-to-server) — distinct carrier from
 *  the wave-token-v1 entitlement bearer (Authorization), so the two never collide. */
export function extractProvenanceToken(request: Request): string | null {
  const h = request.headers.get('x-wave-provenance');
  if (!h) return null;
  const t = h.trim();
  return t.startsWith(WAVE_PROV_PREFIX) ? t : null;
}

/**
 * Evaluate the DARK provenance+isolation hook for a publish. All CLIENT-media routing is treated as
 * untrusted (isClientMedia=true) — LAW #130 forbids a non-cloud-microVM cell for it. `contentSample`
 * is a small bytes sample used for the C2PA content-binding hash (e.g. the first object / keyframe).
 */
export async function evaluatePublishProvenance(
  request: Request,
  env: ProvenanceHookEnv,
  namespace: string,
  track: string,
  org: string | null,
  contentSample: Uint8Array
): Promise<ProvenanceHookResult> {
  // Default-OFF: the live relay is unchanged.
  if (!isolationEnabled(env)) return { action: 'noop' };

  // Flag on but no real microVM binding → honest 501 (never fabricate a live isolated cell).
  if (!microVmActivated(env)) return { action: 'not_activated', body: notActivatedBody() };

  // Route this publisher to its isolation cell, then enforce LAW #130 (client media = cloud microVM only).
  const cell = isolationCellFor(org, namespace, track, env);
  const guard = rejectsLocalForClient(cell, /* isClientMedia */ true);
  if (!guard.ok) return { action: 'reject', status: 403, reason: `${guard.law}: ${guard.reason}` };

  // Verify the provenance bearer token, FAIL-CLOSED.
  const token = extractProvenanceToken(request);
  const verified = await verifyProvenanceToken(token, env.WAVE_PROVENANCE_SECRET);
  if (!verified.valid) {
    return { action: 'reject', status: 403, reason: `provenance_${verified.reason}` };
  }

  // The claim must bind to THIS track (no cross-track provenance replay).
  if (verified.claim.namespace !== namespace || verified.claim.track !== track) {
    return { action: 'reject', status: 403, reason: 'provenance_track_mismatch' };
  }

  const attestation = await buildProvenanceAttestation(verified.claim, contentSample);
  return { action: 'stamp', cell, attestation };
}
