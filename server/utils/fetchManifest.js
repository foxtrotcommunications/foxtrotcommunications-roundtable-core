const crypto = require('crypto');
const config = require('../config');
const { validateAndLogContracts } = require('./validateContracts');

// In-memory cache to prevent spamming the control plane.
// KEYED BY WORKSPACE: a pooled process serves many tenants, and an unkeyed
// cache would hand tenant B the first tenant's bridges and governance
// contracts — an authorization bug, not a staleness bug. Dedicated pods have
// exactly one key (config.workspaceId), preserving old behavior.
// Each entry: { manifest, lastFetchTime, hasEverFetched }
const manifestCacheByWs = new Map();
const CACHE_TTL_MS = 5000; // 5 seconds

function cacheEntry(wsId) {
  let entry = manifestCacheByWs.get(wsId);
  if (!entry) {
    entry = { manifest: null, lastFetchTime: 0, hasEverFetched: false };
    manifestCacheByWs.set(wsId, entry);
  }
  return entry;
}

/**
 * Fetches the dynamic workspace manifest (bridges, contracts, MCPs) from the control plane.
 * Uses HMAC authentication.
 *
 * `workspaceId` — the tenant to fetch for. Omitted → the process's own
 * workspace (dedicated pods). Pooled services MUST pass it per request.
 *
 * Fallback strategy:
 *   - If we've NEVER successfully fetched, fall back to process.env (first boot).
 *     Env fallback only applies to the process's own workspace — for any other
 *     tenant the env vars are someone else's config, so the fallback is empty.
 *   - If we HAVE fetched before but the control plane is temporarily down,
 *     return the last known good manifest (stale cache) instead of env vars.
 *   - This prevents stale env vars from overriding a control plane that
 *     deleted a bridge (the exact scenario that caused ghost connections).
 */
async function fetchManifest(workspaceId) {
  const wsId = workspaceId || config.workspaceId;
  const entry = cacheEntry(wsId);
  const now = Date.now();
  if (entry.manifest && (now - entry.lastFetchTime) < CACHE_TTL_MS) {
    return entry.manifest;
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
    RT_BRIDGES: isOwnWorkspace ? parseEnvJson('RT_BRIDGES', []) : [],
    RT_CONTRACTS: isOwnWorkspace ? parseEnvJson('RT_CONTRACTS', []) : [],
    RT_MCP_SERVERS: isOwnWorkspace ? parseEnvJson('RT_MCP_SERVERS', []) : [],
    RT_A2A_AGENTS: isOwnWorkspace ? parseEnvJson('RT_A2A_AGENTS', []) : [],
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
      console.warn(`[manifest] Failed to fetch dynamic manifest (${wsId}): ${response.status} ${response.statusText}`);
      // If we've fetched before, return last known good; otherwise env fallback
      return entry.hasEverFetched ? entry.manifest : envFallback;
    }

    const data = await response.json();

    // Only cache on success — merge env-based config for any arrays
    // the control plane returns as empty (not yet migrated to Firestore)
    entry.manifest = {
      RT_BRIDGES: (Array.isArray(data.RT_BRIDGES) && data.RT_BRIDGES.length > 0) ? data.RT_BRIDGES : envFallback.RT_BRIDGES,
      RT_CONTRACTS: (Array.isArray(data.RT_CONTRACTS) && data.RT_CONTRACTS.length > 0) ? data.RT_CONTRACTS : envFallback.RT_CONTRACTS,
      RT_MCP_SERVERS: (Array.isArray(data.RT_MCP_SERVERS) && data.RT_MCP_SERVERS.length > 0) ? data.RT_MCP_SERVERS : envFallback.RT_MCP_SERVERS,
      RT_A2A_AGENTS: (Array.isArray(data.RT_A2A_AGENTS) && data.RT_A2A_AGENTS.length > 0) ? data.RT_A2A_AGENTS : envFallback.RT_A2A_AGENTS,
    };
    entry.lastFetchTime = now;

    // Validate contracts on first successful fetch
    if (!entry.hasEverFetched) {
      validateAndLogContracts(entry.manifest.RT_CONTRACTS, `control-plane:${wsId}`);
    }
    entry.hasEverFetched = true;

    return entry.manifest;
  } catch (err) {
    console.warn(`[manifest] Dynamic manifest fetch error (${wsId}): ${err.message}`);
    // If we've fetched before, return last known good (not stale env vars)
    if (entry.hasEverFetched && entry.manifest) {
      console.warn('[manifest] Returning last known good manifest (not env fallback)');
      return entry.manifest;
    }
    console.warn(`[manifest] First fetch for ${wsId} failed — falling back to ${isOwnWorkspace ? 'env vars' : 'empty manifest'}`);
    validateAndLogContracts(envFallback.RT_CONTRACTS, 'RT_CONTRACTS env');
    return envFallback;
  }
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

module.exports = { fetchManifest };
