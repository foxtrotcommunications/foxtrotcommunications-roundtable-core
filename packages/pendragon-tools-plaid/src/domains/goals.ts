// src/domains/goals.ts — Domain-scoped goal management
// Provides CRUD + evaluation capabilities for financial goals.
// Every domain type registers these capabilities.

import { withPool } from '../db/pool.js';
import type {
  PlaidPluginConfig,
  CapabilityRegistry,
  CapabilityHandler,
} from '../types.js';
import { evaluateGoalProgress } from './goalEvaluators.js';

// ─── Goal ID Generation ────────────────────────────────────────────────────

function generateGoalId(): string {
  return `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Capability Handlers ────────────────────────────────────────────────────

function createGoalCreateHandler(config: PlaidPluginConfig): CapabilityHandler {
  return async (input, _ctx) => {
    const { goal_type, name, description, target_amount, target_date, monthly_contribution, parameters } = input as any;
    const id = generateGoalId();

    return withPool(config.databaseUrl, async (pool) => {
      await pool.query(
        `INSERT INTO domain_goals
           (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)`,
        [
          id,
          goal_type,
          name,
          description || null,
          target_amount ?? null,
          target_date || null,
          monthly_contribution ?? null,
          JSON.stringify(parameters || {}),
          config.workspaceId,
        ],
      );

      // Immediately evaluate progress for the new goal
      const progress = await evaluateGoalProgress(pool, id, config.domainType, config.workspaceId);

      return {
        id,
        goal_type,
        name,
        status: 'active',
        progress,
        provenance: { source: 'domain_goals', domain: config.domainType },
      };
    });
  };
}

function createGoalListHandler(config: PlaidPluginConfig): CapabilityHandler {
  return async (_input, _ctx) => {
    return withPool(config.databaseUrl, async (pool) => {
      // Fetch all active goals with their latest snapshot (if any).
      // Snapshots contain per-goal values from the last evaluation,
      // which are more accurate than domain-level aggregate queries
      // when multiple goals share a domain (e.g., 3 college funds
      // all sharing the retirement workspace's plaid_holdings).
      const { rows } = await pool.query(
        `SELECT g.*,
                s.current_value AS snap_current_value,
                s.progress_pct  AS snap_progress_pct,
                s.on_track      AS snap_on_track,
                s.projected_date AS snap_projected_date,
                s.details       AS snap_details,
                s.snapshot_at   AS snap_at
         FROM domain_goals g
         LEFT JOIN LATERAL (
           SELECT * FROM goal_snapshots
           WHERE goal_id = g.id
           ORDER BY snapshot_at DESC
           LIMIT 1
         ) s ON true
         WHERE g.workspace_id = $1 AND g.status = 'active'
         ORDER BY g.created_at DESC`,
        [config.workspaceId],
      );

      const goals = await Promise.all(
        rows.map(async (row: any) => {
          // If a snapshot exists, use its per-goal values
          if (row.snap_at != null) {
            const targetAmount = row.target_amount ?? 0;
            const currentValue = parseFloat(row.snap_current_value) || 0;
            const progressPct = parseFloat(row.snap_progress_pct) || 0;

            return {
              goal_id: row.id,
              goal_name: row.name,
              goal_type: row.goal_type,
              target_amount: targetAmount,
              target_date: row.target_date,
              current_value: currentValue,
              progress_pct: Math.round(progressPct * 10) / 10,
              on_track: row.snap_on_track ?? false,
              projected_date: row.snap_projected_date || null,
              monthly_required: null,
              monthly_current: row.monthly_contribution ? Math.round(row.monthly_contribution) : null,
              gap: null,
              recommendation: progressPct >= 100
                ? 'Goal achieved! 🎉'
                : `${progressPct.toFixed(1)}% toward $${targetAmount.toLocaleString()} target.`,
              details: { ...(row.snap_details || {}), source: 'goal_snapshot' },
              resource_request: null,
            };
          }

          // No snapshot — fall back to live domain-level evaluation.
          // Note: this uses aggregate queries, so values may be inflated
          // when multiple goals share a domain.
          return evaluateGoalProgress(pool, row.id, config.domainType, config.workspaceId);
        }),
      );

      return {
        goals,
        domain: config.domainType,
        count: goals.length,
        provenance: { source: 'domain_goals', domain: config.domainType },
      };
    });
  };
}

function createGoalGetHandler(config: PlaidPluginConfig): CapabilityHandler {
  return async (input, _ctx) => {
    const { goal_id } = input as any;

    return withPool(config.databaseUrl, async (pool) => {
      const goalResult = await pool.query(
        `SELECT * FROM domain_goals WHERE id = $1 AND workspace_id = $2`,
        [goal_id, config.workspaceId],
      );
      if (goalResult.rows.length === 0) {
        return { error: 'Goal not found', goal_id };
      }

      const goal = goalResult.rows[0];
      const progress = await evaluateGoalProgress(pool, goal_id, config.domainType, config.workspaceId);

      // Get last 10 snapshots for trend
      const snapshotResult = await pool.query(
        `SELECT * FROM goal_snapshots WHERE goal_id = $1 AND workspace_id = $2 ORDER BY snapshot_at DESC LIMIT 10`,
        [goal_id, config.workspaceId],
      );

      return {
        ...goal,
        progress,
        snapshots: snapshotResult.rows,
        provenance: { source: 'domain_goals', domain: config.domainType },
      };
    });
  };
}

function createGoalUpdateHandler(config: PlaidPluginConfig): CapabilityHandler {
  return async (input, _ctx) => {
    const { goal_id, ...updates } = input as any;
    const allowedFields = ['name', 'description', 'target_amount', 'target_date', 'monthly_contribution', 'parameters', 'status'];
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let paramIdx = 1;

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        if (field === 'parameters') {
          setClauses.push(`${field} = $${paramIdx}`);
          values.push(JSON.stringify(updates[field]));
        } else {
          setClauses.push(`${field} = $${paramIdx}`);
          values.push(updates[field]);
        }
        paramIdx++;
      }
    }

    if (values.length === 0) {
      return { error: 'No valid fields to update' };
    }

    values.push(goal_id);
    paramIdx++;
    values.push(config.workspaceId);

    return withPool(config.databaseUrl, async (pool) => {
      const result = await pool.query(
        `UPDATE domain_goals SET ${setClauses.join(', ')} WHERE id = $${paramIdx - 1} AND workspace_id = $${paramIdx} RETURNING *`,
        values,
      );
      if (result.rows.length === 0) {
        return { error: 'Goal not found', goal_id };
      }
      return {
        goal: result.rows[0],
        provenance: { source: 'domain_goals', domain: config.domainType },
      };
    });
  };
}

function createGoalDeleteHandler(config: PlaidPluginConfig): CapabilityHandler {
  return async (input, _ctx) => {
    const { goal_id } = input as any;

    return withPool(config.databaseUrl, async (pool) => {
      const result = await pool.query(
        `DELETE FROM domain_goals WHERE id = $1 AND workspace_id = $2 RETURNING id, name`,
        [goal_id, config.workspaceId],
      );
      if (result.rows.length === 0) {
        return { error: 'Goal not found', goal_id };
      }
      return {
        deleted: true,
        goal: result.rows[0],
        provenance: { source: 'domain_goals', domain: config.domainType },
      };
    });
  };
}

function createGoalEvaluateHandler(config: PlaidPluginConfig): CapabilityHandler {
  return async (input, _ctx) => {
    const { goal_id } = input as any;

    return withPool(config.databaseUrl, async (pool) => {
      const progress = await evaluateGoalProgress(pool, goal_id, config.domainType, config.workspaceId);

      // Record snapshot
      if (progress && !progress.error) {
        await pool.query(
          `INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details, workspace_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            goal_id,
            progress.current_value,
            progress.progress_pct,
            progress.on_track,
            progress.projected_date || null,
            JSON.stringify(progress.details || {}),
            config.workspaceId,
          ],
        );
      }

      return {
        ...progress,
        provenance: { source: 'domain_goals', domain: config.domainType },
      };
    });
  };
}

