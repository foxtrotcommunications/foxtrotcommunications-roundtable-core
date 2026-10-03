// server/utils/contractAuth.js — HKDF-based contract key derivation and verification
//
// Legacy (pre-5.1) key: each organization has ONE master secret and the
// contract key is HKDF(masterSecret, "contract:{contractId}:{version}") —
// the same key for both parties, derivable by every pod in the org.
//
// 5.1 per-party keys (utils/contractKeys.js): key(C, party) =
// HKDF(master, "contract:{id}:{version}:party:{wsId}"), minted by the
// control plane, delivered only to the two parties. A request that names
// its sender (X-Contract-Sender) is verified with the SENDER's key; one that
// does not is a legacy org-key request, accepted while RT_ACCEPT_ORG_KEY
// !== 'false'. `resolveContractKeyForRequest` below is the one place that
// decides which.

const crypto = require('crypto');
const s2s = require('./s2sSig');
const contractKeys = require('./contractKeys');
// The ONE action vocabulary (6.5). Re-exported below so existing
// `require('../utils/contractAuth').TRANSPORT_ACTIONS` callers keep working.
const { TRANSPORT_ACTIONS, MESSAGE_ACTIONS, ACTION, WILDCARD_ACTION } = require('../vocab/actions');

const SENDER_HEADER = 'x-contract-sender';

/**
 * Derive a contract-specific key from the org master secret.
 * Uses HKDF-SHA256 with the contract ID and version as info.
 *
 * @param {string} masterSecret - Organization master secret
 * @param {string} contractId - Unique contract identifier
 * @param {number} version - Contract key version (bump to invalidate old keys)
 * @returns {Promise<Buffer>} 32-byte derived key
 */
async function deriveContractKey(masterSecret, contractId, version = 1) {
  return new Promise((resolve, reject) => {
    crypto.hkdf(
      'sha256',
      Buffer.from(masterSecret, 'utf8'),
      Buffer.alloc(0), // no salt (master secret is already high-entropy)
      `contract:${contractId}:${version}`,
      32,
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(Buffer.from(derivedKey));
      }
    );
  });
}

/**
 * Sign a contract request for A2A communication.
 *
 * @param {Buffer} contractKey - Derived contract key
 * @param {string} contractId - Contract identifier
 * @param {string} timestamp - ISO timestamp or epoch string
 * @param {string} action - Action being performed (message, delegate, etc.)
 * @param {string} [tenantWsId] - Pooled runtime only: the receiving logical
 *   workspace. When present it is appended to the signed string, binding the
 *   tenant claim into the HMAC so a captured request cannot be replayed
 *   against a different tenant within the freshness window. Omitted (all
 *   dedicated-pod traffic) the signed string is byte-identical to before.
 * @returns {string} HMAC-SHA256 hex signature
 */
function signRequest(contractKey, contractId, timestamp, action, tenantWsId) {
  const base = `${contractId}:${timestamp}:${action}`;
  return crypto
    .createHmac('sha256', contractKey)
    .update(tenantWsId ? `${base}:${tenantWsId}` : base)
    .digest('hex');
}

/**
 * Verify a contract request signature.
 *
 * @param {Buffer} contractKey - Derived contract key
 * @param {string} contractId - Contract identifier
 * @param {string} timestamp - Timestamp from request
 * @param {string} action - Action from request
 * @param {string} signature - Signature to verify
 * @param {number} maxAgeMs - Maximum signature age in milliseconds (default: 5 min)
 * @param {string} [tenantWsId] - Pooled runtime only: expected tenant claim;
 *   the signature must have been produced with the same trailing tenant.
 * @returns {{ valid: boolean, error?: string }}
 */
function verifyRequest(contractKey, contractId, timestamp, action, signature, maxAgeMs = 5 * 60 * 1000, tenantWsId) {
  // Check timestamp freshness
  const ts = typeof timestamp === 'string' && timestamp.includes('T')
    ? new Date(timestamp).getTime()
    : parseInt(timestamp, 10);

  if (isNaN(ts)) {
    return { valid: false, error: 'Invalid timestamp' };
  }

  if (Math.abs(Date.now() - ts) > maxAgeMs) {
    return { valid: false, error: 'Contract signature expired' };
  }

  // Verify HMAC
  const expected = signRequest(contractKey, contractId, timestamp, action, tenantWsId);

  try {
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) {
      return { valid: false, error: 'Invalid signature' };
    }
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, error: 'Invalid signature' };
    }
  } catch {
    return { valid: false, error: 'Invalid signature format' };
  }

  return { valid: true };
}

