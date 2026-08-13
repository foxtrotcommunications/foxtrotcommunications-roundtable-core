// server/tenantCredentials.ts — per-request connection credentials (pooled runtime).
//
// Dedicated pods get credentials as env vars injected at deploy time
// (CONN_PLAID_* via the control plane's sync-env). Pooled services hold NO
// tokens at rest: every request that needs a credential fetches it from
// Secret Manager here, through a tenant-keyed in-memory cache whose TTL is
// the blast-radius dial — rotation means deleting the secret version, and it
// takes effect within the TTL, no restarts.
//
// The secret layout is the control plane's existing one: one secret per
// connection, `roundtable-conn-<connId>`, JSON payload with the credential
// fields (access_token / client_id / secret / env / item_id for Plaid).
// Nothing new is written by this module — it only reads.
//
// AUTHORIZATION IS NOT DECIDED HERE. The pooled entrypoint must only ask for
// connIds that the registry lists for the requesting workspace; this module
// logs every (workspace, conn) fetch so the audit trail pairs the tenant with
// the credential even though Secret Manager's own audit log sees only the
// service account. Cache entries are keyed by (workspace, conn) so one
// tenant's cached credential is never returned for another's key.

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const GCP_PROJECT = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
const SECRET_PREFIX = 'roundtable-conn';

// Hard ceiling 5 minutes — the design decision, not a tunable default. The
// env var may only shorten it (e.g. tests, high-sensitivity deployments).
const TTL_CEILING_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = Math.min(
  TTL_CEILING_MS,
  parseInt(process.env.RT_CRED_CACHE_TTL_MS || '', 10) || TTL_CEILING_MS,
);
// Negative results are cached briefly so a misconfigured tenant can't hammer
// Secret Manager, but short enough that fixing the connection shows up fast.
const NEGATIVE_TTL_MS = 60 * 1000;

interface CacheEntry {
  data: Record<string, unknown> | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
let smClient: SecretManagerServiceClient | null = null;

function getClient(): SecretManagerServiceClient {
  if (!smClient) smClient = new SecretManagerServiceClient();
  return smClient;
}

function cacheKey(workspaceId: string, connId: string): string {
  return `${workspaceId}:${connId}`;
}

/**
 * Fetch the credential payload for a connection, on behalf of a tenant.
 * Returns null when the secret does not exist. Throws on transport errors —
 * callers must treat "credentials unavailable" as a failed capability, never
 * fall back to another tenant's credentials or to env vars.
 */
export async function getConnectionSecret(
  workspaceId: string,
  connId: string,
): Promise<Record<string, unknown> | null> {
  if (!workspaceId || !connId) {
    throw new Error('getConnectionSecret: workspaceId and connId are required');
  }
  if (!GCP_PROJECT) {
    throw new Error('getConnectionSecret: GCP_PROJECT unset — pooled mode requires Secret Manager access');
  }

  const key = cacheKey(workspaceId, connId);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.data;

  const name = `projects/${GCP_PROJECT}/secrets/${SECRET_PREFIX}-${connId}/versions/latest`;
  let data: Record<string, unknown> | null = null;
  try {
    const [version] = await getClient().accessSecretVersion({ name });
    const raw = version.payload?.data?.toString();
    data = raw ? JSON.parse(raw) : null;
  } catch (e: any) {
    if (e?.code === 5) {
      data = null; // NOT_FOUND — connection has no stored credential
    } else {
      console.error(`[credaudit] FETCH-ERROR workspace=${workspaceId} conn=${connId}: ${e?.message}`);
      throw e;
    }
  }

  // The audit line: every real fetch, paired with the tenant it served.
  // Cache hits are intentionally not logged — the fetch cadence (≤ once per
  // TTL per tenant-conn) is what bounds both log volume and blast radius.
  console.log(
    `[credaudit] fetch workspace=${workspaceId} conn=${connId} found=${data !== null} ttl_ms=${data !== null ? CACHE_TTL_MS : NEGATIVE_TTL_MS}`,
  );

  cache.set(key, {
    data,
    expiresAt: now + (data !== null ? CACHE_TTL_MS : NEGATIVE_TTL_MS),
  });
  return data;
}

/**
 * The tenant's ORG master secret (HKDF root for contract keys). Pooled
 * tenants span orgs, so this cannot be a process env — it rides the same
 * per-request fetch + tenant-keyed TTL cache + audit trail as connection
 * credentials. Secret layout is the control plane's: connection-prefixed,
 * id `org-<orgId>-master`, payload `{ key }`.
 */
export async function getOrgMasterSecret(
  workspaceId: string,
  orgId: string,
): Promise<string | null> {
  if (!orgId) return null;
  const payload = await getConnectionSecret(workspaceId, `org-${orgId}-master`);
  const key = payload?.key;
  return typeof key === 'string' && key ? key : null;
}

/** Drop every cached credential for a tenant (e.g. connection removed). */
export function invalidateTenantCredentials(workspaceId: string): number {
  let dropped = 0;
  for (const key of cache.keys()) {
    if (key.startsWith(`${workspaceId}:`)) {
      cache.delete(key);
      dropped++;
    }
  }
  return dropped;
}

/** Periodic sweep so long-idle tenants don't pin credentials in memory. */
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}, 60_000);
sweep.unref?.();

export function credentialCacheStats(): { entries: number; ttlMs: number } {
  return { entries: cache.size, ttlMs: CACHE_TTL_MS };
}
