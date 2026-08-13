/**
 * Pooled tenant resolution — the claim/proof matrix.
 * The X-Rt-Tenant header is only a claim; membership of the request's
 * contract in the CLAIMED tenant's manifest is the authorization.
 */

jest.mock('../../server/utils/fetchManifest', () => ({
  fetchManifest: jest.fn(),
}));

import { resolveTenantFromRequest, TenantResolutionError, TENANT_HEADER } from '../../server/pooled/tenantResolver';
import { buildTenantContext } from '../../server/pooled/tenantContext';

const { fetchManifest } = require('../../server/utils/fetchManifest');

const CONTRACT = {
  contractId: 'contract-1',
  status: 'active',
  allowedActions: ['capability:plaid.getBalances'],
  direction: 'inbound',
};

function reqWithTenant(wsId?: string) {
  const headers: Record<string, unknown> = {};
  if (wsId !== undefined) headers[TENANT_HEADER] = wsId;
  return { headers };
}

beforeEach(() => {
  (fetchManifest as jest.Mock).mockReset();
});

describe('resolveTenantFromRequest', () => {
  it('resolves when the contract is in the claimed tenant manifest', async () => {
    fetchManifest.mockResolvedValue({ RT_CONTRACTS: [CONTRACT], RT_BRIDGES: [] });
    const resolved = await resolveTenantFromRequest(reqWithTenant('ws-a'), {
      contractId: 'contract-1',
      action: 'capability:plaid.getBalances',
    });
    expect(resolved.workspaceId).toBe('ws-a');
    expect(resolved.contract.contractId).toBe('contract-1');
    expect(fetchManifest).toHaveBeenCalledWith('ws-a');
  });

  it('401s without the tenant header', async () => {
    await expect(
      resolveTenantFromRequest(reqWithTenant(), { contractId: 'contract-1', action: 'message' }),
    ).rejects.toMatchObject({ name: 'TenantResolutionError', status: 401 });
    expect(fetchManifest).not.toHaveBeenCalled();
  });

  it('403s when the claimed tenant does not hold the contract (third-workspace claim)', async () => {
    // ws-c's manifest has no contract-1 — a caller with contract-1's key
    // cannot pivot to an unrelated tenant.
    fetchManifest.mockResolvedValue({ RT_CONTRACTS: [], RT_BRIDGES: [] });
    await expect(
      resolveTenantFromRequest(reqWithTenant('ws-c'), { contractId: 'contract-1', action: 'message' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('403s on a suspended contract', async () => {
    fetchManifest.mockResolvedValue({
      RT_CONTRACTS: [{ ...CONTRACT, status: 'suspended' }],
      RT_BRIDGES: [],
    });
    await expect(
      resolveTenantFromRequest(reqWithTenant('ws-a'), { contractId: 'contract-1', action: 'message' }),
    ).rejects.toBeInstanceOf(TenantResolutionError);
  });

  it('only warns (log-only) on non-inbound direction', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchManifest.mockResolvedValue({
      RT_CONTRACTS: [{ ...CONTRACT, direction: 'outbound' }],
      RT_BRIDGES: [],
    });
    const resolved = await resolveTenantFromRequest(reqWithTenant('ws-a'), {
      contractId: 'contract-1',
      action: 'message',
    });
    expect(resolved.workspaceId).toBe('ws-a');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('log-only'));
    warn.mockRestore();
  });
});

describe('buildTenantContext', () => {
  const config = require('../../server/config');

  it('builds a DB-only context when the manifest has no connections', async () => {
    const ctx = await buildTenantContext({
      workspaceId: 'ws-a',
      manifest: { RT_CONTRACTS: [], RT_BRIDGES: [] },
      contract: CONTRACT,
    });
    expect(ctx.workspaceId).toBe('ws-a');
    expect(ctx.databaseUrl).toBe(config.databaseUrl);
    expect(ctx.accessToken).toBeUndefined();
  });

  it('attaches credentials from the tenant connection when present', async () => {
    const credsMod = require('../../server/tenantCredentials');
    const spy = jest.spyOn(credsMod, 'getConnectionSecret').mockResolvedValue({
      access_token: 'tok-a', client_id: 'cid', secret: 'sec', env: 'production', item_id: 'item-1',
    });
    const ctx = await buildTenantContext({
      workspaceId: 'ws-a',
      manifest: { RT_CONTRACTS: [], RT_BRIDGES: [], RT_CONNECTIONS: [{ connId: 'conn-9', type: 'plaid' }] },
      contract: CONTRACT,
    });
    expect(spy).toHaveBeenCalledWith('ws-a', 'conn-9');
    expect(ctx.accessToken).toBe('tok-a');
    expect(ctx.itemId).toBe('item-1');
    spy.mockRestore();
  });

  it('continues without credentials when the secret fetch throws', async () => {
    const credsMod = require('../../server/tenantCredentials');
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const spy = jest.spyOn(credsMod, 'getConnectionSecret').mockRejectedValue(new Error('SM down'));
    const ctx = await buildTenantContext({
      workspaceId: 'ws-a',
      manifest: { RT_CONTRACTS: [], RT_BRIDGES: [], RT_CONNECTIONS: [{ connId: 'conn-9', type: 'plaid' }] },
      contract: CONTRACT,
    });
    expect(ctx.workspaceId).toBe('ws-a');
    expect(ctx.accessToken).toBeUndefined();
    spy.mockRestore();
    err.mockRestore();
  });
});
