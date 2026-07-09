const crypto = require('crypto');
const config = require('../config');
const { validateAndLogContracts } = require('./validateContracts');

// In-memory cache to prevent spamming the control plane
let manifestCache = null;
let lastFetchTime = 0;
let hasEverFetched = false; // Track whether we've ever successfully fetched
const CACHE_TTL_MS = 5000; // 5 seconds

/**
 * Fetches the dynamic workspace manifest (bridges, contracts, MCPs) from the control plane.
 * Uses HMAC authentication.
 *
 * Fallback strategy:
 *   - If we've NEVER successfully fetched, fall back to process.env (first boot).
 *   - If we HAVE fetched before but the control plane is temporarily down,
 *     return the last known good manifest (stale cache) instead of env vars.
 *   - This prevents stale env vars from overriding a control plane that
 *     deleted a bridge (the exact scenario that caused ghost connections).
 */
async function fetchManifest() {
  const now = Date.now();
  if (manifestCache && (now - lastFetchTime) < CACHE_TTL_MS) {
    return manifestCache;
  }

  const controlPlaneUrl = process.env.CONTROL_PLANE_URL || 'https://roundtable.foxtrotcommunications.net';
  const wsId = config.workspaceId;
  // Control plane verifies with BRIDGE_HMAC_SECRET (falls back to SESSION_SECRET
  // in config) — signing with sessionSecret directly 401s once the secrets split.
  const secret = config.bridgeHmacSecret || '';

  const timestamp = Date.now().toString();
  const signature = crypto.createHmac('sha256', secret).update(`${wsId}:${timestamp}`).digest('hex');

  // Env-based fallback — only used if we've NEVER successfully fetched (first boot)
  const envFallback = {
    RT_BRIDGES: parseEnvJson('RT_BRIDGES', []),
    RT_CONTRACTS: parseEnvJson('RT_CONTRACTS', []),
    RT_MCP_SERVERS: parseEnvJson('RT_MCP_SERVERS', []),
    RT_A2A_AGENTS: parseEnvJson('RT_A2A_AGENTS', []),
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
      console.warn(`[manifest] Failed to fetch dynamic manifest: ${response.status} ${response.statusText}`);
      // If we've fetched before, return last known good; otherwise env fallback
      return hasEverFetched ? manifestCache : envFallback;
    }

    const data = await response.json();
    
    // Only cache on success — merge env-based config for any arrays
    // the control plane returns as empty (not yet migrated to Firestore)
    const envBridges = parseEnvJson('RT_BRIDGES', []);
    const envContracts = parseEnvJson('RT_CONTRACTS', []);
    const envMcpServers = parseEnvJson('RT_MCP_SERVERS', []);
    const envAgents = parseEnvJson('RT_A2A_AGENTS', []);

    manifestCache = {
      RT_BRIDGES: (Array.isArray(data.RT_BRIDGES) && data.RT_BRIDGES.length > 0) ? data.RT_BRIDGES : envBridges,
      RT_CONTRACTS: (Array.isArray(data.RT_CONTRACTS) && data.RT_CONTRACTS.length > 0) ? data.RT_CONTRACTS : envContracts,
      RT_MCP_SERVERS: (Array.isArray(data.RT_MCP_SERVERS) && data.RT_MCP_SERVERS.length > 0) ? data.RT_MCP_SERVERS : envMcpServers,
      RT_A2A_AGENTS: (Array.isArray(data.RT_A2A_AGENTS) && data.RT_A2A_AGENTS.length > 0) ? data.RT_A2A_AGENTS : envAgents,
    };
    lastFetchTime = now;

    // Validate contracts on first successful fetch
    if (!hasEverFetched) {
      validateAndLogContracts(manifestCache.RT_CONTRACTS, 'control-plane');
    }
    hasEverFetched = true;
    
    return manifestCache;
  } catch (err) {
    console.warn(`[manifest] Dynamic manifest fetch error: ${err.message}`);
    // If we've fetched before, return last known good (not stale env vars)
    if (hasEverFetched && manifestCache) {
      console.warn('[manifest] Returning last known good manifest (not env fallback)');
      return manifestCache;
    }
    console.warn('[manifest] First boot — falling back to env vars');
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
