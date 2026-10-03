const crypto = require('crypto');
const config = require('../config');
const { validateAndLogContracts } = require('./validateContracts');

// In-memory cache to prevent spamming the control plane.
// KEYED BY WORKSPACE: a pooled process serves many tenants, and an unkeyed
// cache would hand tenant B the first tenant's bridges and governance
// contracts — an authorization bug, not a staleness bug. Dedicated pods have
// exactly one key (config.workspaceId), preserving old behavior.
// Each entry: { manifest, lastFetchTime, hasEverFetched, lastError,
//               lastErrorAt, degraded }
const manifestCacheByWs = new Map();
const CACHE_TTL_MS = 5000; // 5 seconds

/** An empty manifest — what a tenant gets when nothing trustworthy is known. */
function emptyManifest() {
  return {
    RT_BRIDGES: [],
    RT_CONTRACTS: [],
    RT_MCP_SERVERS: [],
    RT_A2A_AGENTS: [],
    RT_CONNECTIONS: [],
    orgId: null,
  };
}

/**
 * Fail-closed switch (upgrade plan 1.1). Default ON everywhere:
 *   - a 200 from the control plane is the truth, empty arrays included;
 *   - env vars (RT_BRIDGES/RT_CONTRACTS/…) are consulted ONLY before the
 *     first successful fetch, ONLY for the process's own workspace;
 *   - a last-known-good manifest is served for at most RT_MANIFEST_STALE_MAX_MS
 *     (default 15 min) after the last success, then the tenant degrades to
 *     ZERO contracts/bridges and the health flag flips.
 * RT_MANIFEST_FAIL_CLOSED=false restores the pre-1.1 behavior (per-array env
 * resurrection on a 200, unbounded last-known-good) as a documented
 * off-switch for a fleet that cannot yet tolerate the stricter mode.
 */
function failClosed() {
  return String(process.env.RT_MANIFEST_FAIL_CLOSED ?? 'true').toLowerCase() !== 'false';
}

