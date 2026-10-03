// server/middleware/requireHmac.js — control-plane/S2S HMAC guard, shared.
//
// Two signature versions (SIGNING_SPEC.md), selected by the X-Rt-Sig-V header:
//
//   v1 (header absent) — legacy, accepted while RT_HMAC_ACCEPT_V1 !== 'false':
//     signature = HMAC(secret, "<path>:<timestamp>")            (no tenant)
//     signature = HMAC(secret, "<path>:<timestamp>:<wsId>")     (X-Rt-Workspace)
//     Signs no body and carries no nonce — a captured signature can be
//     replayed with any body for 5 minutes. Logged as deprecated once a
//     minute per route; 401 `HMAC v1 no longer accepted` once the flag flips.
//
//   v2 (X-Rt-Sig-V: 2):
//     signature = HMAC(secret, "v2:<path>:<timestamp>:<nonce>:<sha256(rawBody)>[:<wsId>]")
//     X-Rt-Nonce (32 hex, single use, 10 min) is required; the raw body is
//     the bytes express.json captured as req.rawBody. Verified by
//     utils/s2sSig.verifyPathV2.
//
//   Any other X-Rt-Sig-V → 401.
//
// On success with a tenant header: req.rtTenant = { workspaceId }.
// `tenantRequired: true` (every pooled mount) rejects headerless requests —
// a pooled S2S route without a tenant has nowhere to write.
//
// server/index.js (dedicated pods) mounts this same middleware; the old
// inline copy there is gone, so dedicated and pooled verify identically.

const crypto = require('crypto');
const config = require('../config');
const s2s = require('../utils/s2sSig');

const TENANT_WS_HEADER = s2s.TENANT_WS_HEADER;

/**
 * Verify a path-based S2S request (either version) without sending a
 * response — for handlers that embed the check (tools/execute, bridge
 * receive). Resolves { ok, status, error, version, tenantWsId }.
 */
async function verifyS2sRequest(req, routePath, { tenantRequired = false, secret = config.bridgeHmacSecret } = {}) {
  const headers = req.headers || {};
  const sigV = headers[s2s.SIGV_HEADER];
  const rawTenant = headers[TENANT_WS_HEADER];
  const tenantWsId = typeof rawTenant === 'string' && rawTenant.trim() ? rawTenant.trim() : undefined;

  if (tenantRequired && !tenantWsId) {
    return { ok: false, status: 401, error: 'Missing X-Rt-Workspace header' };
  }

  if (sigV === undefined) {
    const r = verifyV1Sync(headers, routePath, tenantWsId, secret);
    return { ...r, version: 1, tenantWsId };
  }
  if (sigV === '2') {
    const r = await s2s.verifyPathV2({ headers, rawBody: req.rawBody, routePath, tenantWsId, secret });
    return { ...r, version: 2, tenantWsId };
  }
  return { ok: false, status: 401, error: `Unsupported X-Rt-Sig-V '${String(sigV)}'` };
}

function verifyV1Sync(headers, routePath, tenantWsId, secret) {
  const signature = headers[s2s.SIG_HEADER];
  const timestamp = headers[s2s.TS_HEADER];
  if (!signature || !timestamp) {
    return { ok: false, status: 401, error: 'Missing HMAC signature' };
  }
  if (!s2s.acceptV1()) {
    return { ok: false, status: 401, error: 'HMAC v1 no longer accepted' };
  }
  // Reject stale requests (5 min window)
  if (!s2s.timestampFresh(timestamp)) {
    return { ok: false, status: 401, error: 'HMAC timestamp expired' };
  }
  const signedString = tenantWsId
    ? `${routePath}:${timestamp}:${tenantWsId}`
    : `${routePath}:${timestamp}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(signedString).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return { ok: false, status: 401, error: 'Invalid HMAC signature' };
    }
  } catch {
    return { ok: false, status: 401, error: 'Invalid HMAC signature' };
  }
  s2s.logV1Accepted(routePath);
  return { ok: true };
}

function requireHmac(routePath, { tenantRequired = false } = {}) {
  return (req, res, next) => {
    const headers = req.headers || {};
    const sigV = headers[s2s.SIGV_HEADER];
    const rawTenant = headers[TENANT_WS_HEADER];
    const tenantWsId = typeof rawTenant === 'string' && rawTenant.trim() ? rawTenant.trim() : undefined;

    const finish = (r) => {
      if (!r.ok) return res.status(r.status || 401).json({ error: r.error });
      if (tenantWsId) req.rtTenant = { workspaceId: tenantWsId };
      next();
    };

    if (!headers[s2s.SIG_HEADER] || !headers[s2s.TS_HEADER]) {
      return res.status(401).json({ error: 'Missing HMAC signature' });
    }
    if (tenantRequired && !tenantWsId) {
      return res.status(401).json({ error: 'Missing X-Rt-Workspace header' });
    }

    // v1 stays synchronous (no nonce store round-trip) so legacy callers and
    // their tests see no change in timing; v2 awaits the nonce store.
    if (sigV === undefined) {
      return finish(verifyV1Sync(headers, routePath, tenantWsId, config.bridgeHmacSecret));
    }
    if (sigV !== '2') {
      return res.status(401).json({ error: `Unsupported X-Rt-Sig-V '${String(sigV)}'` });
    }
    s2s.verifyPathV2({ headers, rawBody: req.rawBody, routePath, tenantWsId, secret: config.bridgeHmacSecret })
      .then(finish)
      .catch((err) => res.status(500).json({ error: `HMAC verification error: ${err.message}` }));
  };
}

module.exports = { requireHmac, verifyS2sRequest, TENANT_WS_HEADER };
