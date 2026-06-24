// src/domains/goals.ts — Domain-scoped goal management
// Provides CRUD + evaluation capabilities for financial goals.
// Every domain type registers these capabilities.
import { withPool } from '../db/pool.js';
import { evaluateGoalProgress } from './goalEvaluators.js';
// ─── Goal ID Generation ────────────────────────────────────────────────────
function generateGoalId() {
    return `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
// ─── Capability Handlers ────────────────────────────────────────────────────
function createGoalCreateHandler(config) {
    return async (input, _ctx) => {
        const { goal_type, name, description, target_amount, target_date, monthly_contribution, parameters } = input;
        const id = generateGoalId();
        return withPool(config.databaseUrl, async (pool) => {
            await pool.query(`INSERT INTO domain_goals
           (id, goal_type, name, description, target_amount, target_date, monthly_contribution, parameters, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')`, [
                id,
                goal_type,
                name,
                description || null,
                target_amount ?? null,
                target_date || null,
                monthly_contribution ?? null,
                JSON.stringify(parameters || {}),
            ]);
            // Immediately evaluate progress for the new goal
            const progress = await evaluateGoalProgress(pool, id, config.domainType);
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
function createGoalListHandler(config) {
    return async (_input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            const { rows } = await pool.query(`SELECT g.*,
                s.current_value AS latest_value,
                s.progress_pct AS latest_progress,
                s.on_track AS latest_on_track,
                s.projected_date AS latest_projected_date,
                s.snapshot_at AS latest_snapshot_at
         FROM domain_goals g
         LEFT JOIN LATERAL (
           SELECT * FROM goal_snapshots
           WHERE goal_id = g.id
           ORDER BY snapshot_at DESC
           LIMIT 1
         ) s ON true
         WHERE g.status = 'active'
         ORDER BY g.created_at DESC`);
            return {
                goals: rows,
                domain: config.domainType,
                count: rows.length,
                provenance: { source: 'domain_goals', domain: config.domainType },
            };
        });
    };
}
function createGoalGetHandler(config) {
    return async (input, _ctx) => {
        const { goal_id } = input;
        return withPool(config.databaseUrl, async (pool) => {
            const goalResult = await pool.query(`SELECT * FROM domain_goals WHERE id = $1`, [goal_id]);
            if (goalResult.rows.length === 0) {
                return { error: 'Goal not found', goal_id };
            }
            const goal = goalResult.rows[0];
            const progress = await evaluateGoalProgress(pool, goal_id, config.domainType);
            // Get last 10 snapshots for trend
            const snapshotResult = await pool.query(`SELECT * FROM goal_snapshots WHERE goal_id = $1 ORDER BY snapshot_at DESC LIMIT 10`, [goal_id]);
            return {
                ...goal,
                progress,
                snapshots: snapshotResult.rows,
                provenance: { source: 'domain_goals', domain: config.domainType },
            };
        });
    };
}
function createGoalUpdateHandler(config) {
    return async (input, _ctx) => {
        const { goal_id, ...updates } = input;
        const allowedFields = ['name', 'description', 'target_amount', 'target_date', 'monthly_contribution', 'parameters', 'status'];
        const setClauses = ['updated_at = NOW()'];
        const values = [];
        let paramIdx = 1;
        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                if (field === 'parameters') {
                    setClauses.push(`${field} = $${paramIdx}`);
                    values.push(JSON.stringify(updates[field]));
                }
                else {
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
        return withPool(config.databaseUrl, async (pool) => {
            const result = await pool.query(`UPDATE domain_goals SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`, values);
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
function createGoalDeleteHandler(config) {
    return async (input, _ctx) => {
        const { goal_id } = input;
        return withPool(config.databaseUrl, async (pool) => {
            const result = await pool.query(`DELETE FROM domain_goals WHERE id = $1 RETURNING id, name`, [goal_id]);
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
function createGoalEvaluateHandler(config) {
    return async (input, _ctx) => {
        const { goal_id } = input;
        return withPool(config.databaseUrl, async (pool) => {
            const progress = await evaluateGoalProgress(pool, goal_id, config.domainType);
            // Record snapshot
            if (progress && !progress.error) {
                await pool.query(`INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details)
           VALUES ($1, $2, $3, $4, $5, $6)`, [
                    goal_id,
                    progress.current_value,
                    progress.progress_pct,
                    progress.on_track,
                    progress.projected_date || null,
                    JSON.stringify(progress.details || {}),
                ]);
            }
            return {
                ...progress,
                provenance: { source: 'domain_goals', domain: config.domainType },
            };
        });
    };
}
function createGoalSnapshotHandler(config) {
    return async (_input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            // Evaluate and snapshot ALL active goals
            const { rows: goals } = await pool.query(`SELECT id FROM domain_goals WHERE status = 'active'`);
            const results = [];
            for (const goal of goals) {
                const progress = await evaluateGoalProgress(pool, goal.id, config.domainType);
                if (progress && !progress.error) {
                    await pool.query(`INSERT INTO goal_snapshots (goal_id, current_value, progress_pct, on_track, projected_date, details)
             VALUES ($1, $2, $3, $4, $5, $6)`, [
                        goal.id,
                        progress.current_value,
                        progress.progress_pct,
                        progress.on_track,
                        progress.projected_date || null,
                        JSON.stringify(progress.details || {}),
                    ]);
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
export function registerGoalCapabilities(registry, config) {
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
//# sourceMappingURL=goals.js.map