/**
 * Parse a contract's expiresAt into epoch ms. Accepts ISO strings, epoch
 * numbers (ms, or seconds when < 1e12), and Firestore-style
 * { seconds | _seconds } objects. Returns null when absent, NaN when present
 * but unparseable — the caller treats NaN as expired (fail closed: a
 * contract whose expiry we cannot read is not one we can honor).
 */
function parseExpiresAt(expiresAt) {
  if (expiresAt === undefined || expiresAt === null || expiresAt === '') return null;
  if (typeof expiresAt === 'number') {
    return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  }
  if (typeof expiresAt === 'string') {
    if (/^\d+$/.test(expiresAt)) return parseExpiresAt(parseInt(expiresAt, 10));
    return new Date(expiresAt).getTime();
  }
  if (typeof expiresAt === 'object') {
    if (typeof expiresAt.toMillis === 'function') return expiresAt.toMillis();
    const secs = expiresAt.seconds ?? expiresAt._seconds;
    if (typeof secs === 'number') return secs * 1000;
    if (expiresAt instanceof Date) return expiresAt.getTime();
  }
  return NaN;
}

/**
 * Status + expiry gate shared by every contract lookup (upgrade plan 1.2).
 * Returns an error string, or undefined when the contract is live.
 */
function contractLivenessError(contract, now = Date.now()) {
  if (!contract) return 'No contract';
  if (contract.status !== 'active') {
    return `Contract ${contract.contractId} is not active (status: ${contract.status})`;
  }
  const exp = parseExpiresAt(contract.expiresAt);
  if (exp === null) return undefined;
  if (Number.isNaN(exp)) {
    return `Contract ${contract.contractId} has an unreadable expiresAt (${JSON.stringify(contract.expiresAt)}) — refusing`;
  }
  if (exp <= now) {
    return `Contract ${contract.contractId} expired at ${new Date(exp).toISOString()}`;
  }
  return undefined;
}

// ─── v2 contract-keyed signatures (SIGNING_SPEC.md) ────────────────────────
//
//   v2:{contractId}:{timestamp}:{action}:{nonce}:{bodyHash}[:{tenantWsId}]
//
// Carried in the SAME X-Contract-Signature / X-Contract-Timestamp headers as
// v1, plus X-Rt-Nonce and X-Rt-Sig-V: 2. v1 signed neither the body nor a
// nonce, so a captured intent/execute or message/send could be replayed with
// a different payload for 5 minutes; v2 closes both.

/**
 * Sign a contract request, v2. Returns the signature and the headers to send
 * (alongside X-Contract-Id / X-Contract-Action, which the caller owns).
 *
 * @param {Buffer} contractKey
 * @param {object} p
 * @param {string} p.contractId
 * @param {string} p.action
 * @param {string|Buffer} p.body     exact request body as it will be sent
 * @param {string} [p.tenantWsId]    pooled target tenant (X-Rt-Tenant)
 * @param {string} [p.timestamp]     defaults to Date.now()
 * @param {string} [p.nonce]         defaults to a fresh 32-hex nonce
 */
function signRequestV2(contractKey, { contractId, action, body, tenantWsId, timestamp = Date.now().toString(), nonce = s2s.newNonce() }) {
  const bodyHash = s2s.bodyHashOf(body);
  const signature = s2s.hmacHex(contractKey, s2s.v2ContractSignedString({
    contractId, timestamp, action, nonce, bodyHash, tenantWsId,
  }));
  return {
    signature,
    timestamp,
    nonce,
    bodyHash,
    headers: {
      'X-Contract-Signature': signature,
      'X-Contract-Timestamp': timestamp,
      'X-Rt-Nonce': nonce,
      'X-Rt-Sig-V': '2',
    },
  };
}

/**
 * Verify a contract request of EITHER version from its headers.
 *
 *   X-Rt-Sig-V absent → v1 (`verifyRequest`), accepted while
 *     RT_HMAC_ACCEPT_V1 !== 'false'; logged as deprecated.
 *   X-Rt-Sig-V: 2     → nonce required (single use, 10 min), timestamp
 *     ±5 min, body hash of req.rawBody, timingSafeEqual.
 *   anything else     → invalid.
 *
 * @param {Buffer} contractKey
 * @param {object} p
 * @param {object} p.headers       lower-cased header map
 * @param {Buffer|string} [p.rawBody]
 * @param {string} p.contractId
 * @param {string} p.action
 * @param {string} [p.tenantWsId]
 * @param {number} [p.maxAgeMs]
 * @returns {Promise<{ valid: boolean, error?: string, version?: 1|2 }>}
 */
