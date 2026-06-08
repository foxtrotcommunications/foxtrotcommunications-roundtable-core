// server/protocols/intentMetrics.ts — Intent Execution Metrics
// Tracks performance of compiled intent token executions vs. interpreted
// (LLM-based) calls to quantify the efficiency gains of the ICE pipeline.

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum number of execution records to keep in the rolling window */
const MAX_WINDOW_SIZE = 10_000;

/** Average tokens consumed per interpreted (LLM-based) tool call */
const AVG_TOKENS_PER_INTERPRETED_CALL = 4_300;

/** Rough cost per token in USD (blended input/output estimate) */
const COST_PER_TOKEN = 0.000015;

// ─── Types ──────────────────────────────────────────────────────────────────

interface ExecutionRecord {
  tool: string;
  executionMs: number;
  wasCompiled: boolean;
  timestamp: number;
}

/** Aggregated metrics returned by `getStats()` */
export interface IntentMetricsStats {
  totalExecutions: number;
  compiledExecutions: number;
  interpretedExecutions: number;
  avgExecutionMs: number;
  p95ExecutionMs: number;
  estimatedTokensSaved: number;
  estimatedCostSaved: number;
  cacheHits: number;
  sqlFusions: number;
}

// ─── IntentMetrics Class ────────────────────────────────────────────────────

/**
 * Performance tracker for intent token executions.
 *
 * Maintains a rolling window of execution records and computes
 * statistics including latency percentiles, compiled/interpreted
 * ratios, and estimated cost savings from skipping LLM inference.
 */
export class IntentMetrics {
  private records: ExecutionRecord[] = [];
  private _cacheHits = 0;
  private _sqlFusions = 0;

  /**
   * Record an intent execution.
   *
   * @param tool        - Name of the tool that was executed
   * @param executionMs - Wall-clock execution time in milliseconds
   * @param wasCompiled - Whether this was a compiled (true) or interpreted (false) execution
   */
  record(tool: string, executionMs: number, wasCompiled: boolean): void {
    this.records.push({
      tool,
      executionMs,
      wasCompiled,
      timestamp: Date.now(),
    });

    // Trim to rolling window — drop oldest records when exceeding capacity
    if (this.records.length > MAX_WINDOW_SIZE) {
      this.records = this.records.slice(this.records.length - MAX_WINDOW_SIZE);
    }
  }

  /** Record a cache hit */
  recordCacheHit(): void { this._cacheHits++; }

  /** Record SQL fusion optimization */
  recordSqlFusion(count: number): void { this._sqlFusions += count; }

  /**
   * Compute aggregated execution statistics from the rolling window.
   *
   * @returns Metrics including totals, averages, p95 latency,
   *          and estimated token/cost savings from compiled execution
   */
  getStats(): IntentMetricsStats {
    const total = this.records.length;

    if (total === 0) {
      return {
        totalExecutions: 0,
        compiledExecutions: 0,
        interpretedExecutions: 0,
        avgExecutionMs: 0,
        p95ExecutionMs: 0,
        estimatedTokensSaved: 0,
        estimatedCostSaved: 0,
        cacheHits: this._cacheHits,
        sqlFusions: this._sqlFusions,
      };
    }

    let compiledCount = 0;
    let totalMs = 0;

    for (const record of this.records) {
      if (record.wasCompiled) compiledCount++;
      totalMs += record.executionMs;
    }

    const interpretedCount = total - compiledCount;
    const avgMs = totalMs / total;

    // Calculate p95 — 95th percentile execution time
    const sorted = this.records
      .map((r) => r.executionMs)
      .sort((a, b) => a - b);
    const p95Index = Math.ceil(total * 0.95) - 1;
    const p95Ms = sorted[Math.min(p95Index, sorted.length - 1)];

    // Estimate savings: each compiled execution skips one LLM round-trip
    const estimatedTokensSaved = compiledCount * AVG_TOKENS_PER_INTERPRETED_CALL;
    const estimatedCostSaved = estimatedTokensSaved * COST_PER_TOKEN;

    return {
      totalExecutions: total,
      compiledExecutions: compiledCount,
      interpretedExecutions: interpretedCount,
      avgExecutionMs: Math.round(avgMs * 100) / 100,
      p95ExecutionMs: p95Ms,
      estimatedTokensSaved,
      estimatedCostSaved: Math.round(estimatedCostSaved * 1_000_000) / 1_000_000,
      cacheHits: this._cacheHits,
      sqlFusions: this._sqlFusions,
    };
  }

  /** Reset all recorded metrics */
  reset(): void {
    this.records = [];
    this._cacheHits = 0;
    this._sqlFusions = 0;
  }
}

// Singleton instance shared across the application
export const intentMetrics = new IntentMetrics();
