// server/protocols/intentCompiler.ts — SQL Fusion & Intent Optimization
// Compiler pass that optimizes batches of intent operations before execution.
// Like a database query planner, but for cross-workspace AI tool calls.
//
// Optimizations:
//   1. SQL Fusion — merges multiple queries against the same tool into one
//   2. Deduplication — eliminates identical intents in a batch
//   3. LIMIT injection — adds safety LIMIT to queries without one

import type { IntentOperation, QueryIntent, ToolCallIntent } from './intentToken';
import { canonicalize } from './intentTokenCodec';
import crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CompilationResult {
  /** Optimized operations (may be fewer than input) */
  optimized: IntentOperation[];
  /** Number of input operations */
  originalCount: number;
  /** Number of output operations */
  optimizedCount: number;
  /** Number of SQL queries fused */
  fusionCount: number;
  /** Number of duplicate operations eliminated */
  deduplicationCount: number;
  /** Number of LIMIT clauses injected */
  limitInjections: number;
  /** Whether any optimization was applied */
  wasOptimized: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default LIMIT to inject when none is specified */
const DEFAULT_LIMIT = 1000;

/** Maximum number of queries we'll attempt to fuse in one pass */
const MAX_FUSION_BATCH = 10;

// ─── SQL Parsing Helpers ────────────────────────────────────────────────────

/** Extract the SELECT columns from a SQL string (simple parser) */
function extractSelectColumns(sql: string): string[] | null {
  const match = sql.match(/^\s*(?:WITH\s+[\s\S]*?\)\s+)?SELECT\s+([\s\S]*?)\s+FROM\s+/i);
  if (!match) return null;
  // Split by comma, handling nested functions like SUM(x)
  const cols: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of match[1]) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      cols.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) cols.push(current.trim());
  return cols;
}