async function verifyContractRequest(contractKey, { headers, rawBody, contractId, action, tenantWsId, maxAgeMs = 5 * 60 * 1000 }) {
  const signature = headers['x-contract-signature'];
  const timestamp = headers['x-contract-timestamp'];
  const sigV = headers['x-rt-sig-v'];
  if (typeof signature !== 'string' || typeof timestamp !== 'string') {
    return { valid: false, error: 'Missing contract signature' };
  }

  if (sigV === undefined) {
    if (!s2s.acceptV1()) {
      return { valid: false, error: 'HMAC v1 no longer accepted', version: 1 };
    }
    const r = verifyRequest(contractKey, contractId, timestamp, action, signature, maxAgeMs, tenantWsId);
    if (r.valid) s2s.logV1Accepted(`contract:${action}`);
    return { ...r, version: 1 };
  }
  if (sigV !== '2') {
    return { valid: false, error: `Unsupported X-Rt-Sig-V '${String(sigV)}'` };
  }

  const nonce = headers['x-rt-nonce'];
  if (!s2s.isNonce(nonce)) {
    return { valid: false, error: 'Missing or malformed X-Rt-Nonce', version: 2 };
  }
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    return { valid: false, error: 'Invalid timestamp', version: 2 };
  }
  if (Math.abs(Date.now() - ts) > maxAgeMs) {
    return { valid: false, error: 'Contract signature expired', version: 2 };
  }
  const expected = s2s.hmacHex(contractKey, s2s.v2ContractSignedString({
    contractId, timestamp, action, nonce, bodyHash: s2s.bodyHashOf(rawBody ?? Buffer.alloc(0)), tenantWsId,
  }));
  if (!s2s.safeEqualHex(signature, expected)) {
    return { valid: false, error: 'Invalid signature', version: 2 };
  }
  // Nonce consumed only after the signature checks out.
  if (!(await s2s.consumeNonce(nonce))) {
    return { valid: false, error: 'Replay detected: nonce already used', version: 2 };
  }
  return { valid: true, version: 2 };
}

/**
 * Decide which key verifies a contract-signed REQUEST (upgrade plan 5.1).
 *
 *   X-Contract-Sender present → the sender must be a party to the contract
 *     and the counterparty of `selfWsId` (the workspace being addressed:
 *     the claimed tenant on a pooled service, this pod on a dedicated one);
 *     the key is key(C, sender) via contractKeys.resolvePartyKey (pooled:
 *     Secret Manager through the tenant cache; dedicated: RT_CONTRACT_KEYS).
 *     No key → 401. Not a party → 403.
 *   absent → legacy org key, only while RT_ACCEPT_ORG_KEY !== 'false';
 *     `getMasterSecret()` is called lazily so a per-party request never
 *     needs the master at all.
 *
 * Returns { key, kind: 'party'|'org', sender? } or { error, status }.
 */
async function resolveContractKeyForRequest({ headers, contract, selfWsId, tenant, getMasterSecret }) {
  const rawSender = headers[SENDER_HEADER];
  const sender = typeof rawSender === 'string' && rawSender.trim() ? rawSender.trim() : undefined;
  const version = contract.version || 1;
  if (sender) {
    const partyErr = contractKeys.senderPartyError(contract, selfWsId, sender);
    if (partyErr) return { error: partyErr, status: 403 };
    let resolved;
    try {
      resolved = await contractKeys.resolvePartyKey({ contractId: contract.contractId, version, partyWsId: sender, tenant });
    } catch (e) {
      return { error: `Party key lookup failed: ${e.message}`, status: 503 };
    }
    if (!resolved) {
      return { error: `No party key for sender ${sender} under contract ${contract.contractId}`, status: 401 };
    }
    return { key: resolved.key, kind: 'party', sender };
  }
  if (!contractKeys.acceptOrgKey()) {
    return { error: 'Request names no X-Contract-Sender; org-key signatures are no longer accepted (RT_ACCEPT_ORG_KEY=false)', status: 401 };
  }
  const master = await getMasterSecret();
  if (!master) {
    return { error: 'Contract auth not available (no org master secret configured)', status: 403 };
  }
  const key = await deriveContractKey(master, contract.contractId, version);
  return { key, kind: 'org' };
}

