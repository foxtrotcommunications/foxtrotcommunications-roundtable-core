// server/utils/contractKeys.js — per-party contract keys (upgrade plan 5.1).
//
// Until 5.1 every contract had ONE key, derived by both parties from the
// org-wide master secret (contractAuth.deriveContractKey). Anyone holding
// ORG_MASTER_SECRET — every pod in the org — could sign as any party of any
// contract. Per-party keys split that:
//
//   key(C, party) = HKDF-SHA256(master, salt = '', info =
//                   "contract:{contractId}:{version}:party:{partyWsId}", 32 bytes)
//
// The control plane derives both keys at approval and publishes each to
// Secret Manager as `roundtable-contract-{contractId}-{partyWsId}` (payload
// `{ key: <hex>, version, contractId, party }`), deletes them on revocation,
// and re-mints on amendment approval (new version). Pods never hold the
// master to USE a contract: a dedicated pod gets its contracts' keys as
// RT_CONTRACT_KEYS (JSON, in the per-workspace k8s Secret); a pooled service
// fetches `roundtable-contract-{C}-{party}` per request through
// tenantCredentials (5-min tenant-keyed cache, audit log, no env fallback).
//
// Sender signs with key(C, sender) and names itself (`sender` in intent
// tokens, X-Contract-Sender on contract-signed requests). The receiver
// resolves key(C, sender), checks sender ∈ parties(C) and that the sender is
// the counterparty of the workspace being addressed, then verifies. HMAC is
// symmetric, so the receiver holds the sender's key too; what per-party keys
// buy today is (a) the master secret leaves the pods, (b) each key is a
// minted, revocable secret delivered only to the two parties, (c) the wire
// says who signed. Non-repudiation arrives with the Ed25519 proofs (5.2).
//
// This is the ONLY place the derivation lives in core; the control plane's
// api/services/contractKeys.ts is its mirror and tests/pooled/contractKeys
// .test.ts pins a shared test vector against it.

const crypto = require('crypto');

const SECRET_PREFIX = 'roundtable-contract';

/** HKDF info string — identical in the control plane. */
function partyKeyInfo(contractId, version, partyWsId) {
  return `contract:${contractId}:${version}:party:${partyWsId}`;
}

/**
 * key(C, party) as a 32-byte Buffer. Synchronous: hkdfSync is cheap and the
 * callers that need it (manifest-driven env parsing, tests) are synchronous.
 */
function derivePartyKey(masterSecret, contractId, version, partyWsId) {
  if (!masterSecret) throw new Error('derivePartyKey: empty master secret');
  if (!contractId || !partyWsId) throw new Error('derivePartyKey: contractId and partyWsId are required');
  const okm = crypto.hkdfSync(
    'sha256',
    Buffer.from(masterSecret, 'utf8'),
    Buffer.alloc(0),
    partyKeyInfo(contractId, Number(version) || 1, partyWsId),
    32,
  );
  return Buffer.from(okm);
}

/** Secret Manager secret id for one party's key. */
function partySecretId(contractId, partyWsId) {
  return `${SECRET_PREFIX}-${contractId}-${partyWsId}`;
}

// ─── Flags ──────────────────────────────────────────────────────────────────

/**
 * RT_ACCEPT_ORG_KEY — while not 'false' (default accept), a token or request
 * WITHOUT a sender verifies with the legacy org-derived key (and is logged
 * as deprecated once a minute per contract). Flip to 'false' once every
 * signer emits per-party identities: legacy then fails with 401, and
 * ORG_MASTER_SECRET can be removed from workspace pods (README).
 */
function acceptOrgKey() {
  return String(process.env.RT_ACCEPT_ORG_KEY ?? 'true').toLowerCase() !== 'false';
}

const orgKeyLogAt = new Map();
function logOrgKeyAccepted(contractId, what = 'token') {
  const now = Date.now();
  const last = orgKeyLogAt.get(contractId) || 0;
  if (now - last >= 60_000) {
    orgKeyLogAt.set(contractId, now);
    console.warn(`[contractAuth] org-key ${what} accepted (deprecated) contract=${contractId}`);
  }
}

const noKeyLogAt = new Map();
function logNoPartyKey(contractId, selfWsId) {
  const now = Date.now();
  const k = `${contractId}:${selfWsId}`;
  const last = noKeyLogAt.get(k) || 0;
  if (now - last >= 60_000) {
    noKeyLogAt.set(k, now);
    console.warn(`[contractKeys] no party key for contract=${contractId} party=${selfWsId} — signing with the org key (deprecated)`);
  }
}

// ─── Parties ────────────────────────────────────────────────────────────────

/**
 * The two parties of a manifest contract entry. Prefers the explicit
 * `parties` the 5.1 control plane emits; an older manifest gives us only
 * `counterparty.wsId`, which together with the workspace the manifest
 * belongs to (`selfWsId`) is the same pair.
 */