function staleMaxMs() {
  const n = parseInt(process.env.RT_MANIFEST_STALE_MAX_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
}

function cacheEntry(wsId) {
  let entry = manifestCacheByWs.get(wsId);
  if (!entry) {
    entry = {
      manifest: null,
      lastFetchTime: 0,
      hasEverFetched: false,
      lastError: null,
      lastErrorAt: 0,
      degraded: false,
    };
    manifestCacheByWs.set(wsId, entry);
  }
  return entry;
}

/**
 * Serve the last-known-good manifest while it is young enough, otherwise
 * degrade to an empty manifest and flag the tenant. The degraded value is
 * NOT cached as `manifest`, so recovery is immediate on the next good fetch.
 */
function serveLastKnownGood(entry, wsId, now, reason) {
  entry.lastError = reason;
  entry.lastErrorAt = now;
  const age = now - entry.lastFetchTime;
  if (!failClosed() || age <= staleMaxMs()) {
    if (entry.degraded) {
      // Already past the bound once; stay degraded until a real success.
      return emptyManifest();
    }
    console.warn(`[manifest] Returning last known good manifest for ${wsId} (age ${Math.round(age / 1000)}s): ${reason}`);
    return entry.manifest;
  }
  if (!entry.degraded) {
    console.error(`[manifest] DEGRADED: last known good for ${wsId} is ${Math.round(age / 1000)}s old (> RT_MANIFEST_STALE_MAX_MS ${staleMaxMs()}ms) — serving ZERO contracts/bridges until the control plane answers`);
  }
  entry.degraded = true;
  return emptyManifest();
}

/**
 * Fetches the dynamic workspace manifest (bridges, contracts, MCPs) from the control plane.
 * Uses HMAC authentication.
 *
 * `workspaceId` — the tenant to fetch for. Omitted → the process's own
 * workspace (dedicated pods). Pooled services MUST pass it per request.
 *
 * Fallback strategy (fail closed, see failClosed()):
 *   - A 200 is the answer. An empty RT_CONTRACTS on a 200 means NO contracts
 *     — env vars never resurrect an array the control plane returned empty.
 *   - If we've NEVER successfully fetched, fall back to process.env (first
 *     boot), loudly, and only for the process's own workspace — for any other
 *     tenant the env vars are someone else's config, so the fallback is empty.
 *   - If we HAVE fetched before but the control plane is down, return the
 *     last known good manifest for at most RT_MANIFEST_STALE_MAX_MS, then
 *     degrade to an empty manifest + health flag (manifestHealth()).
 */
async function fetchManifest(workspaceId) {
  const wsId = workspaceId || config.workspaceId;
  const entry = cacheEntry(wsId);
  const now = Date.now();
  if (entry.manifest && (now - entry.lastFetchTime) < CACHE_TTL_MS) {
    return entry.manifest;
  }
  // Degraded tenants are re-tried at the same cadence, not on every call —
  // a down control plane must not also cost every request a 5s timeout.
  if (entry.degraded && (now - entry.lastErrorAt) < CACHE_TTL_MS) {
    return emptyManifest();
  }

  const controlPlaneUrl = process.env.CONTROL_PLANE_URL || 'https://roundtable.foxtrotcommunications.net';
  // Control plane verifies with BRIDGE_HMAC_SECRET (falls back to SESSION_SECRET
  // in config) — signing with sessionSecret directly 401s once the secrets split.
  const secret = config.bridgeHmacSecret || '';

  const timestamp = Date.now().toString();
  const signature = crypto.createHmac('sha256', secret).update(`${wsId}:${timestamp}`).digest('hex');

  // Env-based fallback — only valid for the process's own workspace, and only
  // if we've NEVER successfully fetched (first boot). Other tenants get an
  // empty manifest rather than someone else's bridges.
  const isOwnWorkspace = wsId === config.workspaceId;
  const envFallback = {
    ...emptyManifest(),
    RT_BRIDGES: isOwnWorkspace ? parseEnvJson('RT_BRIDGES', []) : [],
    RT_CONTRACTS: isOwnWorkspace ? parseEnvJson('RT_CONTRACTS', []) : [],
    RT_MCP_SERVERS: isOwnWorkspace ? parseEnvJson('RT_MCP_SERVERS', []) : [],
    RT_A2A_AGENTS: isOwnWorkspace ? parseEnvJson('RT_A2A_AGENTS', []) : [],
  };
  const firstBootFallback = (reason) => {
    const usingEnv = isOwnWorkspace && Object.values(envFallback).some((v) => Array.isArray(v) && v.length > 0);
    console.error(`[manifest] First fetch for ${wsId} failed (${reason}) — ${usingEnv ? 'FALLING BACK TO ENV VARS (first boot only; the control plane has never answered)' : 'serving an EMPTY manifest'}`);
    entry.lastError = reason;
    entry.lastErrorAt = Date.now();
    if (usingEnv) validateAndLogContracts(envFallback.RT_CONTRACTS, 'RT_CONTRACTS env');
    return envFallback;
  };

  try {
    const url = `${controlPlaneUrl}/api/internal/workspaces/${wsId}/manifest`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Signature': signature,
        'X-Bridge-Timestamp': timestamp,
        'X-Bridge-WsId': wsId,
      },
      signal: AbortSignal.timeout(5000), // Fast timeout so tools don't hang
    });

    if (!response.ok) {
      const reason = `HTTP ${response.status} ${response.statusText}`;
      console.warn(`[manifest] Failed to fetch dynamic manifest (${wsId}): ${reason}`);
      return entry.hasEverFetched ? serveLastKnownGood(entry, wsId, now, reason) : firstBootFallback(reason);
    }

    const data = await response.json();

    const arr = (v) => (Array.isArray(v) ? v : []);
    if (failClosed()) {
      // A 200 is the truth. Empty means empty — no env resurrection.
      entry.manifest = {
        RT_BRIDGES: arr(data.RT_BRIDGES),
        RT_CONTRACTS: arr(data.RT_CONTRACTS),
        RT_MCP_SERVERS: arr(data.RT_MCP_SERVERS),
        RT_A2A_AGENTS: arr(data.RT_A2A_AGENTS),
        RT_CONNECTIONS: arr(data.RT_CONNECTIONS),
        orgId: typeof data.orgId === 'string' ? data.orgId : null,
      };
    } else {
      // Legacy (RT_MANIFEST_FAIL_CLOSED=false): merge env-based config for
      // any arrays the control plane returns as empty.
      entry.manifest = {
        RT_BRIDGES: arr(data.RT_BRIDGES).length > 0 ? data.RT_BRIDGES : envFallback.RT_BRIDGES,
        RT_CONTRACTS: arr(data.RT_CONTRACTS).length > 0 ? data.RT_CONTRACTS : envFallback.RT_CONTRACTS,
        RT_MCP_SERVERS: arr(data.RT_MCP_SERVERS).length > 0 ? data.RT_MCP_SERVERS : envFallback.RT_MCP_SERVERS,
        RT_A2A_AGENTS: arr(data.RT_A2A_AGENTS).length > 0 ? data.RT_A2A_AGENTS : envFallback.RT_A2A_AGENTS,
        RT_CONNECTIONS: arr(data.RT_CONNECTIONS),
        orgId: typeof data.orgId === 'string' ? data.orgId : null,
      };
    }
    entry.lastFetchTime = now;
    if (entry.degraded) console.warn(`[manifest] RECOVERED: control plane answered for ${wsId}`);
    entry.degraded = false;
    entry.lastError = null;

    // Validate contracts on first successful fetch
    if (!entry.hasEverFetched) {
      validateAndLogContracts(entry.manifest.RT_CONTRACTS, `control-plane:${wsId}`);
    }
    entry.hasEverFetched = true;

    return entry.manifest;
  } catch (err) {
    console.warn(`[manifest] Dynamic manifest fetch error (${wsId}): ${err.message}`);
    if (entry.hasEverFetched && entry.manifest) {
      return serveLastKnownGood(entry, wsId, now, err.message);
    }
    return firstBootFallback(err.message);
  }
}

