-- 05-roles-rls.sql — Per-workspace DB roles and admin setup
-- Run as superuser/owner (roundtable) after schema creation.

-- Admin role: full visibility across all workspaces
ALTER ROLE roundtable BYPASSRLS;

-- Per-workspace roles (DML only, RLS enforced)
DO $$ 
DECLARE
  roles TEXT[] := ARRAY['rt_checking','rt_debt','rt_realestate','rt_investments','rt_retirement','rt_taxes','rt_demographics'];
  r TEXT;
BEGIN
  FOREACH r IN ARRAY roles LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', r, 'demo_' || r);
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', r);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', r);
  END LOOP;
END $$;

-- Ensure future tables also get grants
DO $$ 
DECLARE
  roles TEXT[] := ARRAY['rt_checking','rt_debt','rt_realestate','rt_investments','rt_retirement','rt_taxes','rt_demographics'];
  r TEXT;
BEGIN
  FOREACH r IN ARRAY roles LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', r);
  END LOOP;
END $$;
