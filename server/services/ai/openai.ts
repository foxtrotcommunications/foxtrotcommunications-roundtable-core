// server/services/ai/openai.ts — OpenAI chat-completions streaming + tool
// loop. Bodies moved verbatim from aiProvider.ts (Phase 6.1 split).
import type { StreamEvent, OpenAIToolCall, OpenAIUsage, WorkspaceConfig, ChatMessage, ToolProfile } from '../../types';
import type { Response as NodeFetchResponse } from 'node-fetch';
import { runWorkspaceTool, checkToolResult, blockedToolMessage, breakerKey, fineBreakerKey, trippedBreakerKey, proseLength, COMPOSE_NUDGE } from './loop';

const fetch = require('node-fetch') as typeof import('node-fetch').default;
const { toOpenAITools } = require('../../tools') as {
  toOpenAITools: (enabledToolNames?: string[] | null, profile?: ToolProfile) => Record<string, unknown>[];
};
const { startSpan, endSpan, preview } = require('../../tracing') as typeof import('../../tracing');
const { recordSpan } = require('../../tracing/collector') as typeof import('../../tracing/collector');

// ─── OpenAI ─────────────────────────────────────────────

export async function* streamOpenAI(model: string, messages: ChatMessage[], apiKey: string, enableTools: boolean, maxRounds: number, signal: AbortSignal | null, enabledToolNames: string[] | null, workspaceConfig: WorkspaceConfig = {}): AsyncGenerator<StreamEvent> {
  const traceCtx = workspaceConfig?.traceContext;
  const llmSpan = workspaceConfig?._llmSpan || null;
  const currentMessages: Array<Record<string, unknown> | ChatMessage> = [...messages];
  let fullText: string = '';
  let composeNudged = false;
  const toolFailures = new Map<string, { count: number; lastError: string }>();

  for (let round: number = 0; round < maxRounds; round++) {
    if (signal?.aborted) { yield { type: 'done', fullText }; return; }

    const body: Record<string, unknown> = {
      model,
      messages: currentMessages,
      max_completion_tokens: 16384,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (enableTools && round < maxRounds - 1) {
      body.tools = toOpenAITools(enabledToolNames, workspaceConfig?.toolProfile);
      body.tool_choice = 'auto';
      // gpt-5.6-sol rejects function tools on /v1/chat/completions unless
      // reasoning_effort is explicitly 'none' (reasoning defaults on). Tool
      // rounds run without reasoning; the final compose round (no tools)
      // keeps the model's default reasoning.
      if (/-sol$/.test(model)) {
        body.reasoning_effort = 'none';
      }
    }

    const response: NodeFetchResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: signal as AbortSignal | undefined,
    });

    if (!response.ok) {
      const errText: string = await response.text();
      yield { type: 'error', error: `OpenAI API error (${response.status}): ${errText}` };
      return;
    }

    const { toolCalls, text, usage, finishReason, streamEndedCleanly } = yield* parseOpenAIStream(response, signal);
    fullText += text;

    // Permanent low-volume tripwire: a completion that ended WITHOUT a clean
    // finish_reason was cut upstream (network/provider), not by us. Logged only
    // on that anomaly, so it stays silent in normal operation.
    if (finishReason === null && !streamEndedCleanly) {
      console.warn(`[aiProvider] round ${round} stream ended with no finish_reason (upstream cut) — text so far ${fullText.length} chars`);
    }

    // Emit usage if available
    if (usage) {
      yield { type: 'usage', promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens };
    }

    if (toolCalls.length === 0) {
      // Anti-preamble guard: the model sometimes ends its turn after only an
      // opening line, having done its data-gathering via tools but never
      // writing the analysis. If it did real multi-round tool work (round >= 2)
      // yet produced almost no prose, nudge it ONCE (tools off) to compose the
      // full written analysis rather than shipping a broken half-answer.
      if (!composeNudged && round >= 2 && round < maxRounds - 1 && proseLength(fullText) < 400) {
        composeNudged = true;
        currentMessages.push({ role: 'assistant', content: text || null });
        currentMessages.push({ role: 'user', content: COMPOSE_NUDGE });
        continue;
      }
      if (llmSpan) { endSpan(llmSpan, 'completed', { metadata: { rounds: round + 1, provider: 'openai', model, composeNudged } }); recordSpan(llmSpan); }
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

  console.warn(`[OpenAI] Exhausted ${maxRounds} tool rounds`);
  if (llmSpan) { endSpan(llmSpan, 'completed', { metadata: { rounds: maxRounds, provider: 'openai', model } }); recordSpan(llmSpan); }
  yield { type: 'done', fullText: fullText || `I was unable to complete your request after ${maxRounds} tool-call rounds. Some tools may have encountered errors. Please try again or simplify your query.` };
}

export async function* parseOpenAIStream(response: NodeFetchResponse, signal: AbortSignal | null): AsyncGenerator<StreamEvent, { toolCalls: OpenAIToolCall[]; text: string; usage: OpenAIUsage | null; finishReason: string | null; streamEndedCleanly: boolean }> {
  const toolCalls: OpenAIToolCall[] = [];
  let text: string = '';
  let usage: OpenAIUsage | null = null;
  let finishReason: string | null = null;
  let sawDone = false;

  const body = response.body as AsyncIterable<Buffer>;
  let buffer: string = '';

  for await (const chunk of body) {
    if (signal?.aborted) break;
    buffer += chunk.toString();
    const lines: string[] = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed: string = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data: string = trimmed.slice(6);
      if (data === '[DONE]') { sawDone = true; continue; }

      try {
        const parsed: Record<string, unknown> = JSON.parse(data);
        const choices = parsed.choices as Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }> | undefined;
        // finish_reason arrives on its own final chunk (delta empty).
        if (choices?.[0]?.finish_reason) finishReason = choices[0].finish_reason;
        const delta = choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          text += delta.content as string;
          yield { type: 'text-delta', content: delta.content as string };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
            if (tc.index !== undefined) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = { id: '', name: '', arguments: '' };
              }
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
            }
          }
        }

        // Capture usage from final chunk (stream_options.include_usage)
        if ((parsed as Record<string, unknown>).usage) {
          usage = (parsed as Record<string, unknown>).usage as OpenAIUsage;
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  return { toolCalls: toolCalls.filter(Boolean), text, usage, finishReason, streamEndedCleanly: sawDone };
}
