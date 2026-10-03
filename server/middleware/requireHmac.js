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
// Which secret (upgrade plan 5.0): a tenant-bound request addressed to THIS
// workspace (X-Rt-Workspace === config.workspaceId) may be signed with the
// per-workspace key the control plane delivers as RT_WS_BRIDGE_KEY
// (HKDF(orgMaster, "bridge:{wsId}"), 3.2) OR with the fleet-wide
// BRIDGE_HMAC_SECRET. The per-workspace key is tried first; the fleet secret
// stays accepted so Pendragon and peer pods keep working until every signer
// has moved, after which BRIDGE_HMAC_SECRET can stop being injected. A
// request bound to a DIFFERENT tenant, or not tenant-bound at all, is only
// ever checked against the fleet secret — the per-workspace key says "I am
// talking to workspace W", nothing else. Trying a key that does not match
// never consumes the v2 nonce (verifyPathV2 checks the signature first), so
// the second attempt is not rejected as a replay.
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
 * The secrets a request may legitimately be signed with, most specific
 * first. `override` (tests, embedded verifiers) replaces the whole list.
 */
function candidateSecrets(tenantWsId, override) {
  if (override !== undefined) return [override];
  const out = [];
  const perWs = process.env.RT_WS_BRIDGE_KEY;
  if (perWs && tenantWsId && !config.pooled && tenantWsId === config.workspaceId) {
    out.push(perWs);
  }
  if (config.bridgeHmacSecret) out.push(config.bridgeHmacSecret);
  return out;
}

/**
 * Run `verify(secret)` over the candidates; the first success wins, the
 * LAST failure is reported (so a bad signature says "Invalid HMAC
 * signature", not whatever the per-workspace attempt said).
 */
async function withCandidates(secrets, verify) {
  let last = { ok: false, status: 401, error: 'No HMAC secret configured' };
  for (const secret of secrets) {
    last = await verify(secret);
    if (last.ok) return last;
  }
  return last;
}

/**
 * Verify a path-based S2S request (either version) without sending a
 * response — for handlers that embed the check (tools/execute, bridge
 * receive). Resolves { ok, status, error, version, tenantWsId }.
 */
async function verifyS2sRequest(req, routePath, { tenantRequired = false, secret } = {}) {
  const headers = req.headers || {};
  const sigV = headers[s2s.SIGV_HEADER];
  const rawTenant = headers[TENANT_WS_HEADER];
  const tenantWsId = typeof rawTenant === 'string' && rawTenant.trim() ? rawTenant.trim() : undefined;

  if (tenantRequired && !tenantWsId) {
    return { ok: false, status: 401, error: 'Missing X-Rt-Workspace header' };
  }

  const secrets = candidateSecrets(tenantWsId, secret);
  if (sigV === undefined) {
    const r = await withCandidates(secrets, (sec) => verifyV1Sync(headers, routePath, tenantWsId, sec));
    return { ...r, version: 1, tenantWsId };
  }
  if (sigV === '2') {
    const r = await withCandidates(secrets, (sec) => s2s.verifyPathV2({ headers, rawBody: req.rawBody, routePath, tenantWsId, secret: sec }));
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

    const secrets = candidateSecrets(tenantWsId);

    // v1 stays synchronous (no nonce store round-trip) so legacy callers and
    // their tests see no change in timing; v2 awaits the nonce store.
    if (sigV === undefined) {
      let r = { ok: false, status: 401, error: 'No HMAC secret configured' };
      for (const sec of secrets) {
        r = verifyV1Sync(headers, routePath, tenantWsId, sec);
        if (r.ok) break;
      }
      return finish(r);
    }
    if (sigV !== '2') {
      return res.status(401).json({ error: `Unsupported X-Rt-Sig-V '${String(sigV)}'` });
    }
    withCandidates(secrets, (sec) => s2s.verifyPathV2({ headers, rawBody: req.rawBody, routePath, tenantWsId, secret: sec }))
      .then(finish)
      .catch((err) => res.status(500).json({ error: `HMAC verification error: ${err.message}` }));
  };
}

module.exports = { requireHmac, verifyS2sRequest, candidateSecrets, TENANT_WS_HEADER };
