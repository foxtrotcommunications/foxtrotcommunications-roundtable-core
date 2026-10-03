/* eslint-disable camelcase */
// migrations/005_core-rls-two-policy.js — Row-Level Security on core tables
//
// Upgrade plan 3.4. Puts workspaces, messages, user_api_keys,
// workspace_usage and audit_log under the two-policy pattern
// (workspace_isolation on current_user + tenant_context on
// app.workspace_id, FORCE ROW LEVEL SECURITY) and adds the nullable,
// tenant-defaulted user_api_keys.workspace_id column. The statements live in
// server/db/rls.js so the boot bootstrap applies the identical pattern.
//
// Run as the admin role (owner, BYPASSRLS). Idempotent: every statement is
// guarded, so re-running against an already-migrated database is a no-op.
// Down drops the policies and disables RLS; the column is kept (additive).

const { coreRlsStatements, coreRlsDownStatements } = require('../server/db/rls');

exports.shorthands = undefined;

exports.up = (pgm) => {
  for (const sql of coreRlsStatements()) pgm.sql(sql);
};

exports.down = (pgm) => {
  for (const sql of coreRlsDownStatements()) pgm.sql(sql);
};
