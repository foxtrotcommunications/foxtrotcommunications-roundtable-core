// server/services/ai/ollama.ts — Ollama / OpenAI-compatible local streaming +
// tool loop. Bodies moved verbatim from aiProvider.ts (Phase 6.1 split).
import type { StreamEvent, OpenAIToolCall, WorkspaceConfig, ChatMessage, ToolProfile } from '../../types';
import type { Response as NodeFetchResponse } from 'node-fetch';
import { runWorkspaceTool, checkToolResult, blockedToolMessage, breakerKey, fineBreakerKey, trippedBreakerKey } from './loop';
import { parseOpenAIStream } from './openai';

const fetch = require('node-fetch') as typeof import('node-fetch').default;
const { toOpenAITools } = require('../../tools') as {
  toOpenAITools: (enabledToolNames?: string[] | null, profile?: ToolProfile) => Record<string, unknown>[];
};
const config = require('../../config') as import('../../types').AppConfig;
const { startSpan, endSpan, preview } = require('../../tracing') as typeof import('../../tracing');
const { recordSpan } = require('../../tracing/collector') as typeof import('../../tracing/collector');

// ─── Ollama / OpenAI-compatible ─────────────────────────

export async function* streamOllama(model: string, messages: ChatMessage[], enableTools: boolean, maxRounds: number, signal: AbortSignal | null, enabledToolNames: string[] | null, workspaceConfig: WorkspaceConfig = {}): AsyncGenerator<StreamEvent> {
  const traceCtx = workspaceConfig?.traceContext;
  const llmSpan = workspaceConfig?._llmSpan || null;
  const host: string = (workspaceConfig.ollamaHost || config.ollama.host || 'http://localhost:11434').replace(/\/+$/, '');
  const currentMessages: Array<Record<string, unknown> | ChatMessage> = [...messages];
  let fullText: string = '';
  const toolFailures = new Map<string, { count: number; lastError: string }>();

  for (let round: number = 0; round < maxRounds; round++) {
    if (signal?.aborted) { yield { type: 'done', fullText }; return; }

    const body: Record<string, unknown> = {
      model,
      messages: currentMessages,
      stream: true,
    };

    if (enableTools && round < maxRounds - 1) {
      const tools: Record<string, unknown>[] = toOpenAITools(enabledToolNames, workspaceConfig?.toolProfile);
      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }
    }

    let response: NodeFetchResponse;
    try {
      response = await fetch(`${host}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal as AbortSignal | undefined,
      });
    } catch (err: unknown) {
      const error = err as Error & { name: string };
      if (error.name === 'AbortError') { yield { type: 'done', fullText }; return; }
      yield { type: 'error', error: `Cannot reach Ollama at ${host}: ${error.message}` };
      return;
    }

    if (!response.ok) {
      const errText: string = await response.text();
      yield { type: 'error', error: `Ollama error (${response.status}): ${errText}` };
      return;
    }

    const { toolCalls, text, usage } = yield* parseOpenAIStream(response, signal);
    fullText += text;

    // Emit usage if available
    if (usage) {
      yield { type: 'usage', promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0, totalTokens: usage.total_tokens || 0 };
    }

    if (toolCalls.length === 0) {
      if (llmSpan) { endSpan(llmSpan, 'completed', { metadata: { rounds: round + 1, provider: 'ollama', model } }); recordSpan(llmSpan); }
      yield { type: 'done', fullText };
      return;
    }

    // Add assistant message with tool calls
    currentMessages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((tc: OpenAIToolCall) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Execute tools and add results. Calls in one round run in PARALLEL —
    // a model batching three domain consults should pay one consult's
    // latency, not three (measured 2026-07-18: serial consults inflated
    // multi-round answers; the Gemini path already parallelized). Events
    // and messages are emitted in the original call order so transcript
    // and UI are indistinguishable from the serial version.
    {
      const _io = (global as any)._io;
      const _wsId = workspaceConfig?.workspaceId;
      const configWithProgress = {
        ...workspaceConfig, model,
        _onProgress: _io && _wsId ? (step: string, label: string, state: string, opts?: any) => {
          _io.to(`ws:${_wsId}`).emit('ai-status', { step, label, state, ...opts });
        } : undefined,
      };
      for (const tc of toolCalls) {
        yield { type: 'tool-call', name: tc.name, args: JSON.parse(tc.arguments), callId: tc.id };
      }
      const settled = await Promise.all(toolCalls.map(async (tc: OpenAIToolCall) => {
        const _tripped = trippedBreakerKey(tc.name, tc.arguments, toolFailures);
        if (_tripped) {
          return { tc, blocked: true, result: { error: blockedToolMessage(_tripped, toolFailures) } as Record<string, unknown>, toolStart: Date.now(), durationMs: 0 };
        }
        const toolStart = Date.now();
        const result: Record<string, unknown> = await runWorkspaceTool(tc.name, JSON.parse(tc.arguments), configWithProgress, enabledToolNames);
        return { tc, blocked: false, result, toolStart, durationMs: Date.now() - toolStart };
      }));
      for (const ex of settled) {
        if (!ex.blocked && traceCtx) {
          const toolSpan = startSpan({ traceId: traceCtx.traceId, parentSpanId: llmSpan?.spanId || traceCtx.spanId, workspaceId: workspaceConfig?.workspaceId || '', workspaceName: workspaceConfig?.workspaceName || '', operation: 'tool_execution', toolName: ex.tc.name, inputPreview: preview(ex.tc.arguments), sampled: traceCtx.sampled });
          toolSpan._startTime = ex.toolStart;
          endSpan(toolSpan, 'completed', { outputPreview: preview(JSON.stringify(ex.result)), metadata: { durationMs: ex.durationMs } });
          recordSpan(toolSpan);
        }
        yield { type: 'tool-result', name: ex.tc.name, callId: ex.tc.id, result: ex.result };
        if (!ex.blocked) {
          checkToolResult(breakerKey(ex.tc.name, ex.tc.arguments), ex.result, toolFailures, fineBreakerKey(ex.tc.name, ex.tc.arguments));
        }
        currentMessages.push({
          role: 'tool',
          tool_call_id: ex.tc.id,
          content: JSON.stringify(ex.result),
        });
      }
    }
  }

  console.warn(`[Ollama] Exhausted ${maxRounds} tool rounds`);
  if (llmSpan) { endSpan(llmSpan, 'completed', { metadata: { rounds: maxRounds, provider: 'ollama', model } }); recordSpan(llmSpan); }
  yield { type: 'done', fullText: fullText || `I was unable to complete your request after ${maxRounds} tool-call rounds. Some tools may have encountered errors. Please try again or simplify your query.` };
}