/**
 * Health flag for /api/health: per-workspace manifest freshness. `degraded`
 * is true when some tenant is being served an empty manifest because the
 * control plane has been unreachable longer than RT_MANIFEST_STALE_MAX_MS.
 */
function manifestHealth() {
  const now = Date.now();
  const workspaces = {};
  let degraded = false;
  let stale = false;
  for (const [wsId, entry] of manifestCacheByWs.entries()) {
    const ageMs = entry.hasEverFetched ? now - entry.lastFetchTime : null;
    const isStale = !!(entry.hasEverFetched && entry.lastErrorAt > entry.lastFetchTime);
    if (entry.degraded) degraded = true;
    if (isStale) stale = true;
    workspaces[wsId] = {
      hasEverFetched: entry.hasEverFetched,
      ageMs,
      servingStale: isStale && !entry.degraded,
      degraded: entry.degraded,
      lastError: entry.lastError,
    };
  }
  return {
    failClosed: failClosed(),
    staleMaxMs: staleMaxMs(),
    degraded,
    stale,
    workspaces,
  };
}

/** Test/ops hook: forget everything cached (does not touch env). */
function resetManifestCache() {
  manifestCacheByWs.clear();
}

function parseEnvJson(envName, defaultValue) {
  const val = process.env[envName];
  if (!val) return defaultValue;
  try {
    return JSON.parse(val);
  } catch (_) {
    return defaultValue;
  }
}

module.exports = { fetchManifest, manifestHealth, resetManifestCache };
