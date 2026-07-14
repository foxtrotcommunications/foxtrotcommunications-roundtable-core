// tests/protocols/intentCompiler.test.ts — SQL Fusion Compiler Tests
// Covers fusion candidacy rules (ORDER BY / explicit LIMIT exclusion),
// position preservation for aggregate reduce semantics, deduplication,
// and LIMIT injection.

import type { IntentOperation, QueryIntent, ToolCallIntent } from '../../server/protocols/intentToken';
import { compileIntents } from '../../server/protocols/intentCompiler';

// ─── Helpers ────────────────────────────────────────────────────────────────

function query(sql: string, tool = 'query_bigquery'): QueryIntent {
  return { op: 'query', tool, params: { sql }, responseFormat: 'json_table' };
}

function toolCall(tool = 'read_file', args: Record<string, unknown> = { path: '/tmp/x' }): ToolCallIntent {
  return { op: 'tool_call', tool, args };
}

function sqlOf(op: IntentOperation): string {
  return (op as QueryIntent).params.sql || '';
}

// ─── SQL Fusion ─────────────────────────────────────────────────────────────

describe('compileIntents — SQL fusion', () => {
  test('fuses two compatible queries against the same table and WHERE clause', () => {
    const result = compileIntents([
      query("SELECT amount FROM txns WHERE user='x'"),
      query("SELECT category FROM txns WHERE user='x'"),
    ]);

    expect(result.fusionCount).toBe(1);
    expect(result.optimized).toHaveLength(1);
    const fused = sqlOf(result.optimized[0]);
    expect(fused).toMatch(/SELECT amount, category FROM txns/i);
    expect(fused).toMatch(/WHERE user='x'/);
  });

  test('does not fuse a query with ORDER BY (top-N semantics preserved)', () => {
    const topN = "SELECT amount FROM txns WHERE user='x' ORDER BY date DESC LIMIT 5";
    const result = compileIntents([
      query(topN),
      query("SELECT category FROM txns WHERE user='x'"),
    ]);

    expect(result.fusionCount).toBe(0);
    expect(result.optimized).toHaveLength(2);
    // The top-N query keeps its ORDER BY and LIMIT verbatim
    expect(sqlOf(result.optimized[0])).toBe(topN);
  });

  test('does not fuse a query with an explicit LIMIT', () => {
    const limited = "SELECT amount FROM txns WHERE user='x' LIMIT 5";
    const result = compileIntents([
      query(limited),
      query("SELECT category FROM txns WHERE user='x'"),
    ]);

    expect(result.fusionCount).toBe(0);
    expect(sqlOf(result.optimized[0])).toBe(limited);
  });

  test('does not fuse queries with different WHERE clauses', () => {
    const result = compileIntents([
      query("SELECT amount FROM txns WHERE user='x'"),
      query("SELECT amount FROM txns WHERE user='y'"),
    ]);

    expect(result.fusionCount).toBe(0);
    expect(result.optimized).toHaveLength(2);
  });

  test('does not fuse queries against different tables or tools', () => {
    const result = compileIntents([
      query('SELECT a FROM t1'),
      query('SELECT b FROM t2'),
      query('SELECT c FROM t1', 'query_snowflake'),
    ]);

    expect(result.fusionCount).toBe(0);
    expect(result.optimized).toHaveLength(3);
  });

  test('places the fused query at the first group member position (concat ordering)', () => {
    const other = toolCall();
    const result = compileIntents([
      query('SELECT a FROM t'),
      other,
      query('SELECT b FROM t'),
    ]);

    expect(result.fusionCount).toBe(1);
    expect(result.optimized).toHaveLength(2);
    // Fused query replaces the group's first member (index 0); tool_call stays after it
    expect(result.optimized[0].op).toBe('query');
    expect(sqlOf(result.optimized[0])).toMatch(/SELECT a, b FROM t/i);
    expect(result.optimized[1]).toBe(other);
  });

  test('reduce:"last" still resolves to the final original step after fusion', () => {
    const result = compileIntents([
      query('SELECT a FROM t'),
      query('SELECT b FROM t'),
      query('SELECT z FROM other_table'),
    ]);

    expect(result.fusionCount).toBe(1);
    // The unfused query stays last (LIMIT injection may still amend its SQL)
    expect(sqlOf(result.optimized[result.optimized.length - 1])).toMatch(/^SELECT z FROM other_table/);
  });
});

// ─── Deduplication ──────────────────────────────────────────────────────────

describe('compileIntents — deduplication', () => {
  test('removes exact duplicate intents', () => {
    const result = compileIntents([
      toolCall('read_file', { path: '/a' }),
      toolCall('read_file', { path: '/a' }),
      toolCall('read_file', { path: '/b' }),
    ]);

    expect(result.deduplicationCount).toBe(1);
    expect(result.optimized).toHaveLength(2);
  });
});

// ─── LIMIT Injection ────────────────────────────────────────────────────────

describe('compileIntents — LIMIT injection', () => {
  test('injects a safety LIMIT into a bare SELECT', () => {
    const result = compileIntents([query('SELECT a FROM t')]);

    expect(result.limitInjections).toBe(1);
    expect(sqlOf(result.optimized[0])).toMatch(/LIMIT 1000$/);
  });

  test('leaves an existing LIMIT untouched', () => {
    const result = compileIntents([query('SELECT a FROM t LIMIT 7')]);

    expect(result.limitInjections).toBe(0);
    expect(sqlOf(result.optimized[0])).toBe('SELECT a FROM t LIMIT 7');
  });

  test('empty input compiles to empty output', () => {
    const result = compileIntents([]);
    expect(result.optimized).toEqual([]);
    expect(result.wasOptimized).toBe(false);
  });
});
