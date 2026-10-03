// server/services/ai/anthropic.ts — Anthropic Messages streaming + tool loop.
// Bodies moved verbatim from aiProvider.ts (Phase 6.1 split).
import type { StreamEvent, AnthropicToolUse, AnthropicUsage, WorkspaceConfig, ChatMessage, ToolProfile } from '../../types';
import type { Response as NodeFetchResponse } from 'node-fetch';
import { runWorkspaceTool, checkToolResult, blockedToolMessage, breakerKey, fineBreakerKey, trippedBreakerKey } from './loop';
import { extractSystemPrompt, formatAnthropicMessages } from './format';

const fetch = require('node-fetch') as typeof import('node-fetch').default;
const { toAnthropicTools } = require('../../tools') as {
  toAnthropicTools: (enabledToolNames?: string[] | null, profile?: ToolProfile) => Record<string, unknown>[];
};
const { startSpan, endSpan, preview } = require('../../tracing') as typeof import('../../tracing');
const { recordSpan } = require('../../tracing/collector') as typeof import('../../tracing/collector');

// ─── Anthropic ──────────────────────────────────────────

export async function* streamAnthropic(model: string, messages: ChatMessage[], apiKey: string, enableTools: boolean, maxRounds: number, signal: AbortSignal | null, enabledToolNames: string[] | null, workspaceConfig: WorkspaceConfig = {}): AsyncGenerator<StreamEvent> {
  const traceCtx = workspaceConfig?.traceContext;
  const llmSpan = workspaceConfig?._llmSpan || null;
  const currentMessages: Record<string, unknown>[] = formatAnthropicMessages(messages);
  const systemPrompt: string = extractSystemPrompt(messages);
  let fullText: string = '';
  const toolFailures = new Map<string, { count: number; lastError: string }>();

  for (let round: number = 0; round < maxRounds; round++) {
    if (signal?.aborted) { yield { type: 'done', fullText }; return; }

    const body: Record<string, unknown> = {
      model,
      messages: currentMessages,
      max_completion_tokens: 16384,
      stream: true,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (enableTools && round < maxRounds - 1) {
      body.tools = toAnthropicTools(enabledToolNames, workspaceConfig?.toolProfile);
    }

    const response: NodeFetchResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: signal as AbortSignal | undefined,
    });

    if (!response.ok) {
      const errText: string = await response.text();
      yield { type: 'error', error: `Anthropic API error (${response.status}): ${errText}` };
      return;
    }

    const { toolUses, text, stopReason, usage } = yield* parseAnthropicStream(response, signal);
    fullText += text;

    // Emit usage if available
    if (usage) {
      yield { type: 'usage', promptTokens: usage.input_tokens, completionTokens: usage.output_tokens, totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) };
    }

    if (toolUses.length === 0 || stopReason !== 'tool_use') {
      if (llmSpan) { endSpan(llmSpan, 'completed', { metadata: { rounds: round + 1, provider: 'anthropic', model } }); recordSpan(llmSpan); }
      yield { type: 'done', fullText };
      return;
    }

    // Build assistant content blocks
    const assistantContent: Record<string, unknown>[] = [];
    if (text) assistantContent.push({ type: 'text', text });
    for (const tu of toolUses) {
      assistantContent.push({
        type: 'tool_use',
        id: tu.id,
        name: tu.name,
        input: tu.input,
      });
    }
    currentMessages.push({ role: 'assistant', content: assistantContent });

    // Execute tools
    const toolResults: Record<string, unknown>[] = [];
    for (const tu of toolUses) {
      // ── Fail-fast: skip tools that have exceeded the failure threshold ──
      const _bkey = breakerKey(tu.name, tu.input);
      const _fkey = fineBreakerKey(tu.name, tu.input);
      const _tripped = trippedBreakerKey(tu.name, tu.input, toolFailures);
      if (_tripped) {
        const errorMsg = blockedToolMessage(_tripped, toolFailures);
        yield { type: 'tool-call', name: tu.name, args: tu.input, callId: tu.id };
        yield { type: 'tool-result', name: tu.name, callId: tu.id, result: { error: errorMsg } };
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ error: errorMsg }) });
        continue;
      }

      yield { type: 'tool-call', name: tu.name, args: tu.input, callId: tu.id };

      const toolStart = Date.now();
      const _io = (global as any)._io;
      const _wsId = workspaceConfig?.workspaceId;
      const configWithProgress = {
        ...workspaceConfig, model,
        _onProgress: _io && _wsId ? (step: string, label: string, state: string, opts?: any) => {
          _io.to(`ws:${_wsId}`).emit('ai-status', { step, label, state, ...opts });
        } : undefined,
      };
      const result: Record<string, unknown> = await runWorkspaceTool(tu.name, tu.input, configWithProgress, enabledToolNames);
      const toolDurationMs = Date.now() - toolStart;
      if (traceCtx) {
        const toolSpan = startSpan({ traceId: traceCtx.traceId, parentSpanId: llmSpan?.spanId || traceCtx.spanId, workspaceId: workspaceConfig?.workspaceId || '', workspaceName: workspaceConfig?.workspaceName || '', operation: 'tool_execution', toolName: tu.name, inputPreview: preview(JSON.stringify(tu.input)), sampled: traceCtx.sampled });
        toolSpan._startTime = toolStart;
        endSpan(toolSpan, 'completed', { outputPreview: preview(JSON.stringify(result)), metadata: { durationMs: toolDurationMs } });
        recordSpan(toolSpan);
      }
      yield { type: 'tool-result', name: tu.name, callId: tu.id, result };

      // ── Track failures ──
      checkToolResult(_bkey, result, toolFailures, _fkey);

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }

    currentMessages.push({ role: 'user', content: toolResults });
  }

  console.warn(`[Anthropic] Exhausted ${maxRounds} tool rounds`);
  if (llmSpan) { endSpan(llmSpan, 'completed', { metadata: { rounds: maxRounds, provider: 'anthropic', model } }); recordSpan(llmSpan); }
  yield { type: 'done', fullText: fullText || `I was unable to complete your request after ${maxRounds} tool-call rounds. Some tools may have encountered errors. Please try again or simplify your query.` };
}

