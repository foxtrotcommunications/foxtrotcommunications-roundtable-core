// server/pooled/tenantContext.ts — assemble the per-request TenantContext.
//
// This is what rides the capability ctx into the plugin's resolveConfig():
// the tenant's workspace id, the pooled service-role database URL, and —
// when the tenant has a Plaid connection — credentials fetched per request
// from Secret Manager (tenantCredentials.ts, ≤5-min tenant-keyed cache,
// audit-logged).
//
// Credentials resolve from the tenant's manifest RT_CONNECTIONS (a sanitized
// control-plane addition: config fields only, never secrets). An older
// control plane without it, or a tenant with no live connection, yields a
// context WITHOUT credentials — Plaid-touching capabilities then fail
// per-capability while DB-backed capabilities work, which is exactly the
// shadow-parity read-only posture. Never fall back to env credentials here:
// env belongs to dedicated pods.

const config = require('../config');
// Module object, not a destructure — call through it so the reference stays
// live (test spies, and any future hot credential-module swap, both work).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tenantCredentials = require('../tenantCredentials');
import type { ResolvedTenant } from './tenantResolver.js';

/** Mirrors @pendragon/tools-plaid src/tenant.ts TenantContext. */
export interface TenantContext {
  workspaceId: string;
  databaseUrl?: string;
  domainType?: string;
  accessToken?: string;
  clientId?: string;
  secret?: string;
  env?: 'sandbox' | 'production';
  itemId?: string;
}

export async function buildTenantContext(resolved: ResolvedTenant): Promise<TenantContext> {
  const tenant: TenantContext = {
    workspaceId: resolved.workspaceId,
    // The pooled Deployment's DATABASE_URL IS the NOBYPASSRLS service role;
    // one shared pool for all tenants, SET LOCAL pins each transaction.
    databaseUrl: config.databaseUrl,
    domainType: config.pooledDomainType || undefined,
  };

  const plaidConn = resolved.manifest.RT_CONNECTIONS?.find((c) => c.type === 'plaid');
  if (plaidConn?.connId) {
    let creds: Record<string, unknown> | null = null;
    try {
      creds = await tenantCredentials.getConnectionSecret(resolved.workspaceId, plaidConn.connId);
    } catch (err: any) {
      // Credentials unavailable ≠ no credentials configured: surface loudly,
      // continue without — the capability that needs them reports the failure.
      console.error(
        `[tenantContext] credential fetch failed for ${resolved.workspaceId}/${plaidConn.connId}: ${err?.message}`,
      );
    }
    if (creds) {
      // Field names follow the control plane's stored connection payload,
      // which is camelCase: buildConnectionEnvVars env-ifies these same keys
      // via camelCase → UPPER_SNAKE (accessToken → {PREFIX}_ACCESS_TOKEN,
      // plaidSecret → {PREFIX}_PLAID_SECRET), so the reverse mapping is
      // authoritative. Snake/UPPER variants tolerated so payload-shape drift
      // degrades to "missing field", never to another tenant's data.
      const pick = (...keys: string[]) => {
        for (const k of keys) {
          const v = creds![k];
          if (typeof v === 'string' && v) return v;
        }
        return undefined;
      };
      tenant.accessToken = pick('accessToken', 'access_token', 'ACCESS_TOKEN');
      tenant.clientId = pick('clientId', 'client_id', 'CLIENT_ID');
      tenant.secret = pick('plaidSecret', 'plaid_secret', 'secret', 'PLAID_SECRET');
      tenant.env = (pick('plaidEnv', 'plaid_env', 'env', 'PLAID_ENV') as TenantContext['env']) || undefined;
      tenant.itemId = pick('itemId', 'item_id', 'ITEM_ID');
    }
  }

  return tenant;
}
