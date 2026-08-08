// server/a2a/server.ts — A2A server implementation (JSON-RPC 2.0 over HTTP)
//
// Implements the Agent-to-Agent protocol without an external SDK.
// The protocol is simple JSON-RPC 2.0:
//   GET  /.well-known/agent.json  → return agent card
//   POST /a2a                     → JSON-RPC methods: message/send, tasks/get, tasks/cancel
//
import type { StreamEvent, ChatMessage, WorkspaceConfig } from '../types';
import type { Span } from '../tracing';

const { startSpan, endSpan, spanFromHeaders, generateTraceId, preview } = require('../tracing') as typeof import('../tracing');
const { recordSpan } = require('../tracing/collector') as typeof import('../tracing/collector');

const crypto = require('crypto');
const config = require('../config') as import('../types').AppConfig;
const { streamCompletion } = require('../services/aiProvider') as {
  streamCompletion: (
    provider: string,
    model: string,
    messages: ChatMessage[],
    apiKey: string,
    enableTools: boolean,
    signal: AbortSignal | null,
    enabledToolNames: string[] | null,
    workspaceConfig: WorkspaceConfig
  ) => AsyncGenerator<StreamEvent>;
};

// ─── Step Log Labels + Provenance (application hooks) ──────
// Application-specific labels and provenance semantics are registered by the
// application plugin via server/a2a/appHooks.ts; core only has generic
// fallbacks. (Pendragon's financial versions live in @pendragon/tools-plaid.)
const { describeActivity, extractProvenance, getPreConsults } = require('./appHooks') as typeof import('./appHooks');
const { executeTool } = require('../tools') as { executeTool: (name: string, args: any, workspaceConfig?: any) => Promise<any> };

// ─── A2A Task Types ────────────────────────────────────────

type A2aPart =
  | { type: 'text'; text: string }
  | { type: 'data'; data: unknown };

interface A2aMessage {
  role: 'user' | 'agent';
  parts: A2aPart[];
}

interface A2aArtifact {
  name?: string;
  parts: A2aPart[];
}

type TaskStatus = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled';

interface A2aTask {
  id: string;
  status: {
    state: TaskStatus;
    message?: A2aMessage;
    timestamp: string;
  };
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
}

// ─── In-Memory Task Store ──────────────────────────────────

const taskStore = new Map<string, A2aTask>();

// Clean up completed tasks older than 1 hour to prevent memory leaks
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, task] of taskStore) {
    const ts = new Date(task.status.timestamp).getTime();
    if (ts < cutoff && (task.status.state === 'completed' || task.status.state === 'failed' || task.status.state === 'canceled')) {
      taskStore.delete(id);
    }
  }
}, 10 * 60 * 1000); // Run every 10 min

// ─── Process Message ───────────────────────────────────────

