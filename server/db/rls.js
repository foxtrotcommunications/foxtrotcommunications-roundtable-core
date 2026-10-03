// server/db/rls.js — the two-policy Row-Level Security pattern for core tables.
//
// One source of truth for both migrations/005_core-rls-two-policy.js and the
// postgresql.js boot bootstrap, so the two can never drift.
//
// Pattern (same as intent_nonces in server/protocols/nonceStore.ts and the
// plugin's pooled tables):
//
//   workspace_isolation — USING (<tenant col> = current_user)
//     Dedicated pods: the pod connects as its own role rt_<ws> (deploy-gke.sh
//     mounts rt-<ws>-db), and the workspace row id / workspace_id column IS
//     that role name. No application code involved.
//
//   tenant_context — USING (<tenant col> = NULLIF(current_setting('app.workspace_id', true), ''))
//     Pooled services: ONE NOBYPASSRLS role serves many tenants; every
//     tenant-scoped statement runs inside a transaction that SET LOCALs
//     app.workspace_id (postgresql.js _tenantQuery). No setting → NULL → no
//     rows, which is the fail-closed answer for an unpinned query.
//
//   Permissive policies OR together, so each deployment shape matches on
//   exactly one of them. FORCE ROW LEVEL SECURITY makes the table OWNER
//   subject to the policies too — only a role with BYPASSRLS (the admin
//   `roundtable` role used for migrations and operator access) sees across
//   tenants.
//
// user_api_keys has no tenant column of its own; 005 adds a nullable
// workspace_id whose DEFAULT resolves the tenant the same way the policies
// do, so new rows are scoped without the application naming the tenant.
// Rows that pre-date the column stay NULL and are therefore invisible to
// every non-BYPASSRLS role (fail closed) — the migration best-effort
// backfills them from the owning user's single workspace when there is one.

const TENANT_SETTING = "NULLIF(current_setting('app.workspace_id', true), '')";

/** Core tables and the column that names their tenant. */
const CORE_RLS_TABLES = Object.freeze([
  { table: 'workspaces', column: 'id' },
  { table: 'messages', column: 'workspace_id' },
  { table: 'user_api_keys', column: 'workspace_id' },
  { table: 'workspace_usage', column: 'workspace_id' },
  { table: 'audit_log', column: 'workspace_id' },
]);

/**
 * Idempotent statements that put `table` under the two-policy pattern.
 * Each statement is safe to re-run; CREATE POLICY is guarded by a
 * pg_policies lookup because Postgres has no CREATE POLICY IF NOT EXISTS.
 */
function rlsStatementsFor(table, column) {
  const q = (s) => s.replace(/'/g, "''"); // for EXECUTE '...' nesting
  const isolation = `CREATE POLICY workspace_isolation ON ${table} USING (${column} = current_user) WITH CHECK (${column} = current_user)`;
  const tenant = `CREATE POLICY tenant_context ON ${table} USING (${column} = ${TENANT_SETTING}) WITH CHECK (${column} = ${TENANT_SETTING})`;
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = '${table}' AND policyname = 'workspace_isolation') THEN
        EXECUTE '${q(isolation)}';
      END IF;
    END $$`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = '${table}' AND policyname = 'tenant_context') THEN
        EXECUTE '${q(tenant)}';
      END IF;
    END $$`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
  ];
}

/** The user_api_keys tenant column (additive, nullable, tenant-defaulted). */
const USER_API_KEYS_COLUMN_SQL = [
  `ALTER TABLE user_api_keys ADD COLUMN IF NOT EXISTS workspace_id TEXT DEFAULT COALESCE(${TENANT_SETTING}, current_user)`,
  `CREATE INDEX IF NOT EXISTS idx_user_api_keys_workspace ON user_api_keys(workspace_id, user_id)`,
  // Best-effort backfill: a key whose owner has only ever posted in one
  // workspace belongs to that workspace. Anything ambiguous stays NULL
  // (invisible to tenant roles) rather than guessed.
  `UPDATE user_api_keys k SET workspace_id = s.workspace_id
     FROM (
       SELECT user_id, MIN(workspace_id) AS workspace_id
         FROM messages WHERE user_id IS NOT NULL
        GROUP BY user_id HAVING COUNT(DISTINCT workspace_id) = 1
     ) s
    WHERE k.workspace_id IS NULL AND k.user_id = s.user_id`,
];

/** Every statement, in order: column first, then policies per table. */
function coreRlsStatements() {
  const out = [...USER_API_KEYS_COLUMN_SQL];
  for (const { table, column } of CORE_RLS_TABLES) out.push(...rlsStatementsFor(table, column));
  return out;
}

/** Reverse (migration down): drop policies, disable RLS; the column stays. */
function coreRlsDownStatements() {
  const out = [];
  for (const { table } of CORE_RLS_TABLES) {
    out.push(
      `DROP POLICY IF EXISTS tenant_context ON ${table}`,
      `DROP POLICY IF EXISTS workspace_isolation ON ${table}`,
      `ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`,
      `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`,
    );
  }
  return out;
}

/**
 * Apply the pattern through a pg Pool/Client. Non-owner roles (a workspace
 * pod connecting as rt_<ws>) cannot ALTER the tables; that is expected —
 * the admin migration already did it — so insufficient_privilege (42501)
 * and must-be-owner errors are logged once and skipped, never fatal.
 */
async function applyCoreRls(queryable, log = console) {
  let skipped = 0;
  for (const sql of coreRlsStatements()) {
    try {
      await queryable.query(sql);
    } catch (err) {
      if (err && (err.code === '42501' || /must be owner/i.test(err.message || ''))) {
        skipped++;
        continue;
      }
      throw err;
    }
  }
  if (skipped > 0) {
    log.log(`[DB] RLS bootstrap: ${skipped} statement(s) skipped — not the table owner (schema is managed by migrations)`);
  }
  return { skipped };
}

module.exports = {
  CORE_RLS_TABLES,
  TENANT_SETTING,
  rlsStatementsFor,
  coreRlsStatements,
  coreRlsDownStatements,
  applyCoreRls,
};
