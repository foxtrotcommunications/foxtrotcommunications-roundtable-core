const crypto = require('crypto');
const config = require('../config');

// In-memory cache to prevent spamming the control plane
let manifestCache = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 5000; // 5 seconds

/**
 * Fetches the dynamic workspace manifest (bridges, contracts, MCPs) from the control plane.
 * Uses HMAC authentication.
 * Falls back to process.env if network fails.
 */
async function fetchManifest() {
  const now = Date.now();
  if (manifestCache && (now - lastFetchTime) < CACHE_TTL_MS) {
    return manifestCache;
  }

  const controlPlaneUrl = process.env.CONTROL_PLANE_URL || 'https://roundtable.foxtrotcommunications.net';
  const wsId = config.workspaceId;
  const secret = config.sessionSecret || '';

  const timestamp = Date.now().toString();
  const signature = crypto.createHmac('sha256', secret).update(`${wsId}:${timestamp}`).digest('hex');

  const fallbackManifest = {
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
      return fallbackManifest;
    }

    const data = await response.json();
    
    // Only cache on success
    manifestCache = {
      RT_BRIDGES: Array.isArray(data.RT_BRIDGES) ? data.RT_BRIDGES : fallbackManifest.RT_BRIDGES,
      RT_CONTRACTS: Array.isArray(data.RT_CONTRACTS) ? data.RT_CONTRACTS : fallbackManifest.RT_CONTRACTS,
      RT_MCP_SERVERS: Array.isArray(data.RT_MCP_SERVERS) ? data.RT_MCP_SERVERS : fallbackManifest.RT_MCP_SERVERS,
      RT_A2A_AGENTS: Array.isArray(data.RT_A2A_AGENTS) ? data.RT_A2A_AGENTS : fallbackManifest.RT_A2A_AGENTS,
    };
    lastFetchTime = now;
    
    return manifestCache;
  } catch (err) {
    console.warn(`[manifest] Dynamic manifest fetch error: ${err.message}. Falling back to env vars.`);
    return fallbackManifest;
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
