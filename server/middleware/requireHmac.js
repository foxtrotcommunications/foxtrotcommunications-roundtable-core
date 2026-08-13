// server/middleware/requireHmac.js — control-plane/S2S HMAC guard, shared.
//
// Same semantics as the inline copy in server/index.js, extended for the
// pooled runtime: the caller may bind a tenant into the signature.
//
//   Header absent (dedicated fleet, today's callers):
//     signature = HMAC(secret, "<path>:<timestamp>")            — unchanged
//   Header X-Rt-Workspace present:
//     signature = HMAC(secret, "<path>:<timestamp>:<wsId>")
//     → req.rtTenant = { workspaceId } on success
//
// `tenantRequired: true` (every pooled mount) rejects headerless requests —
// a pooled S2S route without a tenant has nowhere to write.
//
// server/index.js keeps its inline copy so dedicated pods carry zero drift;
// converging them is a post-cutover cleanup.

const crypto = require('crypto');
const config = require('../config');

const TENANT_WS_HEADER = 'x-rt-workspace';

function requireHmac(routePath, { tenantRequired = false } = {}) {
  return (req, res, next) => {
    const signature = req.headers['x-control-plane-signature'];
    const timestamp = req.headers['x-control-plane-timestamp'];
    const tenantWs = req.headers[TENANT_WS_HEADER];

    if (!signature || !timestamp) {
      return res.status(401).json({ error: 'Missing HMAC signature' });
    }
    if (tenantRequired && (typeof tenantWs !== 'string' || !tenantWs.trim())) {
      return res.status(401).json({ error: 'Missing X-Rt-Workspace header' });
    }

    // Reject stale requests (5 min window)
    if (Math.abs(Date.now() - parseInt(timestamp)) > 5 * 60 * 1000) {
      return res.status(401).json({ error: 'HMAC timestamp expired' });
    }

    const signedString = typeof tenantWs === 'string' && tenantWs.trim()
      ? `${routePath}:${timestamp}:${tenantWs.trim()}`
      : `${routePath}:${timestamp}`;
    const expectedSig = crypto
      .createHmac('sha256', config.bridgeHmacSecret)
      .update(signedString)
      .digest('hex');

    try {
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
        return res.status(401).json({ error: 'Invalid HMAC signature' });
      }
    } catch {
      return res.status(401).json({ error: 'Invalid HMAC signature' });
    }

    if (typeof tenantWs === 'string' && tenantWs.trim()) {
      req.rtTenant = { workspaceId: tenantWs.trim() };
    }
    next();
  };
}

module.exports = { requireHmac, TENANT_WS_HEADER };