async function* parseAnthropicStream(response: NodeFetchResponse, signal: AbortSignal | null): AsyncGenerator<StreamEvent, { toolUses: AnthropicToolUse[]; text: string; stopReason: string; usage: AnthropicUsage | null }> {
  const toolUses: AnthropicToolUse[] = [];
  let text: string = '';
  let stopReason: string = '';
  let currentToolUse: AnthropicToolUse | null = null;
  let currentToolJson: string = '';
  let usage: AnthropicUsage | null = null;

  const body = response.body as AsyncIterable<Buffer>;
  let buffer: string = '';

  for await (const chunk of body) {
    if (signal?.aborted) break;
    buffer += chunk.toString();
    const lines: string[] = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed: string = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const data: string = trimmed.slice(6);

      try {
        const parsed: Record<string, unknown> = JSON.parse(data);

        if (parsed.type === 'content_block_start' && (parsed.content_block as Record<string, unknown>)?.type === 'tool_use') {
          const contentBlock = parsed.content_block as { id: string; name: string };
          currentToolUse = {
            id: contentBlock.id,
            name: contentBlock.name,
            input: {},
          };
          currentToolJson = '';
        }

        if (parsed.type === 'content_block_delta') {
          const delta = parsed.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta') {
            text += delta.text as string;
            yield { type: 'text-delta', content: delta.text as string };
          }
          if (delta?.type === 'input_json_delta' && currentToolUse) {
            currentToolJson += delta.partial_json as string;
          }
        }

        if (parsed.type === 'content_block_stop' && currentToolUse) {
          try {
            currentToolUse.input = JSON.parse(currentToolJson);
          } catch {
            currentToolUse.input = {};
          }
          toolUses.push(currentToolUse);
          currentToolUse = null;
          currentToolJson = '';
        }

        if (parsed.type === 'message_delta' && (parsed.delta as Record<string, unknown>)?.stop_reason) {
          stopReason = (parsed.delta as Record<string, unknown>).stop_reason as string;
        }

        // Capture usage from message_start and message_delta
        if (parsed.type === 'message_start' && (parsed.message as Record<string, unknown>)?.usage) {
          const msgUsage = (parsed.message as Record<string, unknown>).usage as Record<string, number>;
          usage = { input_tokens: msgUsage.input_tokens || 0, output_tokens: 0 };
        }
        if (parsed.type === 'message_delta' && parsed.usage) {
          const deltaUsage = parsed.usage as Record<string, number>;
          if (usage) {
            usage.output_tokens = deltaUsage.output_tokens || 0;
          } else {
            usage = { input_tokens: 0, output_tokens: deltaUsage.output_tokens || 0 };
          }
        }
      } catch {
        // Skip
      }
    }
  }

  return { toolUses, text, stopReason, usage };
}
