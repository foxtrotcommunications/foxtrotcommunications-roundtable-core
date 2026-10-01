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

/** One Plaid connection of a pooled tenant, credentials resolved — the
 *  request-scoped replacement for a dedicated pod's CONN_PLAID_N env block. */
export interface TenantPlaidConnection {
  connId: string;
  name?: string;
  envPrefix?: string;
  type: 'plaid';
  domainType?: string;
  accessToken?: string;
  clientId?: string;
  secret?: string;
  env?: 'sandbox' | 'production';
  itemId?: string;
}

type ManifestConnection = NonNullable<ResolvedTenant['manifest']['RT_CONNECTIONS']>[number];

/**
 * Resolve ONE manifest Plaid connection into credentials + config. Non-secret
 * config rides the manifest (control plane sends conn.config verbatim:
 * clientId / plaidEnv / itemId / domainType); the Secret Manager payload
 * carries ONLY the secret fields (accessToken / plaidSecret). Before this
 * split was honored every pooled Plaid call went out without a client id
 * (Plaid MISSING_FIELDS) and defaulted to the production environment.
 */
async function resolvePlaidConnection(workspaceId: string, conn: ManifestConnection): Promise<TenantPlaidConnection> {
  const out: TenantPlaidConnection = {
    connId: conn.connId,
    name: conn.name,
    envPrefix: conn.envPrefix,
    type: 'plaid',
    domainType: conn.domainType,
  };
  const cfg = (conn.config ?? {}) as Record<string, unknown>;
  const cfgStr = (k: string) => (typeof cfg[k] === 'string' && cfg[k] ? (cfg[k] as string) : undefined);
  out.clientId = cfgStr('clientId');
  out.env = (cfgStr('plaidEnv') as TenantPlaidConnection['env']) || undefined;
  out.itemId = cfgStr('itemId');
  out.domainType = out.domainType || cfgStr('domainType');

  let creds: Record<string, unknown> | null = null;
  try {
    creds = await tenantCredentials.getConnectionSecret(workspaceId, conn.connId);
  } catch (err: any) {
    // Credentials unavailable ≠ no credentials configured: surface loudly,
    // continue without — the capability that needs them reports the failure.
    console.error(
      `[tenantContext] credential fetch failed for ${workspaceId}/${conn.connId}: ${err?.message}`,
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
    out.accessToken = pick('accessToken', 'access_token', 'ACCESS_TOKEN');
    out.secret = pick('plaidSecret', 'plaid_secret', 'secret', 'PLAID_SECRET');
    // Secret payload wins if it happens to carry these (older payloads may).
    out.clientId = pick('clientId', 'client_id', 'CLIENT_ID') ?? out.clientId;
    out.env = (pick('plaidEnv', 'plaid_env', 'env', 'PLAID_ENV') as TenantPlaidConnection['env']) || out.env;
    out.itemId = pick('itemId', 'item_id', 'ITEM_ID') ?? out.itemId;
  }
  return out;
}

/**
 * Every Plaid connection on a tenant's manifest, credentials resolved. This is
 * what the S2S routes (tools-plaid `/api/sync`) consume on the pooled runtime
 * in place of `process.env.RT_CONNECTIONS` — a pooled pod has no such env, so
 * until this existed every `POST /api/sync` on a pooled service answered
 * 400 "No connections configured" (observed live 2026-10-01: a new Retirement
 * domain never received its first sync).
 */
export async function resolveTenantConnections(
  manifest: ResolvedTenant['manifest'] | null | undefined,
  workspaceId: string,
): Promise<TenantPlaidConnection[]> {
  const conns = (manifest?.RT_CONNECTIONS ?? []).filter((c) => c && c.type === 'plaid' && c.connId);
  const out: TenantPlaidConnection[] = [];
  for (const c of conns) out.push(await resolvePlaidConnection(workspaceId, c));
  return out;
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
    const resolvedConn = await resolvePlaidConnection(resolved.workspaceId, plaidConn);
    tenant.accessToken = resolvedConn.accessToken;
    tenant.clientId = resolvedConn.clientId;
    tenant.secret = resolvedConn.secret;
    tenant.env = resolvedConn.env;
    tenant.itemId = resolvedConn.itemId;
  }

  return tenant;
}