function partiesOf(contract, selfWsId) {
  if (Array.isArray(contract?.parties) && contract.parties.length === 2) {
    return contract.parties.map(String);
  }
  const cp = contract?.counterparty?.wsId;
  if (cp && selfWsId) return [String(selfWsId), String(cp)];
  return null;
}

/**
 * Is `sender` allowed to sign under this contract toward `selfWsId`?
 * sender ∈ parties(C) AND sender ≠ self (the other party — a workspace does
 * not consult itself). Returns an error string or undefined.
 */
function senderPartyError(contract, selfWsId, sender) {
  if (!sender) return 'Missing sender';
  const parties = partiesOf(contract, selfWsId);
  if (!parties) return `Contract ${contract?.contractId} lists no parties — cannot place sender ${sender}`;
  if (!parties.includes(String(sender))) return `Sender ${sender} is not a party to contract ${contract.contractId}`;
  if (selfWsId && String(sender) === String(selfWsId)) return `Sender ${sender} is the receiving workspace itself`;
  return undefined;
}

// ─── Resolution ─────────────────────────────────────────────────────────────

let envKeysCache = { raw: undefined, map: null };
/**
 * RT_CONTRACT_KEYS (dedicated pods): JSON map
 *   contractId → { version, key: <own key hex>, party: <own wsId>,
 *                  keys: { [partyWsId]: <hex> }, signing?: … }
 * `key`/`party` is this workspace's own key; `keys` carries both parties'
 * so inbound signatures verify without the master. Parsed once per value.
 */
function envContractKeys() {
  const raw = process.env.RT_CONTRACT_KEYS;
  if (raw === envKeysCache.raw) return envKeysCache.map;
  let map = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      map = parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      console.error(`[contractKeys] RT_CONTRACT_KEYS is not valid JSON: ${e.message}`);
    }
  }
  envKeysCache = { raw, map };
  return map;
}

function hexToKey(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

/** Lazy: tenantCredentials is TS and pulls the Secret Manager client. */
function getTenantCredentials() {
  return require('../tenantCredentials');
}

/**
 * Resolve key(C, party) for verification or signing.
 *
 * @param {object} p
 * @param {string} p.contractId
 * @param {number} p.version       the manifest's contract version; a stored
 *                                 key for another version is NOT returned
 * @param {string} p.partyWsId     whose key
 * @param {{ workspaceId: string }} [p.tenant]  pooled: the tenant on whose
 *                                 behalf we fetch (cache + audit key)
 * @returns {Promise<{ key: Buffer, version: number, signingKey?: string, source: 'env'|'secret-manager' } | null>}
 *   null when no per-party key exists (caller decides: legacy or deny).
 */
async function resolvePartyKey({ contractId, version, partyWsId, tenant }) {
  const want = Number(version) || 1;
  if (!contractId || !partyWsId) return null;

  if (tenant && tenant.workspaceId) {
    // Pooled: Secret Manager through the tenant-keyed cache. No env fallback —
    // env belongs to dedicated pods and a pooled process serves many orgs.
    const payload = await getTenantCredentials().getContractPartyKey(tenant.workspaceId, contractId, partyWsId);
    if (!payload) return null;
    const key = hexToKey(payload.key);
    if (!key) return null;
    if (Number(payload.version) !== want) {
      console.warn(`[contractKeys] stored key for contract=${contractId} party=${partyWsId} is version ${payload.version}, manifest says ${want} — refusing`);
      return null;
    }
    return { key, version: want, signingKey: payload.signingKey, source: 'secret-manager' };
  }

  const map = envContractKeys();
  const entry = map && map[contractId];
  if (!entry) return null;
  if (Number(entry.version) !== want) {
    console.warn(`[contractKeys] RT_CONTRACT_KEYS has contract=${contractId} at version ${entry.version}, manifest says ${want} — refusing`);
    return null;
  }
  let hex = entry.keys && entry.keys[partyWsId];
  if (!hex && entry.party === partyWsId) hex = entry.key;
  const key = hexToKey(hex);
  if (!key) return null;
  return {
    key,
    version: want,
    signingKey: entry.party === partyWsId ? entry.signingKey : undefined,
    source: 'env',
  };
}

/**
 * This workspace's own key for signing under contract C — or null (legacy
 * org-key signing, logged). `selfWsId` is the sending workspace: the tenant
 * on pooled Arthur, config.workspaceId on a dedicated pod.
 */
async function ownPartyKey({ contractId, version, selfWsId, tenant }) {
  if (!selfWsId) return null;
  const r = await resolvePartyKey({ contractId, version, partyWsId: selfWsId, tenant });
  if (!r) logNoPartyKey(contractId, selfWsId);
  return r;
}

module.exports = {
  SECRET_PREFIX,
  partyKeyInfo,
  derivePartyKey,
  partySecretId,
  acceptOrgKey,
  logOrgKeyAccepted,
  partiesOf,
  senderPartyError,
  envContractKeys,
  resolvePartyKey,
  ownPartyKey,
};