/**
 * Find the matching contract for an inbound request.
 *
 * @param {Array} contracts - Contract manifest (from RT_CONTRACTS)
 * @param {string} contractId - Contract ID from request headers
 * @param {string} action - Action being attempted
 * @returns {{ contract?: object, error?: string }}
 */
function findAndValidateContract(contracts, contractId, action) {
  if (!contracts || !Array.isArray(contracts)) {
    return { error: 'No contracts configured' };
  }

  const contract = contracts.find(c => c.contractId === contractId);
  if (!contract) {
    return { error: `Unknown contract: ${contractId}` };
  }

  // status === 'active' AND not past expiresAt — a revoked or lapsed
  // contract in the manifest is not an authorization.
  const liveness = contractLivenessError(contract);
  if (liveness) {
    return { error: liveness };
  }

  // Check allowedActions — only transport/protocol actions are auto-allowed.
  // Everything else — intent ops AND message/send (`message`, `delegate`,
  // `message_send`; upgrade plan 1.5) — must be explicitly listed. A free-form
  // turn on another agent is at least as powerful as any single capability,
  // so it is no longer a transport freebie.
  if (!TRANSPORT_ACTIONS.includes(action)) {
    if (!isActionAllowed(contract.allowedActions, action)) {
      return { error: `Action "${action}" not permitted by contract ${contractId}. Allowed: ${contract.allowedActions.join(', ')}` };
    }
  }

  return { contract };
}

// TRANSPORT_ACTIONS (`tasks_get`, `tasks_cancel`, `intent_execute`,
// `discover`) — auto-allowed for every active contract — and MESSAGE_ACTIONS
// (`message`, `delegate`, `message_send`, which an LLM turn requires an
// explicit grant for since 1.5) are defined ONCE in server/vocab/actions.ts
// and imported at the top of this file. `tasks_get`/`tasks_cancel` are
// transport: they operate on a task the caller already created through a
// granted action, so a contract need not list them to poll its own task.

/**
 * allowedActions membership with the one alias we keep: `message_send` (the
 * header-less default a legacy sender implies) is satisfied by `message`,
 * the vocabulary contracts actually carry. `*` grants everything.
 */
function isActionAllowed(allowedActions, action) {
  const list = Array.isArray(allowedActions) ? allowedActions : [];
  if (list.includes(WILDCARD_ACTION) || list.includes(action)) return true;
  if (action === ACTION.message_send && list.includes(ACTION.message)) return true;
  return false;
}

// ─── End-to-End Encryption ─────────────────────────────────
// AES-256-GCM using the HKDF-derived contract key.
// Same key derivation as signing — no additional secrets needed.
//
// Properties:
//   Authentication  — HMAC on headers (who sent it)
//   Confidentiality — AES-GCM on payload (encrypted content)
//   Integrity       — GCM auth tag (tamper-proof)
//
// Only the two workspaces holding an active contract can decrypt.
// The wake proxy, ingress controller, log pipeline — none can read the payload.

/**
 * Encrypt a message payload using AES-256-GCM with the contract key.
 *
 * @param {Buffer} contractKey - 32-byte HKDF-derived contract key
 * @param {object|string} payload - The data to encrypt (will be JSON.stringified if object)
 * @returns {{ iv: string, ciphertext: string, authTag: string }} Base64-encoded components
 */
function encryptPayload(contractKey, payload) {
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);

  // 12-byte random IV (NIST recommended for GCM)
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', contractKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypt a message payload using AES-256-GCM with the contract key.
 *
 * @param {Buffer} contractKey - 32-byte HKDF-derived contract key
 * @param {string} iv - Base64-encoded initialization vector
 * @param {string} ciphertext - Base64-encoded ciphertext
 * @param {string} authTag - Base64-encoded GCM authentication tag
 * @returns {{ data: object|string, error?: string }}
 */
function decryptPayload(contractKey, iv, ciphertext, authTag) {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      contractKey,
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);

    const text = decrypted.toString('utf8');

    // Try to parse as JSON, fall back to raw string
    try {
      return { data: JSON.parse(text) };
    } catch {
      return { data: text };
    }
  } catch (err) {
    return { data: null, error: `Decryption failed: ${err.message}` };
  }
}

module.exports = {
  SENDER_HEADER,
  deriveContractKey,
  parseExpiresAt,
  contractLivenessError,
  signRequest,
  verifyRequest,
  signRequestV2,
  verifyContractRequest,
  resolveContractKeyForRequest,
  findAndValidateContract,
  isActionAllowed,
  TRANSPORT_ACTIONS,
  MESSAGE_ACTIONS,
  encryptPayload,
  decryptPayload,
};
