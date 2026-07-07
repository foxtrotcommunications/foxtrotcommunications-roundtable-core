-- 05-roles-rls.sql — RLS admin setup
-- Run as superuser/owner (roundtable) after schema creation.
--
-- Scope of THIS file: grant the admin role cross-workspace visibility.
-- It intentionally does NOT create per-workspace roles or RLS policies:
--   • Per-workspace roles are created dynamically from config/workspaces.json
--     by setup.sh (Phase 2c) and seed-db.sh — each role is named after the
--     workspace id so the RLS predicate (workspace_id = current_user) matches.
--   • RLS policies are defined inline in the schema files (01–04) via
--     ENABLE/FORCE ROW LEVEL SECURITY + CREATE POLICY workspace_isolation.

-- Admin role: full visibility across all workspaces (bypasses RLS).
ALTER ROLE roundtable BYPASSRLS;