function createGoalSnapshotHandler(config: PlaidPluginConfig): CapabilityHandler {
  return async (_input, _ctx) => {
    return withPool(config.databaseUrl, async (pool) => {
      // Evaluate and snapshot ALL active goals
      const { rows: goals } = await pool.query(
        `SELECT id FROM domain_goals WHERE status = 'active' AND workspace_id = $1`,
        [config.workspaceId],
      );

      const results = [];
      for (const goal of goals) {
        const progress = await evaluateGoalProgress(pool, goal.id, config.domainType, config.workspaceId);
        if (progress && !progress.error) {
          await pool.query(
            `INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details, workspace_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              goal.id,
              progress.current_value,
              progress.progress_pct,
              progress.on_track,
              progress.projected_date || null,
              JSON.stringify(progress.details || {}),
              config.workspaceId,
            ],
          );
          results.push({ ...progress, goal_id: goal.id });
        }
      }

      return {
        snapshots_recorded: results.length,
        results,
        domain: config.domainType,
        provenance: { source: 'domain_goals', domain: config.domainType },
      };
    });
  };
}

// ─── Capability Registration ────────────────────────────────────────────────

export function registerGoalCapabilities(registry: CapabilityRegistry, config: PlaidPluginConfig): void {
  registry.register({
    name: 'goals.create',
    description: 'Create a new financial goal for this domain',
    inputSchema: {
      type: 'object',
      properties: {
        goal_type: { type: 'string', description: 'Type of goal (domain-specific)' },
        name: { type: 'string', description: 'Human-readable goal name' },
        description: { type: 'string', description: 'Optional detailed description' },
        target_amount: { type: 'number', description: 'Target dollar amount' },
        target_date: { type: 'string', description: 'Target completion date (YYYY-MM-DD)' },
        monthly_contribution: { type: 'number', description: 'Expected monthly contribution toward goal' },
        parameters: { type: 'object', description: 'Additional domain-specific parameters' },
      },
      required: ['goal_type', 'name'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        goal_type: { type: 'string' },
        name: { type: 'string' },
        status: { type: 'string' },
        progress: { type: 'object' },
      },
    },
    handler: createGoalCreateHandler(config),
  });

  registry.register({
    name: 'goals.list',
    description: 'List all active goals for this domain with latest progress snapshots',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        goals: { type: 'array' },
        domain: { type: 'string' },
        count: { type: 'number' },
      },
    },
    handler: createGoalListHandler(config),
  });

  registry.register({
    name: 'goals.get',
    description: 'Get a specific goal with full progress evaluation and snapshot history',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'The goal ID to retrieve' },
      },
      required: ['goal_id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        progress: { type: 'object' },
        snapshots: { type: 'array' },
      },
    },
    handler: createGoalGetHandler(config),
  });

  registry.register({
    name: 'goals.update',
    description: 'Update an existing goal (name, target, status, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'The goal ID to update' },
        name: { type: 'string' },
        description: { type: 'string' },
        target_amount: { type: 'number' },
        target_date: { type: 'string' },
        monthly_contribution: { type: 'number' },
        parameters: { type: 'object' },
        status: { type: 'string', enum: ['active', 'achieved', 'paused', 'abandoned'] },
      },
      required: ['goal_id'],
    },
    outputSchema: {
      type: 'object',
      properties: { goal: { type: 'object' } },
    },
    handler: createGoalUpdateHandler(config),
  });

  registry.register({
    name: 'goals.delete',
    description: 'Delete a goal and all its snapshots',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'The goal ID to delete' },
      },
      required: ['goal_id'],
    },
    outputSchema: {
      type: 'object',
      properties: { deleted: { type: 'boolean' } },
    },
    handler: createGoalDeleteHandler(config),
  });

  registry.register({
    name: 'goals.evaluateProgress',
    description: 'Evaluate current progress toward a goal using live domain data. Records a snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'The goal ID to evaluate' },
      },
      required: ['goal_id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string' },
        current_value: { type: 'number' },
        progress_pct: { type: 'number' },
        on_track: { type: 'boolean' },
        projected_date: { type: 'string' },
        monthly_required: { type: 'number' },
        monthly_current: { type: 'number' },
        gap: { type: 'number' },
        recommendation: { type: 'string' },
      },
    },
    handler: createGoalEvaluateHandler(config),
  });

  registry.register({
    name: 'goals.snapshot',
    description: 'Record a point-in-time progress snapshot for ALL active goals. Designed for daily batch updates.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        snapshots_recorded: { type: 'number' },
        results: { type: 'array' },
      },
    },
    handler: createGoalSnapshotHandler(config),
  });
}
