/// <reference types="@cloudflare/workers-types" />
/**
 * MoQ → gateway recordings-registry register (lights the clip/replay chain).
 *
 * After SessionRecorder lands a publisher session's bytes in R2 under an ORG-PREFIXED key, this flushes
 * a register call to the gateway so the object becomes a resolvable `iso_recordings` row that the clip
 * engine (and VOD/replay) can find. Inverse of /resolve; matches the gateway's
 * src/recordings.ts handleRecordingsRegister EXACTLY:
 *   POST {GATEWAY_BASE_URL}/v1/internal/recordings/register
 *     Authorization: Bearer ${WAVE_SERVICE_TOKEN}
 *     { recordingId?, principal:{ org }, r2Key, bucket?, sourceProtocol?, kind? }
 *   → { ok, recordingId, org, kind } | { ok:false, reason }
 *
 * SAFETY GATES (mirror usage-emit.ts — why deploying this changes nothing on the live relay):
 *   • No org → SKIP. The gateway injects x-wave-org only on an authorized request; absent → no principal
 *     to own the row, and we NEVER fabricate one. (Also: register requires org be a UUID.)
 *   • GATEWAY_BASE_URL / WAVE_SERVICE_TOKEN / MOQ_RECORDINGS_BUCKET unset → SKIP (inert until the
 *     operator provisions them — same posture as the #284 usage emit).
 *   • r2Key not under `${org}/` → SKIP. The gateway enforces this (403); we never even send bytes the
 *     registry would reject as a tenant-boundary violation.
 *   • Any fetch error → swallowed. The bytes are already durable in R2; register is retryable and must
 *     NEVER affect the live relay (fail-soft).
 *
 * recordingId = the publisher sessionId (a UUID) → registration is idempotent by primary key: a
 * redelivered register hits an insert conflict (swallowed) rather than creating a duplicate row.
 */

/** The subset of the worker/DO env this reads. All optional → register is inert until provisioned. */
export interface RegisterRecordingEnv {
  GATEWAY_BASE_URL?: string;
  WAVE_SERVICE_TOKEN?: string;
  /** The bucket NAME the bytes live in (the R2 binding doesn't expose it) — sent so register can stamp the row. */
  MOQ_RECORDINGS_BUCKET?: string;
}

export interface RegisterRecordingArgs {
  org: string | null;
  /** The org-prefixed R2 key SessionRecorder wrote (`${org}/recordings/${sessionId}/recording.<ext>`). */
  r2Key: string;
  /** Publisher session UUID — used as the idempotent recordingId. */
  sessionId: string;
}

/** The gateway register envelope (matches the gateway's handleRecordingsRegister body). */
export interface RegisterEnvelope {
  recordingId: string;
  principal: { org: string };
  r2Key: string;
  bucket: string;
  sourceProtocol: 'moq';
  kind: 'recording';
}

/** True only when there is a real (org-prefixed) recording AND the operator has provisioned register. */
export function shouldRegister(env: RegisterRecordingEnv, a: RegisterRecordingArgs): boolean {
  if (!a.org) return false; // no principal → never fabricate an org to own the row
  if (!env.GATEWAY_BASE_URL || !env.WAVE_SERVICE_TOKEN || !env.MOQ_RECORDINGS_BUCKET) return false; // inert
  if (!a.r2Key) return false;
  return a.r2Key.startsWith(a.org + '/'); // the gateway's write-time tenant boundary (else it 403s)
}

/**
 * Build the register envelope, or null when {@link shouldRegister} says we must not. Pure (no I/O) so the
 * gate is unit-testable without a network.
 */
export function buildRegisterBody(env: RegisterRecordingEnv, a: RegisterRecordingArgs): RegisterEnvelope | null {
  if (!shouldRegister(env, a)) return null;
  return {
    recordingId: a.sessionId,
    principal: { org: a.org as string },
    r2Key: a.r2Key,
    bucket: env.MOQ_RECORDINGS_BUCKET as string,
    sourceProtocol: 'moq',
    kind: 'recording',
  };
}

/**
 * Flush one recording's registration to the gateway. Fire-and-forget friendly (call via
 * state.waitUntil); never throws. No-op (and no network) when {@link shouldRegister} is false.
 */
export async function registerRecording(env: RegisterRecordingEnv, a: RegisterRecordingArgs): Promise<void> {
  const body = buildRegisterBody(env, a);
  if (!body) return;
  const base = (env.GATEWAY_BASE_URL as string).replace(/\/+$/, '');
  try {
    await fetch(`${base}/v1/internal/recordings/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.WAVE_SERVICE_TOKEN as string}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    /* fail-soft: bytes are already durable in R2; register is retryable and must never affect the relay */
  }
}
