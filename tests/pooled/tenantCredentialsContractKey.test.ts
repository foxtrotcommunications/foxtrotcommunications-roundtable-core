/**
 * tenantCredentials.getContractPartyKey (upgrade plan 5.1): the pooled
 * fetch of `roundtable-contract-{C}-{party}` rides the same tenant-keyed
 * 5-minute cache and audit log as connection credentials. The cache key is
 * (tenant, contract, party): the same contract key fetched for tenant A is
 * fetched AGAIN for tenant B (no cross-tenant reuse), and a different party
 * under the same contract is a different slot.
 */

const mockAccess = jest.fn();
jest.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({ accessSecretVersion: mockAccess })),
}));

process.env.GCP_PROJECT = 'proj-test';
const tc = require('../../server/tenantCredentials');

const payload = (party: string) => [{ payload: { data: Buffer.from(JSON.stringify({ key: 'ab'.repeat(32), version: 1, contractId: 'ctr_1', party })) } }];

beforeEach(() => {
  mockAccess.mockReset();
  tc.invalidateTenantCredentials('wsA');
  tc.invalidateTenantCredentials('wsB');
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('getContractPartyKey', () => {
  it('reads roundtable-contract-{C}-{party}/versions/latest in the project', async () => {
    mockAccess.mockResolvedValue(payload('wsB'));
    const r = await tc.getContractPartyKey('wsA', 'ctr_1', 'wsB');
    expect(r.party).toBe('wsB');
    expect(mockAccess).toHaveBeenCalledWith({ name: 'projects/proj-test/secrets/roundtable-contract-ctr_1-wsB/versions/latest' });
  });

  it('caches per (tenant, contract, party) — a second tenant refetches, a second party is a new slot', async () => {
    mockAccess.mockResolvedValue(payload('wsB'));
    await tc.getContractPartyKey('wsA', 'ctr_1', 'wsB');
    await tc.getContractPartyKey('wsA', 'ctr_1', 'wsB');
    expect(mockAccess).toHaveBeenCalledTimes(1);            // hit
    await tc.getContractPartyKey('wsB', 'ctr_1', 'wsB');    // other tenant, same secret
    expect(mockAccess).toHaveBeenCalledTimes(2);
    await tc.getContractPartyKey('wsA', 'ctr_1', 'wsA');    // same tenant, other party
    expect(mockAccess).toHaveBeenCalledTimes(3);
    await tc.getContractPartyKey('wsA', 'ctr_2', 'wsB');    // same tenant+party, other contract
    expect(mockAccess).toHaveBeenCalledTimes(4);
  });

  it('NOT_FOUND → null (negative-cached), no env fallback', async () => {
    process.env.RT_CONTRACT_KEYS = JSON.stringify({ ctr_1: { version: 1, party: 'wsB', key: 'cd'.repeat(32) } });
    mockAccess.mockRejectedValue(Object.assign(new Error('nf'), { code: 5 }));
    expect(await tc.getContractPartyKey('wsA', 'ctr_1', 'wsB')).toBeNull();
    expect(await tc.getContractPartyKey('wsA', 'ctr_1', 'wsB')).toBeNull();
    expect(mockAccess).toHaveBeenCalledTimes(1);
    delete process.env.RT_CONTRACT_KEYS;
  });

  it('transport errors propagate (never silently unauthenticated)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockAccess.mockRejectedValue(Object.assign(new Error('unavailable'), { code: 14 }));
    await expect(tc.getContractPartyKey('wsA', 'ctr_1', 'wsB')).rejects.toThrow('unavailable');
  });

  it('writes the audit line with the tenant it served', async () => {
    const log = console.log as jest.Mock;
    mockAccess.mockResolvedValue(payload('wsB'));
    await tc.getContractPartyKey('wsA', 'ctr_1', 'wsB');
    expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.includes('[credaudit] fetch workspace=wsA contract=ctr_1 party=wsB found=true'))).toBe(true);
  });

  it('shares the cache and the connection-credential fetch path (invalidateTenantCredentials drops it)', async () => {
    mockAccess.mockResolvedValue(payload('wsB'));
    await tc.getContractPartyKey('wsA', 'ctr_1', 'wsB');
    expect(tc.invalidateTenantCredentials('wsA')).toBe(1);
    await tc.getContractPartyKey('wsA', 'ctr_1', 'wsB');
    expect(mockAccess).toHaveBeenCalledTimes(2);
  });
});