interface ProcessMessageOptions {
  message: A2aMessage;
  provider: string;
  model: string;
  apiKey: string;
  enabledToolNames: string[] | null;
  workspaceConfig: WorkspaceConfig;
  systemPrompt?: string;
  /** Incoming HTTP request headers for trace context propagation */
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Process an incoming A2A message: create a task, run AI completion, return result.
 */
async function processMessage(options: ProcessMessageOptions): Promise<A2aTask> {
  const { message, provider, model, apiKey, enabledToolNames, workspaceConfig, systemPrompt, headers } = options;

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  // ── Distributed tracing: extract incoming context or start a new trace ──
  const traceCtx = headers ? spanFromHeaders(headers) : null;
  const messageText = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  const rootSpan = startSpan({
    traceId: traceCtx?.traceId || generateTraceId(),
    parentSpanId: traceCtx?.parentSpanId || null,
    workspaceId: config.workspaceId || '',
    workspaceName: config.workspaceName || '',
    operation: 'a2a.message_send',
    inputPreview: preview(messageText),
    sampled: traceCtx?.sampled,
  });

  // Attach trace context to workspaceConfig so tools can propagate it
  const tracedWorkspaceConfig = {
    ...workspaceConfig,
    traceContext: {
      traceId: rootSpan.traceId,
      spanId: rootSpan.spanId,
      sampled: rootSpan._sampled,
    },
  };

  // 1. Create task with status 'submitted'
  const task: A2aTask = {
    id: taskId,
    status: {
      state: 'submitted',
      timestamp: now,
    },
    history: [message],
  };
  taskStore.set(taskId, task);

  // 2. Set status to 'working'
  task.status = {
    state: 'working',
    timestamp: new Date().toISOString(),
  };

  // 3. Build messages array
  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  // Convert A2A message parts to a single user message
  const userText = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');

  messages.push({ role: 'user', content: userText });

  // Track tool call count at function scope so it's available in the catch block
  let toolCallCount = 0;

  try {
    // 4. Stream completion and collect full text + tool provenance
    let fullText = '';
    let snapshotText = '';  // Captures text before post-response tool calls to prevent duplicates
    const toolResults: Array<{ name: string; result: Record<string, unknown> }> = [];
    const injectedChartBlocks: string[] = [];  // Chart blocks injected from render_chart — tracked separately so they survive the done handler's fullText overwrite

    // ── App-mandated pre-consults (2026-08-08) ──────────────────────────
    // Domains the application declares must be consulted FRESH before the
    // model's first reasoning round. Executed as real intent_bridge calls
    // (wake-and-retry included), recorded as real tool spans and toolResults
    // so provenance, receipts, and confidence reflect them — then surfaced
    // to the model as data already in hand. The model cannot skip a consult
    // that has already happened, and there is no cache to go stale: an edit
    // in the source domain is visible to the very next conversation turn.
    // Fail-open per consult: a pre-consult error must never block the chat
    // (worst case is exactly the old behavior — the model asks).
    for (const pc of getPreConsults({ workspaceName: config.workspaceName })) {
      try {
        const pcResult = await executeTool('intent_bridge', pc.args, tracedWorkspaceConfig);
        const pcSpan = startSpan({
          traceId: rootSpan.traceId,
          parentSpanId: rootSpan.spanId,
          workspaceId: rootSpan.workspaceId,
          workspaceName: rootSpan.workspaceName,
          operation: 'tool_call',
          toolName: 'intent_bridge',
          inputPreview: preview(JSON.stringify(pc.args)),
          sampled: rootSpan._sampled,
        });
        endSpan(pcSpan, 'completed', { outputPreview: preview(JSON.stringify(pcResult)) });
        recordSpan(pcSpan);
        toolResults.push({ name: 'intent_bridge', result: pcResult as Record<string, unknown> });
        toolCallCount++;
        messages.push({
          role: 'system',
          content: `[Pre-consulted ${pc.label || String(pc.args.target)} — live data retrieved for this conversation; treat as already known, do not re-request it]\n${JSON.stringify(pcResult).slice(0, 4000)}`,
        });
      } catch (pcErr: any) {
        console.warn(`[A2A] pre-consult "${pc.label || pc.args?.target}" failed: ${pcErr.message} — continuing without it`);
      }
    }

    // Add a 4-minute timeout to prevent indefinite hangs
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 240_000);

    try {
      const stream = streamCompletion(
        provider,
        model,
        messages,
        apiKey,
        true,       // enableTools
        controller.signal,
        enabledToolNames,
        tracedWorkspaceConfig
      );

      const wsChannel = `ws:${config.workspaceId}`;
      const io = (global as any)._io;
      let firstTextChunk = true;

      for await (const event of stream) {
        if (event.type === 'text-delta') {
          fullText += event.content;
          // First text chunk — AI is composing
          if (firstTextChunk && io) {
            io.to(wsChannel).emit('ai-status', { step: 'composing', label: 'Composing response', state: 'active' });
            firstTextChunk = false;
          }
        } else if (event.type === 'tool-call') {
          // Emit step log: tool call starting
          if (io && event.name) {
            const activity = describeActivity(event.name, (event as any).args || {});
            io.to(wsChannel).emit('ai-status', { step: activity.step, label: activity.label, state: 'active' });
          }
        } else if (event.type === 'tool-result') {
          // ── Distributed tracing: record child span for each tool result ──
          const toolSpan = startSpan({
            traceId: rootSpan.traceId,
            parentSpanId: rootSpan.spanId,
            workspaceId: rootSpan.workspaceId,
            workspaceName: rootSpan.workspaceName,
            operation: 'tool_call',
            toolName: event.name,
            sampled: rootSpan._sampled,
          });
          endSpan(toolSpan, 'completed', { outputPreview: preview(event.result) });
          recordSpan(toolSpan);

          toolResults.push({ name: event.name, result: event.result });
          toolCallCount++;

          // Emit step log: tool call completed
          if (io && event.name) {
            const completedActivity = describeActivity(event.name, (event.result as Record<string, unknown>) || {});
            io.to(wsChannel).emit('ai-status', { step: completedActivity.step, label: completedActivity.label, state: 'completed' });
          }

          // render_chart: inject chartBlock directly into fullText so the
          // A2A response includes the chart block, regardless of whether
          // the model echoes it back in its text output.
          if (event.name === 'render_chart' && event.result) {
            const chartResult = (typeof event.result === 'string' ? JSON.parse(event.result) : event.result) as Record<string, unknown>;
            const block = (chartResult.chartBlock as string) || '';
            if (block) {
              injectedChartBlocks.push(block);
            }
          }

          // If we already have a substantial response and the model is doing
          // a follow-up tool call (e.g. emit_provenance after the main response),
          // snapshot the text so we don't append a duplicate response afterward.
          if (fullText.trim().length > 100) {
            snapshotText = fullText;
          }
        } else if (event.type === 'done') {
          // Prefer the model's complete final text. Only fall back to a
          // pre-tool-call snapshot when that snapshot is itself a SUBSTANTIAL
          // answer AND the final text is much larger — the signature of the old
          // duplicate-composition bug (model re-composed the whole answer 2-3x).
          //
          // A SMALL snapshot (e.g. a one-line opening preamble the model wrote
          // before gathering data) must NEVER override the real analysis it
          // composes in a later round. That was silently discarding thousands
          // of chars — the intermittent "charts-only" truncation: whether the
          // model happened to emit an early preamble decided whether its whole
          // analysis got thrown away here.
          const snapshotIsSubstantial = snapshotText.trim().length > 1500;
          if (snapshotIsSubstantial && event.fullText && event.fullText.length > snapshotText.length * 1.8) {
            fullText = snapshotText;
          } else {
            fullText = event.fullText || fullText;
          }
          // Re-append any injected chart blocks that were wiped by the fullText overwrite
          for (const block of injectedChartBlocks) {
            if (!fullText.includes(block)) {
              fullText = block + '\n' + fullText;
            }
          }
          // Mark composing as done
          if (io) {
            io.to(wsChannel).emit('ai-status', { step: 'composing', label: 'Composing response', state: 'completed' });
          }
        } else if (event.type === 'error') {
          throw new Error(event.error);
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    // ── Retry on empty response ────────────────────────────────
    // If the AI did tool calls but produced no text (safety filter, model
    // refusal, or output token exhaustion), retry with a synthesis prompt.
    if (!fullText.trim() && toolResults.length > 0) {
      console.warn(`[A2A] Empty response after ${toolResults.length} tool calls — retrying with synthesis prompt`);

      // Build a concise summary of tool results for the retry
      const toolSummaries = toolResults.map(tr => {
        const r = tr.result as any;
        if (tr.name === 'intent_bridge' && r?.success) {
          const cap = r.toolExecuted || r.capability || 'unknown';
          const dataPreview = JSON.stringify(r.data).slice(0, 500);
          return `[${cap}]: ${dataPreview}`;
        }
        return `[${tr.name}]: ${JSON.stringify(tr.result).slice(0, 300)}`;
      }).join('\n\n');

      const retryMessages: ChatMessage[] = [
        ...messages,
        {
          role: 'assistant' as const,
          content: `I queried the following domains and received data:\n\n${toolSummaries}`,
        },
        {
          role: 'user' as const,
          content: 'Based on the data you just retrieved, please provide your analysis. Respond directly — do not make additional tool calls.',
        },
      ];

      const retryController = new AbortController();
      const retryTimeoutId = setTimeout(() => retryController.abort(), 60_000);

      try {
        const retryStream = streamCompletion(
          provider,
          model,
          retryMessages,
          apiKey,
          false,      // disable tools on retry
          retryController.signal,
          null,       // no tool names needed
          tracedWorkspaceConfig
        );

        for await (const event of retryStream) {
          if (event.type === 'text-delta') {
            fullText += event.content;
          } else if (event.type === 'done') {
            fullText = event.fullText || fullText;
          }
        }
      } finally {
        clearTimeout(retryTimeoutId);
      }

      if (!fullText.trim()) {
        fullText = '⚠️ I retrieved your financial data but was unable to generate a response. This is typically caused by a temporary issue with the AI model. Please try asking your question again.';
      }
    }

    // Extract provenance from intent_bridge tool results
    const provenance = extractProvenance(toolResults);

    // 5. Set status to 'completed' with result as an artifact
    const agentMessage: A2aMessage = {
      role: 'agent',
      parts: [{ type: 'text', text: fullText }],
    };

    task.status = {
      state: 'completed',
      message: agentMessage,
      timestamp: new Date().toISOString(),
    };

    const artifacts: A2aTask['artifacts'] = [
      {
        name: 'response',
        parts: [{ type: 'text', text: fullText }],
      },
    ];

    // Include provenance as a structured artifact if available
    if (provenance) {
      artifacts.push({
        name: 'provenance',
        parts: [{ type: 'data', data: provenance }],
      });
    }

    // Answer manifest metadata (2026-08-02): the epistemic record of this
    // answer — which model produced it under which system prompt. Consumers
    // persist this alongside the message so any past answer can state what
    // configuration generated it (three prompt versions shipped in one week
    // with no way to attribute answers to them — that gap ends here).
    // sha256 of the prompt, never the prompt text: pods may hold per-tenant
    // customizations that shouldn't leak through response artifacts.
    artifacts.push({
      name: 'answer_meta',
      parts: [{ type: 'data', data: {
        provider,
        model,
        prompt_sha256: crypto.createHash('sha256').update(systemPrompt || '').digest('hex'),
      } }],
    });

    task.artifacts = artifacts;

    if (task.history) {
      task.history.push(agentMessage);
    }

    // ── Distributed tracing: end root span on success ──
    endSpan(rootSpan, 'completed', {
      outputPreview: preview(fullText),
      metadata: { toolCallCount: toolResults.length, provider, model },
    });
    recordSpan(rootSpan);
  } catch (err: unknown) {
    const error = err as Error;
    task.status = {
      state: 'failed',
      message: {
        role: 'agent',
        parts: [{ type: 'text', text: `Error: ${error.message}` }],
      },
      timestamp: new Date().toISOString(),
    };

    // ── Distributed tracing: end root span on error (always recorded) ──
    endSpan(rootSpan, 'error', {
      outputPreview: preview(error.message),
      metadata: { toolCallCount },
    });
    recordSpan(rootSpan);
  }

  return task;
}

/**
 * Get a task by ID from the in-memory store.
 */
function getTask(taskId: string): A2aTask | undefined {
  return taskStore.get(taskId);
}

/**
 * Cancel a task by ID (only if it's still working).
 */
function cancelTask(taskId: string): A2aTask | null {
  const task = taskStore.get(taskId);
  if (!task) return null;

  if (task.status.state === 'working' || task.status.state === 'submitted') {
    task.status = {
      state: 'canceled',
      timestamp: new Date().toISOString(),
    };
  }

  return task;
}

// NOTE: this CJS export object overrides any `export` statements above under
// the tsx/ts-jest CJS transforms — new exports must be added HERE.
module.exports = { processMessage, getTask, cancelTask, taskStore, extractProvenance };
