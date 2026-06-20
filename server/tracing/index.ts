// server/tracing/index.ts — Distributed trace context library for Roundtable
// Provides span creation, lifecycle management, header propagation, and sampling.
import crypto from 'crypto';

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  workspaceId: string;
  workspaceName: string;
  operation: string;
  toolName?: string;
  status: 'started' | 'completed' | 'error' | 'timeout' | 'retrying';
  startedAt: string;       // ISO timestamp
  durationMs?: number;
  inputPreview?: string;   // first 500 chars
  outputPreview?: string;  // first 500 chars
  metadata?: Record<string, unknown>;
  _startTime?: number;     // internal, not persisted (Date.now())
  _sampled?: boolean;      // whether this trace should be persisted
}

// ── ID generation ──────────────────────────────────────────────────────

/** Generate a 32-hex-char trace ID (128-bit). */
export function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Generate a 16-hex-char span ID (64-bit). */
export function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// ── Span lifecycle ─────────────────────────────────────────────────────

export function startSpan(opts: {
  traceId?: string;
  parentSpanId?: string | null;
  workspaceId: string;
  workspaceName: string;
  operation: string;
  toolName?: string;
  inputPreview?: string;
  sampled?: boolean;
}): Span {
  const isRoot = !opts.traceId;

  // Sampling decision: explicit flag > 20% random sample for root spans.
  // Child spans inherit from parent context.
  let sampled: boolean;
  if (opts.sampled !== undefined) {
    sampled = opts.sampled;
  } else if (isRoot) {
    sampled = Math.random() < 0.2;
  } else {
    // Non-root without explicit flag — default to sampled (parent should propagate)
    sampled = true;
  }

  return {
    traceId: opts.traceId || generateTraceId(),
    spanId: generateSpanId(),
    parentSpanId: opts.parentSpanId ?? null,
    workspaceId: opts.workspaceId,
    workspaceName: opts.workspaceName,
    operation: opts.operation,
    toolName: opts.toolName,
    status: 'started',
    startedAt: new Date().toISOString(),
    inputPreview: opts.inputPreview ? preview(opts.inputPreview) : undefined,
    _startTime: Date.now(),
    _sampled: sampled,
  };
}

export function endSpan(
  span: Span,
  status: Span['status'],
  opts?: { outputPreview?: string; metadata?: Record<string, unknown> },
): Span {
  span.status = status;
  if (span._startTime) {
    span.durationMs = Date.now() - span._startTime;
  }
  if (opts?.outputPreview !== undefined) {
    span.outputPreview = preview(opts.outputPreview);
  }
  if (opts?.metadata) {
    span.metadata = { ...span.metadata, ...opts.metadata };
  }

  // Errors and timeouts are ALWAYS sampled regardless of the original flag
  if (status === 'error' || status === 'timeout') {
    span._sampled = true;
  }

  return span;
}

// ── Utilities ──────────────────────────────────────────────────────────

/** Truncate arbitrary input to a safe preview string (default 500 chars). */
export function preview(text: unknown, maxLen: number = 500): string {
  if (text === null || text === undefined) return '';
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

// ── Header propagation ────────────────────────────────────────────────

const HEADER_TRACE_ID = 'x-trace-id';
const HEADER_PARENT_SPAN_ID = 'x-parent-span-id';
const HEADER_SAMPLED = 'x-trace-sampled';

/** Extract trace context from incoming request headers. */
export function spanFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): { traceId: string; parentSpanId: string; sampled: boolean } | null {
  const traceId = normalizeHeader(headers[HEADER_TRACE_ID]);
  const parentSpanId = normalizeHeader(headers[HEADER_PARENT_SPAN_ID]);
  if (!traceId || !parentSpanId) return null;

  const sampledRaw = normalizeHeader(headers[HEADER_SAMPLED]);
  const sampled = sampledRaw !== '0';

  return { traceId, parentSpanId, sampled };
}

/** Inject trace context into outgoing request headers. */
export function injectTraceHeaders(headers: Record<string, string>, span: Span): void {
  headers[HEADER_TRACE_ID] = span.traceId;
  headers[HEADER_PARENT_SPAN_ID] = span.spanId;
  headers[HEADER_SAMPLED] = span._sampled ? '1' : '0';
}

// ── Internal helpers ───────────────────────────────────────────────────

function normalizeHeader(value: string | string[] | undefined): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] || null;
  return value;
}
