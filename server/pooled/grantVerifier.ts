// server/pooled/grantVerifier.ts — consent-grant verifier for `grant_required`
// prerequisites on the pooled runtime (upgrade plan 5.3).
//
// The application plugin (@pendragon/tools-plaid) owns consent grants: the
// API mints them on the user's tap, `assertGrant` checks presence → row →
// scope → target → expiry → signature and then CONSUMES the grant (single
// use) in the caller's transaction. The capability that runs after our
// prerequisite check consumes the grant itself, so the prerequisite must
// only PEEK: we run the plugin's own assertGrant inside a tenant-pinned
// transaction and always ROLL IT BACK. Same checks, same code, no consume.
//
// Wired only when the plugin exports assertGrant/targetFor/isGrantScope and
// the request has a tenant with a database (pooled). Anything else returns
// undefined and the executor denies every grant_required prerequisite —
// a contract that demands attested consent is not satisfiable on a receiver
// that cannot check it.

import { Pool } from 'pg';
import type { GrantVerifier } from '../protocols/prerequisites';

interface GrantPlugin {
  assertGrant: (q: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, args: {
    workspaceId: string; grantId: unknown; scope: string; target: string | null;
  }) => Promise<{ grant_id: string }>;
  targetFor: (scope: string, input: Record<string, unknown>) => string | null;
  isGrantScope: (s: unknown) => boolean;
}

const pools = new Map<string, Pool>();
function poolFor(databaseUrl: string): Pool {
  let p = pools.get(databaseUrl);
  if (!p) {
    p = new Pool({ connectionString: databaseUrl, max: 2 });
    pools.set(databaseUrl, p);
  }
  return p;
}

/** The plugin's grant surface, or null when it is absent / too old. */
export function loadGrantPlugin(): GrantPlugin | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const plugin = require('@pendragon/tools-plaid');
    if (typeof plugin?.assertGrant === 'function' && typeof plugin?.targetFor === 'function' && typeof plugin?.isGrantScope === 'function') {
      return plugin as GrantPlugin;
    }
  } catch { /* no application plugin installed */ }
  return null;
}

/**
 * Build the verifier for one request's tenant. `plugin` is injectable for
 * tests; production callers let it load @pendragon/tools-plaid.
 */
export function buildGrantVerifier(
  tenant: { workspaceId?: string; databaseUrl?: string } | undefined,
  plugin: GrantPlugin | null = loadGrantPlugin(),
  connect: (databaseUrl: string) => Pool = poolFor,
): GrantVerifier | undefined {
  if (!plugin) return undefined;
  const workspaceId = tenant?.workspaceId;
  const databaseUrl = tenant?.databaseUrl;
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || typeof databaseUrl !== 'string' || !databaseUrl) return undefined;

  return async (grantId, scope, params) => {
    if (!plugin.isGrantScope(scope)) return false;
    let client;
    try {
      client = await connect(databaseUrl).connect();
    } catch (e) {
      console.warn(`[grantVerifier] cannot connect for tenant ${workspaceId}: ${(e as Error).message}`);
      return false;
    }
    try {
      await client.query('BEGIN');
      // Same pinning the plugin's withTenant does: parameterized set_config,
      // transaction-local, so the tenant_context RLS policy sees the tenant.
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
      await plugin.assertGrant(client, { workspaceId, grantId, scope, target: plugin.targetFor(scope, params) });
      return true;
    } catch {
      return false; // ConsentGrantError or a transport error: not verified
    } finally {
      // ALWAYS roll back: the peek must not consume the user's tap.
      try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
      client.release();
    }
  };
}

/** Test/shutdown hook. */
export async function endGrantVerifierPools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end().catch(() => undefined)));
  pools.clear();
}
