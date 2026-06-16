// DEPRECATED: This file has been replaced by @pendragon/tools-plaid
// It will be removed in a future release.
// server/capabilities/index.ts — Domain capability registration
// Reads RT_CONNECTIONS to determine which Plaid domain capabilities
// to register on the workspace's capability registry.

import type { CapabilityRegistry } from '../protocols/capabilityRegistry.js';
import { registerCheckingCapabilities } from './checking.js';
import { registerInvestmentCapabilities } from './investments.js';

// ─── Connection type detection ──────────────────────────────────────────────

interface PlaidConnection {
  type: string;
  envPrefix: string;
  domainType?: string;
}

/**
 * Parse RT_CONNECTIONS and find the Plaid connection's domain type.
 * Returns the domainType string (e.g. 'checking', 'investments', 'retirement')
 * or null if no Plaid connection is configured.
 */
function detectPlaidDomainType(): string | null {
  const raw = process.env.RT_CONNECTIONS;
  if (!raw) return null;

  try {
    const connections: PlaidConnection[] = JSON.parse(raw);
    const plaid = Array.isArray(connections)
      ? connections.find((c) => c.type === 'plaid')
      : null;

    if (!plaid) return null;

    // Domain type can be on the connection object directly or via env var
    if (plaid.domainType) return plaid.domainType;

    // Fall back to the env-prefix convention: {PREFIX}_DOMAIN_TYPE
    const envDomain = plaid.envPrefix
      ? process.env[`${plaid.envPrefix}_DOMAIN_TYPE`]
      : null;

    return envDomain || null;
  } catch {
    return null;
  }
}

// ─── Targeted registration ──────────────────────────────────────────────────

/**
 * Register capabilities for a specific domain type.
 */
export function registerDomainCapabilities(
  registry: CapabilityRegistry,
  domainType: string,
): void {
  switch (domainType) {
    case 'checking':
    case 'savings':
      registerCheckingCapabilities(registry);
      break;

    case 'investments':
    case 'retirement':
      registerInvestmentCapabilities(registry);
      break;

    default:
      // Unknown domain — register nothing; log for visibility
      console.warn(`[capabilities] Unknown domain type '${domainType}', skipping registration`);
  }
}

// ─── Auto-detect registration ───────────────────────────────────────────────

/**
 * Auto-detect the Plaid domain from RT_CONNECTIONS and register the
 * appropriate capabilities on the registry.
 */
export function registerAllCapabilities(registry: CapabilityRegistry): void {
  const domainType = detectPlaidDomainType();
  if (!domainType) {
    // No Plaid connection configured — nothing to register
    return;
  }

  console.log(`[capabilities] Registering ${domainType} domain capabilities`);
  registerDomainCapabilities(registry, domainType);
}
