/**
 * Per-publisher microVM isolation boundary — control-plane routing (#144).
 *
 * WHAT THIS IS:
 *   The PURE routing/decision layer that maps a publisher's track to an ISOLATION CELL — the design
 *   pattern from wave-outreach PR #25's "TinyMoQ parity" grounding: each PUBLISHER's untrusted media
 *   is confined to its own isolated substrate so one hostile/buggy encoder cannot affect another's.
 *
 *   Today the MoQ relay confines each track to its own Durable Object (moq-session-do.ts) — good V8-
 *   isolate separation, but NOT a hardware/kernel isolation boundary for the UNTRUSTED MEDIA path.
 *   This module models the next tier: routing each publisher to a dedicated microVM cell.
 *
 * LAW #130 (HARD, non-negotiable) — client/untrusted media = CLOUD microVM ONLY:
 *   A per-publisher cell that will carry CLIENT media MUST target a cloud/isolated microVM host. It may
 *   NEVER be routed to the owned local rig. A `local-dev` substrate exists ONLY for internal-dev proofs
 *   and is LABELLED internal-dev-only; `rejectsLocalForClient()` is the fail-closed guard that makes
 *   routing client media to local-dev impossible. This is enforced in code here, not just in prose.
 *
 * HONESTY CONTRACT (mirrors src/moq-sfu-fanout.ts — no fabricated transport, ever):
 *   The microVM SPAWN is a `MicroVmBinding`-shaped interface (same shape discipline as the existing
 *   MOQ_SFU_FANOUT ContainerBinding). No such binding exists today, and CF Containers/microVM substrate
 *   is operator-gated. So when the feature is off — or on but unbound — the relay returns a TYPED, HONEST
 *   501 `MOQ_MICROVM_ISOLATION_NOT_ACTIVATED`. It NEVER claims a live isolated cell while none can run.
 *   Default-OFF behind `MOQ_MICROVM_ISOLATION`, so the live relay is unchanged until an operator opts in.
 *
 * PURE: no I/O; the cell descriptor is a data structure a caller then hands to the (absent) binding.
 */

/** The only substrate allowed for CLIENT/untrusted media (LAW #130). Every other value is dev-only. */
export type IsolationSubstrate = 'cloud-microvm' | 'local-dev';

/** Env knobs this layer reads (subset of the worker Env). */
export interface IsolationEnv {
  /** Default-OFF activation flag. Unset/"false" → honest 501. "true" only takes effect when a real
   *  MOQ_MICROVM binding is ALSO present — else still fail-closes to the typed 501. */
  MOQ_MICROVM_ISOLATION?: string;
  /** Which substrate cells are provisioned on. Defaults to 'cloud-microvm' (the LAW-#130-safe default).
   *  'local-dev' is ONLY honoured for internal-dev and NEVER for client media (guarded below). */
  MOQ_MICROVM_SUBSTRATE?: string;
  /** The microVM spawn binding — absent today (operator-gated). Absent → honest typed 501. */
  MOQ_MICROVM?: MicroVmBinding;
}

/** Minimal microVM-spawn binding shape (CF-Container/microVM `fetch`). Present only once an operator
 *  provisions the substrate. Kept local (no runtime dep) — the binding is what the runtime injects. */
export interface MicroVmBinding {
  fetch(request: Request): Promise<Response>;
}

/** A deterministic isolation-cell descriptor for one publisher's track. */
export interface IsolationCell {
  /** Stable per-publisher cell id — one cell per (org, namespace, track). */
  cellId: string;
  /** The substrate this cell runs on. For client media this is ALWAYS 'cloud-microvm' (LAW #130). */
  substrate: IsolationSubstrate;
  /** Logical host label the descriptor targets (opaque; the binding resolves it). */
  host: string;
  /** True when this substrate is safe to carry CLIENT/untrusted media (only 'cloud-microvm' is). */
  clientMediaSafe: boolean;
}

