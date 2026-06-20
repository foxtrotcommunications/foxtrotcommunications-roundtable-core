// server/tracing/collector.ts — In-memory span buffer with BigQuery flush
// Collects completed spans and periodically inserts them into
// roundtable_telemetry.request_traces for observability.
import type { Span } from './index';

const spanBuffer: Span[] = [];
const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE = 50;

const BQ_PROJECT = process.env.GCP_PROJECT || 'roundtable-public';
const BQ_DATASET = 'roundtable_telemetry';
const BQ_TABLE = 'request_traces';

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Record a finished span for eventual BigQuery persistence.
 * Unsampled successful spans are dropped to control write volume.
 */
export function recordSpan(span: Span): void {
  // Skip unsampled successes — always record errors/timeouts
  if (span._sampled === false && span.status === 'completed') {
    return;
  }

  spanBuffer.push(span);

  console.log(
    `[trace] ${span.operation} ${span.status} ${span.durationMs ?? '-'}ms (traceId=${span.traceId})`,
  );

  if (spanBuffer.length >= FLUSH_BATCH_SIZE) {
    flush().catch(() => {}); // fire-and-forget
  }
}

/**
 * Drain the span buffer and insert rows into BigQuery.
 * Falls back to console.log(JSON) if BigQuery is unavailable.
 */
export async function flush(): Promise<void> {
  if (spanBuffer.length === 0) return;

  // Drain the buffer atomically
  const batch = spanBuffer.splice(0, spanBuffer.length);
  const rows = batch.map(stripInternalFields);

  try {
    const { BigQuery } = require('@google-cloud/bigquery');
    const bq = new BigQuery({ projectId: BQ_PROJECT });
    const table = bq.dataset(BQ_DATASET).table(BQ_TABLE);

    // Convert camelCase spans to snake_case BQ columns
    const bqRows = rows.map(r => ({
      trace_id: r.traceId,
      span_id: r.spanId,
      parent_span_id: r.parentSpanId || null,
      workspace_id: r.workspaceId || null,
      workspace_name: r.workspaceName || null,
      org_id: r.orgId || null,
      operation: r.operation,
      tool_name: r.toolName || null,
      status: r.status,
      started_at: r.startedAt,
      duration_ms: r.durationMs,
      input_preview: r.inputPreview || null,
      output_preview: r.outputPreview || null,
      metadata: r.metadata ? JSON.stringify(r.metadata) : null,
    }));

    await table.insert(bqRows);
    console.log(`[trace] Flushed ${bqRows.length} spans to BigQuery`);
  } catch (err: any) {
    // BigQuery unavailable — fall back to structured console output
    const msg = err.message || err.errors?.[0]?.message || JSON.stringify(err.errors || err).slice(0, 200);
    console.warn(`[trace] BigQuery flush failed (${msg}), falling back to console`);
    for (const row of rows) {
      console.log(JSON.stringify(row));
    }
  }
}

// ── Internal helpers ───────────────────────────────────────────────────

/** Strip internal runtime fields (_startTime, _sampled) before persistence. */
function stripInternalFields(span: Span): Omit<Span, '_startTime' | '_sampled'> {
  const { _startTime, _sampled, ...row } = span;
  return row;
}

// ── Auto-flush on interval ─────────────────────────────────────────────

const flushTimer = setInterval(() => {
  flush().catch(() => {});
}, FLUSH_INTERVAL_MS);

// Allow the process to exit cleanly without hanging on the timer
if (flushTimer.unref) {
  flushTimer.unref();
}
