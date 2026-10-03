// server/utils/s2sSig.js — S2S signature v2 primitives (SIGNING_SPEC.md).
//
// Shared by every verifier and signer in core. The reference functions are
// copied VERBATIM from the spec so the three repos (core, control plane,
// Pendragon) compute byte-identical signed strings; the test vectors in
// tests/pooled/s2sSigV2.test.ts pin them.
//
// v2 binds four things v1 did not: a single-use nonce (replay), the body
// hash (payload integrity — v1 signed only path+timestamp, so a captured
// signature could be reused with a different body inside the 5-minute
// window), the explicit version, and — unchanged from v1 — the tenant when
// the request is tenant-bound.

const crypto = require('crypto');

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function bodyHashOf(body) {
  if (body == null || body === '') return EMPTY_SHA256;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function newNonce() { return crypto.randomBytes(16).toString('hex'); }
function isNonce(n) { return typeof n === 'string' && /^[0-9a-f]{32}$/.test(n); }

function v2SignedString({ routePath, timestamp, nonce, bodyHash, tenantWsId }) {
  const base = `v2:${routePath}:${timestamp}:${nonce}:${bodyHash}`;
  return tenantWsId ? `${base}:${tenantWsId}` : base;
}
function v2ContractSignedString({ contractId, timestamp, action, nonce, bodyHash, tenantWsId }) {
  const base = `v2:${contractId}:${timestamp}:${action}:${nonce}:${bodyHash}`;
  return tenantWsId ? `${base}:${tenantWsId}` : base;
}
function hmacHex(secretOrKey, s) {
  return crypto.createHmac('sha256', secretOrKey).update(s).digest('hex');
}
function safeEqualHex(a, b) {
  try { return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); } catch { return false; }
}

// ─── Headers / flags ────────────────────────────────────────────────────────

const SIG_HEADER = 'x-control-plane-signature';
const TS_HEADER = 'x-control-plane-timestamp';
const NONCE_HEADER = 'x-rt-nonce';
const SIGV_HEADER = 'x-rt-sig-v';
const TENANT_WS_HEADER = 'x-rt-workspace';

const MAX_SKEW_MS = 5 * 60 * 1000;   // ±5 min
const NONCE_TTL_MS = 10 * 60 * 1000; // nonce remembered for 10 min
const NONCE_NAMESPACE = 's2s';

/**
 * RT_HMAC_ACCEPT_V1 — verifiers accept the legacy `{routePath}:{timestamp}`
 * shape while this is not 'false' (rollout step 1/2). Flip to 'false' once
 * every signer emits v2 (step 3). Read per call: flag flip, no restart.
 */
function acceptV1() {
  return String(process.env.RT_HMAC_ACCEPT_V1 ?? 'true').toLowerCase() !== 'false';
}

/**
 * RT_HMAC_EMIT_V2 — core's OUTBOUND signers emit v2 while this is not
 * 'false' (default on). The documented off-switch for a fleet whose
 * receivers have not all shipped the dual-accept verifier yet: contract-keyed
 * signatures carry ONE header, so a v2 signature at a v1-only receiver is a
 * hard 401. Path-based signers to the control plane always keep their legacy
 * headers/fields alongside the v2 headers, so this only strips the v2 ones.
 */
function emitV2() {
  return String(process.env.RT_HMAC_EMIT_V2 ?? 'true').toLowerCase() !== 'false';
}

// "[hmac] v1 signature accepted (deprecated)" at most once per minute per route.
const v1LogAt = new Map();
function logV1Accepted(routePath) {
  const now = Date.now();
  const last = v1LogAt.get(routePath) || 0;
  if (now - last >= 60_000) {
    v1LogAt.set(routePath, now);
    console.warn(`[hmac] v1 signature accepted (deprecated) route=${routePath}`);
  }
}

function timestampFresh(timestamp, now = Date.now()) {
  const ts = parseInt(timestamp, 10);
  return Number.isFinite(ts) && Math.abs(now - ts) <= MAX_SKEW_MS;
}

/** Lazy: nonceStore is TS and pulls pg; only v2 verification needs it. */
function getNonceStore() {
  return require('../protocols/nonceStore').nonceStore;
}

/**
 * Consume a v2 nonce. Returns false on replay. Namespaced `s2s:` in the
 * shared nonce store (server/protocols/nonceStore.ts), 10-minute TTL.
 */
async function consumeNonce(nonce) {
  return getNonceStore().addScoped(NONCE_NAMESPACE, nonce, NONCE_TTL_MS);
}

/**
 * Verify the v2 headers of a path-based S2S request.
 *
 * @param {object} p
 * @param {object} p.headers   lower-cased header map (express req.headers)
 * @param {Buffer|string|undefined} p.rawBody  raw bytes as received (express.json verify)
 * @param {string} p.routePath
 * @param {string|undefined} p.tenantWsId  the tenant bound into the string (header already trimmed)
 * @param {string|Buffer} p.secret
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
async function verifyPathV2({ headers, rawBody, routePath, tenantWsId, secret }) {
  const signature = headers[SIG_HEADER];
  const timestamp = headers[TS_HEADER];
  const nonce = headers[NONCE_HEADER];
  if (typeof signature !== 'string' || typeof timestamp !== 'string') {
    return { ok: false, status: 401, error: 'Missing HMAC signature' };
  }
  if (!isNonce(nonce)) {
    return { ok: false, status: 401, error: 'Missing or malformed X-Rt-Nonce' };
  }
  if (!timestampFresh(timestamp)) {
    return { ok: false, status: 401, error: 'HMAC timestamp expired' };
  }
  const expected = hmacHex(secret, v2SignedString({
    routePath, timestamp, nonce, bodyHash: bodyHashOf(rawBody ?? Buffer.alloc(0)), tenantWsId,
  }));
  if (!safeEqualHex(signature, expected)) {
    return { ok: false, status: 401, error: 'Invalid HMAC signature' };
  }
  // Nonce last: a forged request never consumes a nonce a legitimate one
  // might still present.
  if (!(await consumeNonce(nonce))) {
    return { ok: false, status: 401, error: 'Replay detected: nonce already used' };
  }
  return { ok: true };
}

/**
 * Build the v2 headers for an OUTBOUND path-based request. The caller sends
 * exactly `body` (the string/Buffer hashed here) and, when tenant-bound,
 * also sets X-Rt-Workspace to the same tenantWsId (included here).
 */
function signPathV2({ secret, routePath, body, tenantWsId, timestamp = Date.now().toString(), nonce = newNonce() }) {
  const bodyHash = bodyHashOf(body);
  const signature = hmacHex(secret, v2SignedString({ routePath, timestamp, nonce, bodyHash, tenantWsId }));
  const headers = {
    [SIG_HEADER]: signature,
    [TS_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
    [SIGV_HEADER]: '2',
  };
  if (tenantWsId) headers[TENANT_WS_HEADER] = tenantWsId;
  return { headers, signature, timestamp, nonce, bodyHash };
}

module.exports = {
  EMPTY_SHA256,
  bodyHashOf,
  newNonce,
  isNonce,
  v2SignedString,
  v2ContractSignedString,
  hmacHex,
  safeEqualHex,
  SIG_HEADER,
  TS_HEADER,
  NONCE_HEADER,
  SIGV_HEADER,
  TENANT_WS_HEADER,
  MAX_SKEW_MS,
  NONCE_TTL_MS,
  NONCE_NAMESPACE,
  acceptV1,
  emitV2,
  logV1Accepted,
  timestampFresh,
  consumeNonce,
  verifyPathV2,
  signPathV2,
};
