// server/utils/contractAuth.js — HKDF-based contract key derivation and verification
//
// Each organization has ONE master secret. Contract keys are derived mathematically
// using HKDF-SHA256: contractKey = HKDF(masterSecret, "contract:{contractId}:{version}")
//
// No per-contract secrets. No Secret Manager calls. Just math.

const crypto = require('crypto');

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

  if (contract.status !== 'active') {
    return { error: `Contract ${contractId} is not active (status: ${contract.status})` };
  }

  // Check allowedActions — only transport/protocol actions are auto-allowed.
  // All other actions (including intent ops) must be explicitly listed in the contract.
  const transportActions = ['message', 'delegate', 'message_send', 'tasks_get', 'tasks_cancel', 'intent_execute', 'discover'];
  if (!transportActions.includes(action)) {
    if (!contract.allowedActions.includes('*') && !contract.allowedActions.includes(action)) {
      return { error: `Action "${action}" not permitted by contract ${contractId}. Allowed: ${contract.allowedActions.join(', ')}` };
    }
  }

  return { contract };
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
  deriveContractKey,
  signRequest,
  verifyRequest,
  findAndValidateContract,
  encryptPayload,
  decryptPayload,
};
