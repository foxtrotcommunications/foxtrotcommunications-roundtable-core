/**
 * Contract liveness (upgrade plan 1.2): status === 'active' AND not past
 * expiresAt, enforced in findAndValidateContract and again in the pooled
 * tenant resolver. A listed-but-lapsed contract is not an authorization.
 */

jest.mock('../../server/utils/fetchManifest', () => ({
  fetchManifest: jest.fn(),
}));

const {
  findAndValidateContract,
  contractLivenessError,
  parseExpiresAt,
} = require('../../server/utils/contractAuth');
import { resolveTenantFromRequest, TENANT_HEADER } from '../../server/pooled/tenantResolver';
const { fetchManifest } = require('../../server/utils/fetchManifest');

const NOW = Date.now();
const PAST = new Date(NOW - 60_000).toISOString();
const FUTURE = new Date(NOW + 60 * 60_000).toISOString();

function contract(extra: Record<string, unknown> = {}) {
  return { contractId: 'c-1', status: 'active', allowedActions: ['capability:x'], ...extra };
}

describe('parseExpiresAt', () => {
  it('reads ISO strings, epoch ms, epoch seconds, numeric strings and Firestore-style objects', () => {
    expect(parseExpiresAt(FUTURE)).toBe(new Date(FUTURE).getTime());
    expect(parseExpiresAt(1_800_000_000_000)).toBe(1_800_000_000_000);
    expect(parseExpiresAt(1_800_000_000)).toBe(1_800_000_000_000);
    expect(parseExpiresAt('1800000000000')).toBe(1_800_000_000_000);
    expect(parseExpiresAt({ seconds: 1_800_000_000 })).toBe(1_800_000_000_000);
    expect(parseExpiresAt({ _seconds: 1_800_000_000, _nanoseconds: 0 })).toBe(1_800_000_000_000);
    expect(parseExpiresAt({ toMillis: () => 42 })).toBe(42);
  });
  it('returns null when absent and NaN when unreadable', () => {
    expect(parseExpiresAt(undefined)).toBeNull();
    expect(parseExpiresAt(null)).toBeNull();
    expect(parseExpiresAt('')).toBeNull();
    expect(Number.isNaN(parseExpiresAt('not a date'))).toBe(true);
    expect(Number.isNaN(parseExpiresAt({ foo: 1 }))).toBe(true);
  });
});

describe('contractLivenessError', () => {
  it('passes an active contract without expiresAt', () => {
    expect(contractLivenessError(contract())).toBeUndefined();
  });
  it('passes an active contract with a future expiresAt', () => {
    expect(contractLivenessError(contract({ expiresAt: FUTURE }))).toBeUndefined();
  });
  it('rejects a past expiresAt', () => {
    expect(contractLivenessError(contract({ expiresAt: PAST }))).toMatch(/expired at/);
  });
  it('rejects exactly-now as expired (boundary is inclusive)', () => {
    expect(contractLivenessError(contract({ expiresAt: NOW }), NOW)).toMatch(/expired/);
  });
  it('rejects an unreadable expiresAt (fail closed)', () => {
    expect(contractLivenessError(contract({ expiresAt: 'soon' }))).toMatch(/unreadable expiresAt/);
  });
  it('rejects non-active statuses regardless of expiry', () => {
    for (const status of ['pending', 'revoked', 'pending_amendment', 'expired', undefined]) {
      expect(contractLivenessError(contract({ status, expiresAt: FUTURE }))).toMatch(/not active/);
    }
  });
});

describe('findAndValidateContract', () => {
  it('rejects an expired contract even when the action is allowed', () => {
    const { contract: c, error } = findAndValidateContract([contract({ expiresAt: PAST })], 'c-1', 'capability:x');
    expect(c).toBeUndefined();
    expect(error).toMatch(/expired/);
  });
  it('accepts a live contract with a future expiry', () => {
    const { contract: c, error } = findAndValidateContract([contract({ expiresAt: FUTURE })], 'c-1', 'capability:x');
    expect(error).toBeUndefined();
    expect(c.contractId).toBe('c-1');
  });
  it('rejects a revoked contract', () => {
    const { error } = findAndValidateContract([contract({ status: 'revoked' })], 'c-1', 'capability:x');
    expect(error).toMatch(/not active/);
  });
});

describe('tenantResolver enforces liveness', () => {
  beforeEach(() => (fetchManifest as jest.Mock).mockReset());

  it('403s on an expired contract in the claimed tenant manifest', async () => {
    fetchManifest.mockResolvedValue({ RT_CONTRACTS: [contract({ expiresAt: PAST })], RT_BRIDGES: [] });
    await expect(
      resolveTenantFromRequest({ headers: { [TENANT_HEADER]: 'ws-a' } }, { contractId: 'c-1', action: 'capability:x' }),
    ).rejects.toMatchObject({ name: 'TenantResolutionError', status: 403 });
  });

  it('403s on a non-active status', async () => {
    fetchManifest.mockResolvedValue({ RT_CONTRACTS: [contract({ status: 'pending' })], RT_BRIDGES: [] });
    await expect(
      resolveTenantFromRequest({ headers: { [TENANT_HEADER]: 'ws-a' } }, { contractId: 'c-1', action: 'capability:x' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('resolves a live contract with a future expiry', async () => {
    fetchManifest.mockResolvedValue({ RT_CONTRACTS: [contract({ expiresAt: FUTURE })], RT_BRIDGES: [] });
    const r = await resolveTenantFromRequest({ headers: { [TENANT_HEADER]: 'ws-a' } }, { contractId: 'c-1', action: 'capability:x' });
    expect(r.workspaceId).toBe('ws-a');
  });
});
