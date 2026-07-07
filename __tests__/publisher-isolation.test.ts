import { describe, it, expect } from 'vitest';
import {
  isolationEnabled,
  configuredSubstrate,
  isolationCellFor,
  rejectsLocalForClient,
  microVmActivated,
  notActivatedBody,
} from '../src/publisher-isolation';

describe('publisher-isolation (#144) — default-OFF + LAW-#130', () => {
  it('is OFF by default (no behavioral change to the live relay)', () => {
    expect(isolationEnabled({})).toBe(false);
    expect(isolationEnabled({ MOQ_MICROVM_ISOLATION: 'false' })).toBe(false);
    expect(isolationEnabled({ MOQ_MICROVM_ISOLATION: 'true' })).toBe(true);
    expect(isolationEnabled({ MOQ_MICROVM_ISOLATION: 'on' })).toBe(true);
  });

  it('defaults to the LAW-#130-safe cloud microVM substrate', () => {
    expect(configuredSubstrate({})).toBe('cloud-microvm');
    expect(configuredSubstrate({ MOQ_MICROVM_SUBSTRATE: 'local-dev' })).toBe('local-dev');
    expect(configuredSubstrate({ MOQ_MICROVM_SUBSTRATE: 'anything-else' })).toBe('cloud-microvm');
  });

  it('maps a publisher to a deterministic, org-scoped cell', () => {
    const a = isolationCellFor('orgA', 'orgA-live', 'cam1', {});
    const b = isolationCellFor('orgA', 'orgA-live', 'cam1', {});
    const c = isolationCellFor('orgB', 'orgA-live', 'cam1', {});
    expect(a).toEqual(b); // deterministic (sticky)
    expect(a.cellId).not.toEqual(c.cellId); // org-scoped — no cross-org collision
    expect(a.substrate).toBe('cloud-microvm');
    expect(a.clientMediaSafe).toBe(true);
  });

  it('LAW #130: FAIL-CLOSED — client media may NOT run on local-dev', () => {
    const localCell = isolationCellFor('orgA', 'orgA-live', 'cam1', { MOQ_MICROVM_SUBSTRATE: 'local-dev' });
    expect(localCell.clientMediaSafe).toBe(false);
    const denied = rejectsLocalForClient(localCell, /* isClientMedia */ true);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.law).toBe('LAW-130');
  });

  it('LAW #130: internal-dev (non-client) MAY use local-dev; cloud is always allowed', () => {
    const localCell = isolationCellFor('dev', 'dev-ns', 't', { MOQ_MICROVM_SUBSTRATE: 'local-dev' });
    expect(rejectsLocalForClient(localCell, /* isClientMedia */ false).ok).toBe(true);
    const cloudCell = isolationCellFor('orgA', 'orgA-live', 'cam1', {});
    expect(rejectsLocalForClient(cloudCell, true).ok).toBe(true);
  });

  it('microVmActivated is false today (no real binding) and the 501 body is honest', () => {
    expect(microVmActivated({ MOQ_MICROVM_ISOLATION: 'true' })).toBe(false);
    // Only activates when BOTH the flag is on AND a real binding is present.
    expect(microVmActivated({ MOQ_MICROVM_ISOLATION: 'true', MOQ_MICROVM: { fetch: async () => new Response() } })).toBe(true);
    const body = notActivatedBody();
    expect(body.live).toBe(false);
    expect(body.error).toBe('MOQ_MICROVM_ISOLATION_NOT_ACTIVATED');
    expect(body.law).toContain('LAW-130');
  });
});
