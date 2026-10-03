/**
 * Per-party contract keys (upgrade plan 5.1) — derivation and resolution.
 *
 *   key(C, party) = HKDF-SHA256(master, info = "contract:{id}:{version}:party:{wsId}", 32)
 *
 * The test vector below is shared with the control plane
 * (api/tests/services/contractKeys.test.ts): master `test-master`, contract
 * `ctr_1`, version 1, party `wsA`. If either side drifts the two repos mint
 * different keys for the same party and every per-party signature fails.
 */

const mockGetContractPartyKey = jest.fn();
jest.mock('../../server/tenantCredentials', () => ({ getContractPartyKey: mockGetContractPartyKey }));

const ck = require('../../server/utils/contractKeys');

const VECTOR = {
  master: 'test-master',
  contractId: 'ctr_1',
  version: 1,
  party: 'wsA',
  hex: '3a9fd0af18f5993b964587aeac29ea7458a9885dd495c10aa87a3308a4124282',
};
const WSB_HEX = '26864f9470eeddb18d7cbdae414dee6dbea02bbb9a2e8b514af419aba703cc4e';

const SAVED_KEYS = process.env.RT_CONTRACT_KEYS;
const SAVED_FLAG = process.env.RT_ACCEPT_ORG_KEY;
afterEach(() => {
  if (SAVED_KEYS === undefined) delete process.env.RT_CONTRACT_KEYS; else process.env.RT_CONTRACT_KEYS = SAVED_KEYS;
  if (SAVED_FLAG === undefined) delete process.env.RT_ACCEPT_ORG_KEY; else process.env.RT_ACCEPT_ORG_KEY = SAVED_FLAG;
  mockGetContractPartyKey.mockReset();
  jest.restoreAllMocks();
});

describe('derivePartyKey', () => {
  it('matches the shared test vector', () => {
    expect(ck.derivePartyKey(VECTOR.master, VECTOR.contractId, VECTOR.version, VECTOR.party).toString('hex')).toBe(VECTOR.hex);
    expect(ck.partyKeyInfo('ctr_1', 1, 'wsA')).toBe('contract:ctr_1:1:party:wsA');
  });
  it('differs per party, per version, and from the legacy org key', () => {
    const a = ck.derivePartyKey('test-master', 'ctr_1', 1, 'wsA');
    const b = ck.derivePartyKey('test-master', 'ctr_1', 1, 'wsB');
    const a2 = ck.derivePartyKey('test-master', 'ctr_1', 2, 'wsA');
    expect(b.toString('hex')).toBe(WSB_HEX);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(a2)).toBe(false);
    const { deriveContractKey } = require('../../server/utils/contractAuth');
    return deriveContractKey('test-master', 'ctr_1', 1).then((legacy: Buffer) => expect(legacy.equals(a)).toBe(false));
  });
  it('refuses an empty master or missing ids', () => {
    expect(() => ck.derivePartyKey('', 'c', 1, 'w')).toThrow(/master/);
    expect(() => ck.derivePartyKey('m', '', 1, 'w')).toThrow();
  });
  it('names the Secret Manager secret roundtable-contract-{C}-{party}', () => {
    expect(ck.partySecretId('ctr_1', 'wsA')).toBe('roundtable-contract-ctr_1-wsA');
  });
});

describe('parties / senderPartyError', () => {
  const withParties = { contractId: 'c', parties: ['wsA', 'wsB'] };
  const legacyEntry = { contractId: 'c', counterparty: { wsId: 'wsA' } };
  it('accepts the counterparty, rejects self and strangers', () => {
    expect(ck.senderPartyError(withParties, 'wsB', 'wsA')).toBeUndefined();
    expect(ck.senderPartyError(withParties, 'wsB', 'wsB')).toMatch(/receiving workspace itself/);
    expect(ck.senderPartyError(withParties, 'wsB', 'wsZ')).toMatch(/not a party/);
    expect(ck.senderPartyError(withParties, 'wsB', undefined)).toMatch(/Missing sender/);
  });
  it('derives the pair from counterparty on an older manifest', () => {
    expect(ck.partiesOf(legacyEntry, 'wsB')).toEqual(['wsB', 'wsA']);
    expect(ck.senderPartyError(legacyEntry, 'wsB', 'wsA')).toBeUndefined();
    expect(ck.senderPartyError(legacyEntry, 'wsB', 'wsC')).toMatch(/not a party/);
  });
  it('fails closed when the entry names no parties at all', () => {
    expect(ck.senderPartyError({ contractId: 'c' }, 'wsB', 'wsA')).toMatch(/no parties/);
  });
});