const CLOUD_HOST = 'wave-microvm-cloud'; // opaque logical cloud pool label (resolved by the binding)
const LOCAL_DEV_HOST = 'internal-dev-local'; // internal-dev ONLY — never client media (LAW #130)

/** Truthy check for the default-OFF activation flag. */
export function isolationEnabled(env: IsolationEnv): boolean {
  const v = (env.MOQ_MICROVM_ISOLATION ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Resolve the configured substrate. Anything that isn't the explicit internal-dev opt-in is the
 *  LAW-#130-safe cloud microVM. So the SAFE substrate is the DEFAULT; local-dev must be asked for. */
export function configuredSubstrate(env: IsolationEnv): IsolationSubstrate {
  return (env.MOQ_MICROVM_SUBSTRATE ?? '').trim().toLowerCase() === 'local-dev' ? 'local-dev' : 'cloud-microvm';
}

/**
 * PURE mapping: (org, namespace, track) → a per-publisher isolation cell descriptor. Deterministic so
 * the same publisher always lands in the same cell (sticky, like the DO idFromName rendezvous). The
 * cellId is org-scoped so two orgs sharing a track name never collide into one cell.
 */
export function isolationCellFor(
  org: string | null,
  namespace: string,
  track: string,
  env: IsolationEnv
): IsolationCell {
  const substrate = configuredSubstrate(env);
  const clientMediaSafe = substrate === 'cloud-microvm';
  const orgSeg = org && org.length > 0 ? org : 'anon';
  return {
    cellId: `cell:${orgSeg}:${namespace}:${track}`,
    substrate,
    host: substrate === 'cloud-microvm' ? CLOUD_HOST : LOCAL_DEV_HOST,
    clientMediaSafe,
  };
}

/** Structured result of the LAW-#130 guard. `ok:false` carries a machine-readable reason for the 403. */
export type IsolationGuardResult = { ok: true } | { ok: false; reason: string; law: 'LAW-130' };

/**
 * LAW #130 fail-closed guard: routing CLIENT/untrusted media to a non-cloud-microVM substrate is
 * FORBIDDEN. Returns `{ok:false}` (never throws into the hot path) when `isClientMedia` is true and the
 * cell is not a cloud microVM. Internal-dev (isClientMedia=false) may use local-dev. This makes the law
 * a code invariant, not a comment.
 */
export function rejectsLocalForClient(cell: IsolationCell, isClientMedia: boolean): IsolationGuardResult {
  if (isClientMedia && cell.substrate !== 'cloud-microvm') {
    return {
      ok: false,
      law: 'LAW-130',
      reason: `client/untrusted media may only run on a cloud microVM, not substrate '${cell.substrate}' (host ${cell.host})`,
    };
  }
  return { ok: true };
}

/** TRUE only when the flag is ON **and** a real microVM binding exists. Today: always false. */
export function microVmActivated(env: IsolationEnv): boolean {
  return isolationEnabled(env) && typeof env.MOQ_MICROVM?.fetch === 'function';
}

/** Seconds a client should wait before retrying — activation is operator-gated, not transient. */
export const MICROVM_RETRY_AFTER_SECONDS = 86_400;

/** Honest "not activated yet" body — accurate machine-readable state. Claims nothing live. */
export function notActivatedBody() {
  return {
    error: 'MOQ_MICROVM_ISOLATION_NOT_ACTIVATED',
    feature: 'per-publisher-microvm-isolation',
    status: 'not_activated',
    live: false,
    law: 'LAW-130: client/untrusted media = cloud microVM ONLY',
    blockers: [
      'provision the cloud microVM substrate (CF Containers / Kernel microVM) on a CLOUD account',
      'build + push the per-publisher relay-cell image',
      'provision the MOQ_MICROVM binding in wrangler.toml',
      'set MOQ_MICROVM_ISOLATION=true and MOQ_MICROVM_SUBSTRATE=cloud-microvm',
    ],
    docs: 'https://moq.wave.online/llms.txt',
  } as const;
}
