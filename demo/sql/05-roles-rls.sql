-- 05-roles-rls.sql — Per-workspace DB roles and admin setup
-- Run as superuser/owner (roundtable) after schema creation.

-- Admin role: full visibility across all workspaces
ALTER ROLE roundtable BYPASSRLS;