/** Extract the FROM clause (table reference) from a SQL string */
function extractFromClause(sql: string): string | null {
  const match = sql.match(/\bFROM\s+([\w`.]+(?:\s+(?:AS\s+)?\w+)?)/i);
  return match ? match[1].trim() : null;
}

/** Extract the WHERE clause from a SQL string */
function extractWhereClause(sql: string): string | null {
  const match = sql.match(/\bWHERE\s+([\s\S]*?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bHAVING\b|$)/i);
  return match ? match[1].trim() : null;
}

/** Extract the GROUP BY clause from a SQL string */
function extractGroupByClause(sql: string): string | null {
  const match = sql.match(/\bGROUP\s+BY\s+([\s\S]*?)(?:\bORDER\s+BY\b|\bLIMIT\b|\bHAVING\b|$)/i);
  return match ? match[1].trim() : null;
}

/** Extract the ORDER BY clause from a SQL string */
function extractOrderByClause(sql: string): string | null {
  const match = sql.match(/\bORDER\s+BY\s+([\s\S]*?)(?:\bLIMIT\b|$)/i);
  return match ? match[1].trim() : null;
}

/** Check if a SQL query has a LIMIT clause */
function hasLimit(sql: string): boolean {
  return /\bLIMIT\s+\d+/i.test(sql);
}

/** Check if a SQL query uses CTEs (WITH clause) — these are harder to fuse */
function hasCTE(sql: string): boolean {
  return /^\s*WITH\b/i.test(sql);
}

/** Check if a SQL string contains aggregation functions */
function hasAggregation(sql: string): boolean {
  return /\b(COUNT|SUM|AVG|MIN|MAX|ARRAY_AGG|STRING_AGG)\s*\(/i.test(sql);
}

// ─── Deduplication ──────────────────────────────────────────────────────────

/**
 * Remove duplicate intents from a batch.
 * Uses canonical JSON hash for exact-match dedup.
 */
function deduplicateIntents(
  ops: IntentOperation[],
): { deduped: IntentOperation[]; removed: number } {
  const seen = new Set<string>();
  const deduped: IntentOperation[] = [];

  for (const op of ops) {
    const hash = crypto
      .createHash('sha256')
      .update(canonicalize(op as unknown as Record<string, unknown>))
      .digest('hex');

    if (!seen.has(hash)) {
      seen.add(hash);
      deduped.push(op);
    }
  }

  return { deduped, removed: ops.length - deduped.length };
}

// ─── LIMIT Injection ────────────────────────────────────────────────────────

/**
 * Inject a LIMIT clause into SQL queries that don't have one.
 * Only applies to raw SQL queries (params.sql), not structured queries.
 */
function injectLimits(ops: IntentOperation[]): { result: IntentOperation[]; injected: number } {
  let injected = 0;

  const result = ops.map((op) => {
    if (op.op !== 'query') return op;
    const query = op as QueryIntent;
    if (!query.params.sql) return op;
    if (hasLimit(query.params.sql)) return op;
    // Don't inject LIMIT on aggregate queries (they need all rows)
    if (hasAggregation(query.params.sql) && !extractSelectColumns(query.params.sql)?.some(c => !(/\b(COUNT|SUM|AVG|MIN|MAX)\b/i.test(c)))) {
      return op;
    }

    injected++;
    return {
      ...query,
      params: {
        ...query.params,
        sql: `${query.params.sql.replace(/;\s*$/, '')} LIMIT ${DEFAULT_LIMIT}`,
      },
    } as QueryIntent;
  });

  return { result, injected };
}

// ─── SQL Fusion ─────────────────────────────────────────────────────────────

interface FusionCandidate {
  index: number;
  intent: QueryIntent;
  table: string;
  columns: string[];
  where: string | null;
  groupBy: string | null;
}

/**
 * Attempt to fuse multiple SELECT queries against the same table into one.
 *
 * Fusion rules:
 * - Same tool (e.g. query_bigquery)
 * - Same FROM table
 * - No CTEs in either query
 * - Same WHERE clause (or both null)
 * - Compatible GROUP BY (same or both null)
 * - No ORDER BY and no explicit LIMIT in any query (enforced at candidate
 *   collection — fusion rebuilds the SQL without them, which would silently
 *   break top-N semantics)
 *
 * Result: merged SELECT list, preserving WHERE/GROUP BY, with the default
 * safety LIMIT.
 */
function fuseQueries(candidates: FusionCandidate[]): QueryIntent | null {
  if (candidates.length < 2) return null;

  const first = candidates[0];
  const tool = first.intent.tool;
  const responseFormat = first.intent.responseFormat;

  // All must share the same WHERE clause
  const where = first.where;
  if (!candidates.every(c => c.where === where)) return null;

  // All must share the same GROUP BY clause (or all null)
  const groupBy = first.groupBy;
  if (!candidates.every(c => c.groupBy === groupBy)) return null;

  // Merge SELECT columns (deduplicate)
  const allColumns = new Set<string>();
  for (const c of candidates) {
    for (const col of c.columns) {
      allColumns.add(col);
    }
  }

  // Reconstruct fused SQL
  let fusedSql = `SELECT ${[...allColumns].join(', ')} FROM ${first.table}`;
  if (where) fusedSql += ` WHERE ${where}`;
  if (groupBy) fusedSql += ` GROUP BY ${groupBy}`;
  fusedSql += ` LIMIT ${DEFAULT_LIMIT}`;

  return {
    op: 'query',
    tool,
    params: { sql: fusedSql },
    responseFormat,
  };
}

/**
 * SQL fusion pass — find groups of fusible queries and merge them.
 */
function applySqlFusion(
  ops: IntentOperation[],
): { result: IntentOperation[]; fusionCount: number } {
  // Collect query intents with raw SQL
  const candidates: FusionCandidate[] = [];
  const nonQueryOps: { index: number; op: IntentOperation }[] = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === 'query' && (op as QueryIntent).params.sql) {
      const query = op as QueryIntent;
      const sql = query.params.sql!;

      // Skip CTEs — too complex to fuse
      if (hasCTE(sql)) {
        nonQueryOps.push({ index: i, op });
        continue;
      }

      // Skip queries with ORDER BY or an explicit LIMIT — fusion rebuilds the
      // SQL without them, so a top-N query would lose its ordering and row
      // bound and return arbitrary rows.
      if (extractOrderByClause(sql) || hasLimit(sql)) {
        nonQueryOps.push({ index: i, op });
        continue;
      }

      const table = extractFromClause(sql);
      const columns = extractSelectColumns(sql);

      if (table && columns) {
        candidates.push({
          index: i,
          intent: query,
          table,
          columns,
          where: extractWhereClause(sql),
          groupBy: extractGroupByClause(sql),
        });
      } else {
        nonQueryOps.push({ index: i, op });
      }
    } else {
      nonQueryOps.push({ index: i, op });
    }
  }

  if (candidates.length < 2) {
    return { result: ops, fusionCount: 0 };
  }

  // Group candidates by (tool, table) — only fuse within same tool+table
  const groups = new Map<string, FusionCandidate[]>();
  for (const c of candidates) {
    const key = `${c.intent.tool}:${c.table.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    const group = groups.get(key)!;
    if (group.length < MAX_FUSION_BATCH) {
      group.push(c);
    }
  }

  // Attempt fusion for each group
  let fusionCount = 0;
  const fusedIndices = new Set<number>();
  const fusedAt = new Map<number, IntentOperation>(); // group's first index → fused op

  for (const [, group] of groups) {
    if (group.length < 2) continue;

    const fused = fuseQueries(group);
    if (fused) {
      fusionCount += group.length - 1; // N queries → 1 = (N-1) fusions
      fusedAt.set(Math.min(...group.map(c => c.index)), fused);
      for (const c of group) {
        fusedIndices.add(c.index);
      }
    }
  }

  if (fusionCount === 0) {
    return { result: ops, fusionCount: 0 };
  }

  // Rebuild the operation list in original order, substituting each fused
  // group at the position of its first member. Position matters: aggregate
  // reduce strategies ('concat', 'last') are sensitive to step order.
  const result: IntentOperation[] = [];
  for (let i = 0; i < ops.length; i++) {
    const fused = fusedAt.get(i);
    if (fused) {
      result.push(fused);
    } else if (!fusedIndices.has(i)) {
      result.push(ops[i]);
    }
  }

  return { result, fusionCount };
}

// ─── Main Compiler ──────────────────────────────────────────────────────────

/**
 * Compile and optimize a batch of intent operations.
 *
 * Optimization passes (in order):
 *   1. Deduplication — remove identical intents
 *   2. SQL Fusion — merge compatible queries against the same table
 *   3. LIMIT injection — add safety LIMIT to queries without one
 *
 * @param steps - Array of intent operations to optimize
 * @returns CompilationResult with optimized operations and stats
 */
export function compileIntents(steps: IntentOperation[]): CompilationResult {
  if (!steps || steps.length === 0) {
    return {
      optimized: [],
      originalCount: 0,
      optimizedCount: 0,
      fusionCount: 0,
      deduplicationCount: 0,
      limitInjections: 0,
      wasOptimized: false,
    };
  }

  // Single operation — only apply LIMIT injection
  if (steps.length === 1) {
    const { result, injected } = injectLimits(steps);
    return {
      optimized: result,
      originalCount: 1,
      optimizedCount: 1,
      fusionCount: 0,
      deduplicationCount: 0,
      limitInjections: injected,
      wasOptimized: injected > 0,
    };
  }

  // Pass 1: Deduplication
  const { deduped, removed: deduplicationCount } = deduplicateIntents(steps);

  // Pass 2: SQL Fusion
  const { result: fused, fusionCount } = applySqlFusion(deduped);

  // Pass 3: LIMIT Injection
  const { result: final, injected: limitInjections } = injectLimits(fused);

  const wasOptimized = deduplicationCount > 0 || fusionCount > 0 || limitInjections > 0;

  return {
    optimized: final,
    originalCount: steps.length,
    optimizedCount: final.length,
    fusionCount,
    deduplicationCount,
    limitInjections,
    wasOptimized,
  };
}
