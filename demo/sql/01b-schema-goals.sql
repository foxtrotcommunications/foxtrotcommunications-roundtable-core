-- =============================================================================
-- Goals Schema (domain_goals + goal_snapshots)
-- These tables are normally created by the app at runtime (schemas.ts).
-- This file creates them for the demo's shared database with RLS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS domain_goals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  goal_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  target_amount REAL,
  target_date TEXT,
  monthly_contribution REAL,
  parameters JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domain_goals_ws ON domain_goals(workspace_id);
ALTER TABLE domain_goals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON domain_goals;
CREATE POLICY workspace_isolation ON domain_goals
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE domain_goals FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS goal_snapshots (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  goal_id TEXT REFERENCES domain_goals(id) ON DELETE CASCADE,
  current_value REAL,
  progress_pct REAL,
  on_track BOOLEAN,
  projected_date TEXT,
  details JSONB DEFAULT '{}',
  snapshot_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goal_snapshots_ws ON goal_snapshots(workspace_id);
ALTER TABLE goal_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON goal_snapshots;
CREATE POLICY workspace_isolation ON goal_snapshots
  USING (workspace_id = current_user)
  WITH CHECK (workspace_id = current_user);
ALTER TABLE goal_snapshots FORCE ROW LEVEL SECURITY;