describe('resolvePartyKey — dedicated (RT_CONTRACT_KEYS)', () => {
  const env = {
    ctr_1: { version: 1, party: 'wsA', key: VECTOR.hex, keys: { wsA: VECTOR.hex, wsB: WSB_HEX } },
  };
  beforeEach(() => { process.env.RT_CONTRACT_KEYS = JSON.stringify(env); });

  it('returns own and counterparty keys from the env map', async () => {
    const own = await ck.resolvePartyKey({ contractId: 'ctr_1', version: 1, partyWsId: 'wsA' });
    const other = await ck.resolvePartyKey({ contractId: 'ctr_1', version: 1, partyWsId: 'wsB' });
    expect(own.key.toString('hex')).toBe(VECTOR.hex);
    expect(own.source).toBe('env');
    expect(other.key.toString('hex')).toBe(WSB_HEX);
  });
  it('null for an unknown contract, unknown party, or a version the env does not hold', async () => {
    expect(await ck.resolvePartyKey({ contractId: 'nope', version: 1, partyWsId: 'wsA' })).toBeNull();
    expect(await ck.resolvePartyKey({ contractId: 'ctr_1', version: 1, partyWsId: 'wsZ' })).toBeNull();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await ck.resolvePartyKey({ contractId: 'ctr_1', version: 2, partyWsId: 'wsA' })).toBeNull();
  });
  it('never touches Secret Manager on a dedicated pod', async () => {
    await ck.resolvePartyKey({ contractId: 'ctr_1', version: 1, partyWsId: 'wsA' });
    expect(mockGetContractPartyKey).not.toHaveBeenCalled();
  });
  it('malformed JSON → no keys (logged), not a crash', async () => {
    process.env.RT_CONTRACT_KEYS = '{nope';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await ck.resolvePartyKey({ contractId: 'ctr_1', version: 1, partyWsId: 'wsA' })).toBeNull();
  });
});

describe('resolvePartyKey — pooled (tenant-keyed Secret Manager fetch)', () => {
  it('fetches roundtable-contract-{C}-{sender} for the tenant and ignores env', async () => {
    process.env.RT_CONTRACT_KEYS = JSON.stringify({ ctr_1: { version: 1, party: 'wsA', key: VECTOR.hex } });
    mockGetContractPartyKey.mockResolvedValue({ key: WSB_HEX, version: 1, contractId: 'ctr_1', party: 'wsB' });
    const r = await ck.resolvePartyKey({ contractId: 'ctr_1', version: 1, partyWsId: 'wsB', tenant: { workspaceId: 'wsA' } });
    expect(mockGetContractPartyKey).toHaveBeenCalledWith('wsA', 'ctr_1', 'wsB');
    expect(r.key.toString('hex')).toBe(WSB_HEX);
    expect(r.source).toBe('secret-manager');
  });
  it('no secret → null (no env fallback on a pooled service)', async () => {
    process.env.RT_CONTRACT_KEYS = JSON.stringify({ ctr_1: { version: 1, party: 'wsB', key: WSB_HEX } });
    mockGetContractPartyKey.mockResolvedValue(null);
    expect(await ck.resolvePartyKey({ contractId: 'ctr_1', version: 1, partyWsId: 'wsB', tenant: { workspaceId: 'wsA' } })).toBeNull();
  });
  it('a stored key for another version is refused', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetContractPartyKey.mockResolvedValue({ key: WSB_HEX, version: 1 });
    expect(await ck.resolvePartyKey({ contractId: 'ctr_1', version: 2, partyWsId: 'wsB', tenant: { workspaceId: 'wsA' } })).toBeNull();
  });
});

describe('ownPartyKey / flags', () => {
  it('logs (once a minute) when falling back to the org key', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await ck.ownPartyKey({ contractId: 'ctr_x', version: 1, selfWsId: 'wsA' })).toBeNull();
    expect(await ck.ownPartyKey({ contractId: 'ctr_x', version: 1, selfWsId: 'wsA' })).toBeNull();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('no party key for contract=ctr_x'));
    expect(lines).toHaveLength(1);
  });
  it('RT_ACCEPT_ORG_KEY defaults to accept and only "false" denies', () => {
    delete process.env.RT_ACCEPT_ORG_KEY;
    expect(ck.acceptOrgKey()).toBe(true);
    process.env.RT_ACCEPT_ORG_KEY = 'FALSE';
    expect(ck.acceptOrgKey()).toBe(false);
    process.env.RT_ACCEPT_ORG_KEY = '0';
    expect(ck.acceptOrgKey()).toBe(true);
  });
  it('logOrgKeyAccepted prints the documented line at most once a minute per contract', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    ck.logOrgKeyAccepted('ctr_log');
    ck.logOrgKeyAccepted('ctr_log');
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('contract=ctr_log'));
    expect(lines).toEqual(['[contractAuth] org-key token accepted (deprecated) contract=ctr_log']);
  });
});
