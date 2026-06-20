# Roundtable Distributed Tracing

Lightweight request tracing for the Roundtable runtime. Spans flow through
A2A calls and tool executions, are buffered in-memory, and flushed to
BigQuery every 5 seconds.

## Quick Start

```typescript
import { startSpan, endSpan, preview } from '../tracing';
import { recordSpan } from '../tracing/collector';

// 1. Create a root span
const span = startSpan({
  workspaceId: config.workspaceId,
  workspaceName: config.workspaceName,
  operation: 'a2a.handleTask',
  inputPreview: preview(taskPayload),
});

try {
  const result = await handleTask(taskPayload);
  endSpan(span, 'completed', { outputPreview: preview(result) });
} catch (err) {
  endSpan(span, 'error', { metadata: { error: err.message } });
} finally {
  recordSpan(span);
}
```

## Propagating Context Across Services

When making outbound requests, inject trace headers so the downstream
service can continue the trace:

```typescript
import { injectTraceHeaders, startSpan } from '../tracing';

const childSpan = startSpan({
  traceId: parentSpan.traceId,
  parentSpanId: parentSpan.spanId,
  workspaceId: config.workspaceId,
  workspaceName: config.workspaceName,
  operation: 'bridge.callRemote',
  sampled: parentSpan._sampled,
});

const headers: Record<string, string> = { 'Content-Type': 'application/json' };
injectTraceHeaders(headers, childSpan);
// headers now contains X-Trace-Id, X-Parent-Span-Id, X-Trace-Sampled
```

When receiving requests, extract trace context from incoming headers:

```typescript
import { spanFromHeaders, startSpan } from '../tracing';

const incoming = spanFromHeaders(req.headers);
const span = startSpan({
  traceId: incoming?.traceId,
  parentSpanId: incoming?.parentSpanId,
  workspaceId: config.workspaceId,
  workspaceName: config.workspaceName,
  operation: 'a2a.handleTask',
  sampled: incoming?.sampled,
});
```

## Sampling Strategy

| Scenario | Sample Rate |
|---|---|
| Root span (no parent context) | 20% random |
| Error or timeout | 100% (always) |
| Child span | Inherits from parent |
| Explicit `sampled` flag | Honored as-is |

The sampling decision is made once at root span creation and propagated
via the `X-Trace-Sampled` header. Unsampled successful spans are silently
dropped by `recordSpan()`.

## BigQuery Destination

Spans flush to `roundtable-public.roundtable_telemetry.request_traces`.

The project can be overridden with `GCP_PROJECT` env var.

### Schema

| Column | Type | Description |
|---|---|---|
| `traceId` | STRING | 128-bit hex trace identifier |
| `spanId` | STRING | 64-bit hex span identifier |
| `parentSpanId` | STRING | Parent span ID (null for root) |
| `workspaceId` | STRING | Workspace that emitted the span |
| `workspaceName` | STRING | Human-readable workspace name |
| `operation` | STRING | e.g. `a2a.handleTask`, `tool.execute` |
| `toolName` | STRING | Tool name if applicable |
| `status` | STRING | `started`, `completed`, `error`, `timeout`, `retrying` |
| `startedAt` | TIMESTAMP | ISO 8601 start time |
| `durationMs` | INTEGER | Wall-clock duration |
| `inputPreview` | STRING | First 500 chars of input |
| `outputPreview` | STRING | First 500 chars of output |
| `metadata` | JSON | Arbitrary key-value pairs |
