// server/services/aiProvider.ts — Unified multi-provider AI interface with tool support
import type {
  StreamEvent,
  OpenAIToolCall,
  OpenAIUsage,
  AnthropicToolUse,
  AnthropicUsage,
  GoogleFunctionCall,
  GoogleUsageMetadata,
  WorkspaceConfig,
  ChatMessage,
} from '../types';
import type { Response as NodeFetchResponse } from 'node-fetch';

const fetch = require('node-fetch') as typeof import('node-fetch').default;
const { GoogleGenAI } = require('@google/genai') as { GoogleGenAI: new (opts: Record<string, unknown>) => GoogleGenAIClient };
const { executeTool, toOpenAITools, toAnthropicTools, toGoogleTools } = require('../tools') as {
  executeTool: (name: string, args: Record<string, unknown>, config?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  toOpenAITools: (enabledToolNames?: string[] | null) => Record<string, unknown>[];
  toAnthropicTools: (enabledToolNames?: string[] | null) => Record<string, unknown>[];
  toGoogleTools: (enabledToolNames?: string[] | null) => Record<string, unknown>[];
};
const config = require('../config') as import('../types').AppConfig;
const { startSpan, endSpan, preview } = require('../tracing') as typeof import('../tracing');
const { recordSpan } = require('../tracing/collector') as typeof import('../tracing/collector');

// ─── Fail-fast constants and helpers ────────────────────
const MAX_TOOL_FAILURES = 3;
const PERM_FAIL = 999;

/** Patterns that indicate a non-transient (permanent) error — retrying won't help. */
const NON_TRANSIENT_PATTERNS = [
  'Contract signature invalid',
  'Contract rejected',
  'contract_rejected',
  'signature_invalid',
  // Bridge / capability resolution failures. These cannot succeed on retry
  // within a turn — the target or capability simply does not exist here. Left
  // transient, a model that hallucinates a target (e.g. bridging to a
  // non-existent "financial_plan") retries it across tool rounds, re-composing
  // its full answer each round (user sees the report duplicated). Marking them
  // permanent blocks the bad key after the first attempt — per-target, so
  // healthy domains are unaffected.
  'No bridge found',
  'is not registered in this workspace',
  'is not available in this workspace',
];
const NON_TRANSIENT_STATUS_CODES = [401, 403];

function isNonTransientError(resultStr: string): boolean {
  for (const pat of NON_TRANSIENT_PATTERNS) {
    if (resultStr.includes(pat)) return true;
  }
  // Check for HTTP status codes in common error shapes
  for (const code of NON_TRANSIENT_STATUS_CODES) {
    if (resultStr.includes(`"status":${code}`) || resultStr.includes(`"status": ${code}`)
        || resultStr.includes(`"statusCode":${code}`) || resultStr.includes(`"statusCode": ${code}`)
        || resultStr.includes(`(${code})`) || resultStr.includes(`status ${code}`)) {
      return true;
    }
  }
  return false;
}

function isToolError(result: Record<string, unknown>): boolean {
  return !!(result.error || result.errors || (result as Record<string, unknown>).message?.toString().toLowerCase().includes('error'));
}

/**
 * Check a tool result for errors and update the failure map.
 * Returns the number of failures for this tool after the check.
 */
function checkToolResult(toolName: string, result: Record<string, unknown>, toolFailures: Map<string, { count: number; lastError: string }>): number {
  const resultStr = JSON.stringify(result);
  if (!isToolError(result)) return 0; // success — don't reset count, just don't increment

  const entry = toolFailures.get(toolName) || { count: 0, lastError: '' };

  if (isNonTransientError(resultStr)) {
    // Permanent failure — never retry
    entry.count = PERM_FAIL;
    entry.lastError = resultStr.slice(0, 500);
    toolFailures.set(toolName, entry);
    console.warn(`[aiProvider] Tool '${toolName}' permanently failed (non-transient): ${entry.lastError.slice(0, 200)}`);
    return PERM_FAIL;
  }

  entry.count += 1;
  entry.lastError = resultStr.slice(0, 500);
  toolFailures.set(toolName, entry);
  if (entry.count >= MAX_TOOL_FAILURES) {
    console.warn(`[aiProvider] Tool '${toolName}' has failed ${entry.count} times — will not be retried`);
  }
  return entry.count;
}

/** Build a human-readable error message to inject as a tool result when a tool is blocked. */
function blockedToolMessage(toolName: string, toolFailures: Map<string, { count: number; lastError: string }>): string {
  const entry = toolFailures.get(toolName);
  const reason = entry && entry.count >= PERM_FAIL
    ? `permanently failed due to a non-transient error`
    : `failed ${entry?.count ?? '?'} times (max ${MAX_TOOL_FAILURES})`;
  return `Tool "${toolName}" has been disabled because it ${reason}. Last error: ${entry?.lastError || 'unknown'}. Do NOT call this tool again — answer the user with the information you already have, or explain what went wrong.`;
}

/**
 * Circuit-breaker key for a tool call. Every cross-workspace call uses the tool
 * name "intent_bridge", so keying the failure counter on the bare name lets a
 * few unreachable targets trip the breaker (MAX_TOOL_FAILURES) and block calls
 * to *healthy* targets for the rest of the turn. Scope the key by target
 * workspace so each domain fails (and is blocked) independently.
 */
function breakerKey(toolName: string, rawArgs: unknown): string {
  if (toolName !== 'intent_bridge') return toolName;
  let a: any = rawArgs;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { return toolName; }
  }
  const target = a && (a.target ?? a.targetWorkspace ?? a.workspace);
  return target ? `intent_bridge:${target}` : toolName;
}

/**
 * Detect a "preamble-only" answer: the model rendered charts / did tool work
 * but wrote almost no user-facing prose (e.g. "I'll pull together a health
 * check…" + charts, then stopped). Strips chart fences and the follow-ups
 * comment so only real analysis prose counts.
 */
function isPreambleOnly(fullText: string): boolean {
  const prose = fullText
    .replace(/```chart[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const renderedSomething = /```chart|"chartType"/.test(fullText);
  return renderedSomething && prose.length < 400;
}

const COMPOSE_NUDGE =
  'You rendered charts/data but have not written your analysis yet. Write the COMPLETE written financial analysis for the user NOW — findings, numbers, tables, and recommendations — followed by the follow_ups comment. Do not call any more tools.';

// Minimal type for the @google/genai client
interface GoogleGenAIClient {
  models: {
    generateContentStream(opts: Record<string, unknown>): Promise<AsyncIterable<GoogleGenAIChunk>>;
  };
}

interface GoogleGenAIChunk {
  text?: string;
  functionCalls?: GoogleFunctionCall[];
  candidates?: Array<{
    content?: {
      parts?: Record<string, unknown>[];
    };
  }>;
  usageMetadata?: GoogleUsageMetadata;
}

/**
 * Stream a completion from the specified AI provider, with tool-use loop.
 * Yields events:
 *   { type: 'text-delta', content: '...' }
 *   { type: 'tool-call', name: '...', args: {...}, callId: '...' }
 *   { type: 'tool-result', name: '...', callId: '...', result: {...} }
 *   { type: 'usage', promptTokens, completionTokens, totalTokens }
 *   { type: 'done', fullText: '...' }
 *   { type: 'error', error: '...' }
 *
 * @param {string} provider
 * @param {string} model
 * @param {Array} messages
 * @param {string} apiKey
 * @param {boolean} enableTools
 * @param {AbortSignal|null} signal — optional AbortSignal for cancellation
 * @param {string[]|null} enabledToolNames — optional tool allowlist; null = all tools
 * @param {object} [workspaceConfig] — per-workspace config { dataSources: {...} }
 */
async function* streamCompletion(provider: string, model: string, messages: ChatMessage[], apiKey: string, enableTools: boolean = true, signal: AbortSignal | null = null, enabledToolNames: string[] | null = null, workspaceConfig: WorkspaceConfig = {}): AsyncGenerator<StreamEvent> {
  const maxToolRounds: number = 10;

  // ── Distributed tracing: parent span for full LLM interaction ──
  const traceCtx = workspaceConfig?.traceContext;
  const llmSpan = traceCtx ? startSpan({
    traceId: traceCtx.traceId,
    parentSpanId: traceCtx.spanId || null,
    workspaceId: workspaceConfig?.workspaceId || '',
    workspaceName: workspaceConfig?.workspaceName || '',
    operation: 'llm.completion',
    toolName: `${provider}/${model}`,
    sampled: traceCtx.sampled,
  }) : null;
  if (llmSpan) workspaceConfig._llmSpan = llmSpan;

  try {
    switch (provider) {
      case 'openai':
        yield* streamOpenAI(model, messages, apiKey, enableTools, maxToolRounds, signal, enabledToolNames, workspaceConfig);
        break;
      case 'anthropic':
        yield* streamAnthropic(model, messages, apiKey, enableTools, maxToolRounds, signal, enabledToolNames, workspaceConfig);
        break;
      case 'google':
        yield* streamGoogle(model, messages, apiKey, enableTools, maxToolRounds, signal, enabledToolNames, workspaceConfig);
        break;
      case 'vertexai':
      case 'gemini-enterprise':
        yield* streamVertexAI(model, messages, enableTools, maxToolRounds, signal, enabledToolNames, workspaceConfig);
        break;
      case 'ollama':
        yield* streamOllama(model, messages, enableTools, maxToolRounds, signal, enabledToolNames, workspaceConfig);
        break;
      default:
        yield { type: 'error', error: `Unknown provider: ${provider}` };
    }
  } catch (err: unknown) {
    const error = err as Error & { name: string };
    if (error.name === 'AbortError') {
      if (llmSpan) { endSpan(llmSpan, 'completed', { metadata: { aborted: true, provider, model } }); recordSpan(llmSpan); }
      yield { type: 'done', fullText: '' };
    } else {
      if (llmSpan) { endSpan(llmSpan, 'error', { outputPreview: preview(error.message), metadata: { provider, model } }); recordSpan(llmSpan); }
      yield { type: 'error', error: error.message };
    }
  }
}

// ─── OpenAI ─────────────────────────────────────────────

async function* streamOpenAI(model: string, messages: ChatMessage[], apiKey: string, enableTools: boolean, maxRounds: number, signal: AbortSignal | null, enabledToolNames: string[] | null, workspaceConfig: WorkspaceConfig = {}): AsyncGenerator<StreamEvent> {
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
      body.tools = toOpenAITools(enabledToolNames);
      body.tool_choice = 'auto';
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

    const { toolCalls, text, usage } = yield* parseOpenAIStream(response, signal);
    fullText += text;

    // Emit usage if available
    if (usage) {
      yield { type: 'usage', promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens };
    }

    if (toolCalls.length === 0) {
      // Anti-preamble guard: the model sometimes ends its turn after only an
      // opening line + charts, never writing the analysis. If it terminates
      // with a preamble-only answer, nudge it ONCE (tools off) to compose the
      // full written analysis rather than shipping a broken half-answer.
      if (!composeNudged && round < maxRounds - 1 && isPreambleOnly(fullText)) {
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

    // Execute tools and add results
    for (const tc of toolCalls) {
      // ── Fail-fast: skip tools that have exceeded the failure threshold ──
      const _bkey = breakerKey(tc.name, tc.arguments);
      const priorFailures = toolFailures.get(_bkey);
      if (priorFailures && priorFailures.count >= MAX_TOOL_FAILURES) {
        const errorMsg = blockedToolMessage(_bkey, toolFailures);
        yield { type: 'tool-call', name: tc.name, args: JSON.parse(tc.arguments), callId: tc.id };
        yield { type: 'tool-result', name: tc.name, callId: tc.id, result: { error: errorMsg } };
        currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: errorMsg }) });
        continue;
      }

      yield { type: 'tool-call', name: tc.name, args: JSON.parse(tc.arguments), callId: tc.id };

      const toolStart = Date.now();
      const _io = (global as any)._io;
      const _wsId = workspaceConfig?.workspaceId;
      const configWithProgress = {
        ...workspaceConfig, model,
        _onProgress: _io && _wsId ? (step: string, label: string, state: string, opts?: any) => {
          _io.to(`ws:${_wsId}`).emit('ai-status', { step, label, state, ...opts });
        } : undefined,
      };
      const result: Record<string, unknown> = await executeTool(tc.name, JSON.parse(tc.arguments), configWithProgress);
      const toolDurationMs = Date.now() - toolStart;
      if (traceCtx) {
        const toolSpan = startSpan({ traceId: traceCtx.traceId, parentSpanId: llmSpan?.spanId || traceCtx.spanId, workspaceId: workspaceConfig?.workspaceId || '', workspaceName: workspaceConfig?.workspaceName || '', operation: 'tool_execution', toolName: tc.name, inputPreview: preview(tc.arguments), sampled: traceCtx.sampled });
        toolSpan._startTime = toolStart;
        endSpan(toolSpan, 'completed', { outputPreview: preview(JSON.stringify(result)), metadata: { durationMs: toolDurationMs } });
        recordSpan(toolSpan);
      }
      yield { type: 'tool-result', name: tc.name, callId: tc.id, result };

      // ── Track failures ──
      checkToolResult(_bkey, result, toolFailures);

      currentMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  console.warn(`[OpenAI] Exhausted ${maxRounds} tool rounds`);
  if (llmSpan) { endSpan(llmSpan, 'completed', { metadata: { rounds: maxRounds, provider: 'openai', model } }); recordSpan(llmSpan); }
  yield { type: 'done', fullText: fullText || `I was unable to complete your request after ${maxRounds} tool-call rounds. Some tools may have encountered errors. Please try again or simplify your query.` };
}

async function* parseOpenAIStream(response: NodeFetchResponse, signal: AbortSignal | null): AsyncGenerator<StreamEvent, { toolCalls: OpenAIToolCall[]; text: string; usage: OpenAIUsage | null }> {
  const toolCalls: OpenAIToolCall[] = [];
  let text: string = '';
  let usage: OpenAIUsage | null = null;

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
      if (data === '[DONE]') continue;

      try {
        const parsed: Record<string, unknown> = JSON.parse(data);
        const choices = parsed.choices as Array<{ delta?: Record<string, unknown> }> | undefined;
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

  return { toolCalls: toolCalls.filter(Boolean), text, usage };
}

// ─── Anthropic ──────────────────────────────────────────

async function* streamAnthropic(model: string, messages: ChatMessage[], apiKey: string, enableTools: boolean, maxRounds: number, signal: AbortSignal | null, enabledToolNames: string[] | null, workspaceConfig: WorkspaceConfig = {}): AsyncGenerator<StreamEvent> {
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
      body.tools = toAnthropicTools(enabledToolNames);
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
      const priorFailures = toolFailures.get(_bkey);
      if (priorFailures && priorFailures.count >= MAX_TOOL_FAILURES) {
        const errorMsg = blockedToolMessage(_bkey, toolFailures);
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
      const result: Record<string, unknown> = await executeTool(tu.name, tu.input, configWithProgress);
      const toolDurationMs = Date.now() - toolStart;
      if (traceCtx) {
        const toolSpan = startSpan({ traceId: traceCtx.traceId, parentSpanId: llmSpan?.spanId || traceCtx.spanId, workspaceId: workspaceConfig?.workspaceId || '', workspaceName: workspaceConfig?.workspaceName || '', operation: 'tool_execution', toolName: tu.name, inputPreview: preview(JSON.stringify(tu.input)), sampled: traceCtx.sampled });
        toolSpan._startTime = toolStart;
        endSpan(toolSpan, 'completed', { outputPreview: preview(JSON.stringify(result)), metadata: { durationMs: toolDurationMs } });
        recordSpan(toolSpan);
      }
      yield { type: 'tool-result', name: tu.name, callId: tu.id, result };

      // ── Track failures ──
      checkToolResult(_bkey, result, toolFailures);

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

// ─── Google / Gemini ────────────────────────────────────

async function* streamGoogle(model: string, messages: ChatMessage[], apiKey: string, enableTools: boolean, maxRounds: number, signal: AbortSignal | null, enabledToolNames: string[] | null, workspaceConfig: WorkspaceConfig = {}): AsyncGenerator<StreamEvent> {
  const traceCtx = workspaceConfig?.traceContext;
  const llmSpan = workspaceConfig?._llmSpan || null;
  const contents: Record<string, unknown>[] = formatGoogleMessages(messages);
  const systemInstruction: string = extractGoogleSystemInstruction(messages);
  let fullText: string = '';
  const toolFailures = new Map<string, { count: number; lastError: string }>();

  for (let round: number = 0; round < maxRounds; round++) {
    if (signal?.aborted) { yield { type: 'done', fullText }; return; }

    const body: Record<string, unknown> = {
      contents,
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    if (enableTools && round < maxRounds - 1) {
      body.tools = toGoogleTools(enabledToolNames);
    }

    const url: string = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;

    const response: NodeFetchResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal as AbortSignal | undefined,
    });

    if (!response.ok) {
      const errText: string = await response.text();
      yield { type: 'error', error: `Google AI error (${response.status}): ${errText}` };
      return;
    }

    const { functionCalls, text, usage } = yield* parseGoogleStream(response, signal);
    fullText += text;

    // Emit usage if available
    if (usage) {
      yield { type: 'usage', promptTokens: usage.promptTokenCount, completionTokens: usage.candidatesTokenCount, totalTokens: usage.totalTokenCount };
    }

    if (functionCalls.length === 0) {
      if (llmSpan) { endSpan(llmSpan, 'completed', { metadata: { rounds: round + 1, provider: 'google', model } }); recordSpan(llmSpan); }
      yield { type: 'done', fullText };
      return;
    }

    // Add model response with function calls
    contents.push({
      role: 'model',
      parts: functionCalls.map((fc: GoogleFunctionCall) => ({
        functionCall: { name: fc.name, args: fc.args },
      })),
    });

    // Execute tools in parallel when multiple calls are emitted
    const callIds = functionCalls.map((fc: GoogleFunctionCall) => {
      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${fc.name}`;
      return callId;
    });

    // Yield all tool-call events first — but mark blocked tools
    for (let i = 0; i < functionCalls.length; i++) {
      yield { type: 'tool-call', name: functionCalls[i].name, args: functionCalls[i].args, callId: callIds[i] };
    }

    // Execute tools in parallel, skipping blocked ones
    const toolResults = await Promise.all(
      functionCalls.map(async (fc: GoogleFunctionCall, i: number) => {
        // ── Fail-fast: skip tools that have exceeded the failure threshold ──
        const _bkey = breakerKey(fc.name, fc.args);
        const priorFailures = toolFailures.get(_bkey);
        if (priorFailures && priorFailures.count >= MAX_TOOL_FAILURES) {
          const errorMsg = blockedToolMessage(_bkey, toolFailures);
          return { fc, callId: callIds[i], result: { error: errorMsg } as Record<string, unknown> };
        }

        const toolStart = Date.now();
        const _io = (global as any)._io;
        const _wsId = workspaceConfig?.workspaceId;
        const configWithProgress = {
          ...workspaceConfig, model,
          _onProgress: _io && _wsId ? (step: string, label: string, state: string, opts?: any) => {
            _io.to(`ws:${_wsId}`).emit('ai-status', { step, label, state, ...opts });
          } : undefined,
        };
        const result = await executeTool(fc.name, fc.args, configWithProgress);
        const toolDurationMs = Date.now() - toolStart;
        if (traceCtx) {
          const toolSpan = startSpan({ traceId: traceCtx.traceId, parentSpanId: llmSpan?.spanId || traceCtx.spanId, workspaceId: workspaceConfig?.workspaceId || '', workspaceName: workspaceConfig?.workspaceName || '', operation: 'tool_execution', toolName: fc.name, inputPreview: preview(JSON.stringify(fc.args)), sampled: traceCtx.sampled });
          toolSpan._startTime = toolStart;
          endSpan(toolSpan, 'completed', { outputPreview: preview(JSON.stringify(result)), metadata: { durationMs: toolDurationMs } });
          recordSpan(toolSpan);
        }

        // ── Track failures ──
        checkToolResult(_bkey, result, toolFailures);

        return { fc, callId: callIds[i], result };
      })
    );

    // Yield results and build response parts
    const functionResponses: Record<string, unknown>[] = [];
    for (const { fc, callId, result } of toolResults) {
      yield { type: 'tool-result', name: fc.name, callId, result };
      functionResponses.push({
        functionResponse: { name: fc.name, response: result },
      });
    }

    contents.push({ role: 'user', parts: functionResponses });
  }

  console.warn(`[Google] Exhausted ${maxRounds} tool rounds`);
  if (llmSpan) { endSpan(llmSpan, 'completed', { metadata: { rounds: maxRounds, provider: 'google', model } }); recordSpan(llmSpan); }
  yield { type: 'done', fullText: fullText || `I was unable to complete your request after ${maxRounds} tool-call rounds. Some tools may have encountered errors. Please try again or simplify your query.` };
}

async function* parseGoogleStream(response: NodeFetchResponse, signal: AbortSignal | null): AsyncGenerator<StreamEvent, { functionCalls: GoogleFunctionCall[]; text: string; usage: GoogleUsageMetadata | null }> {
  const functionCalls: GoogleFunctionCall[] = [];
  let text: string = '';
  let usage: GoogleUsageMetadata | null = null;

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
        const candidates = parsed.candidates as Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }> } }> | undefined;
        const parts = candidates?.[0]?.content?.parts || [];

        for (const part of parts) {
          if (part.text) {
            text += part.text;
            yield { type: 'text-delta', content: part.text };
          }
          if (part.functionCall) {
            functionCalls.push({
              name: part.functionCall.name,
              args: part.functionCall.args || {},
            });
          }
        }

        // Capture usage metadata from Google response
        if (parsed.usageMetadata) {
          usage = parsed.usageMetadata as GoogleUsageMetadata;
        }
      } catch {
        // Skip
      }
    }
  }

  return { functionCalls, text, usage };
}

// ─── Ollama / OpenAI-compatible ─────────────────────────

async function* streamOllama(model: string, messages: ChatMessage[], enableTools: boolean, maxRounds: number, signal: AbortSignal | null, enabledToolNames: string[] | null, workspaceConfig: WorkspaceConfig = {}): AsyncGenerator<StreamEvent> {
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
      const tools: Record<string, unknown>[] = toOpenAITools(enabledToolNames);
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

    // Execute tools and add results
    for (const tc of toolCalls) {
      // ── Fail-fast: skip tools that have exceeded the failure threshold ──
      const _bkey = breakerKey(tc.name, tc.arguments);
      const priorFailures = toolFailures.get(_bkey);
      if (priorFailures && priorFailures.count >= MAX_TOOL_FAILURES) {
        const errorMsg = blockedToolMessage(_bkey, toolFailures);
        yield { type: 'tool-call', name: tc.name, args: JSON.parse(tc.arguments), callId: tc.id };
        yield { type: 'tool-result', name: tc.name, callId: tc.id, result: { error: errorMsg } };
        currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: errorMsg }) });
        continue;
      }

      yield { type: 'tool-call', name: tc.name, args: JSON.parse(tc.arguments), callId: tc.id };

      const toolStart = Date.now();
      const _io = (global as any)._io;
      const _wsId = workspaceConfig?.workspaceId;
      const configWithProgress = {
        ...workspaceConfig, model,
        _onProgress: _io && _wsId ? (step: string, label: string, state: string, opts?: any) => {
          _io.to(`ws:${_wsId}`).emit('ai-status', { step, label, state, ...opts });
        } : undefined,
      };
      const result: Record<string, unknown> = await executeTool(tc.name, JSON.parse(tc.arguments), configWithProgress);
      const toolDurationMs = Date.now() - toolStart;
      if (traceCtx) {
        const toolSpan = startSpan({ traceId: traceCtx.traceId, parentSpanId: llmSpan?.spanId || traceCtx.spanId, workspaceId: workspaceConfig?.workspaceId || '', workspaceName: workspaceConfig?.workspaceName || '', operation: 'tool_execution', toolName: tc.name, inputPreview: preview(tc.arguments), sampled: traceCtx.sampled });
        toolSpan._startTime = toolStart;
        endSpan(toolSpan, 'completed', { outputPreview: preview(JSON.stringify(result)), metadata: { durationMs: toolDurationMs } });
        recordSpan(toolSpan);
      }
      yield { type: 'tool-result', name: tc.name, callId: tc.id, result };

      // ── Track failures ──
      checkToolResult(_bkey, result, toolFailures);

      currentMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  console.warn(`[Ollama] Exhausted ${maxRounds} tool rounds`);
  if (llmSpan) { endSpan(llmSpan, 'completed', { metadata: { rounds: maxRounds, provider: 'ollama', model } }); recordSpan(llmSpan); }
  yield { type: 'done', fullText: fullText || `I was unable to complete your request after ${maxRounds} tool-call rounds. Some tools may have encountered errors. Please try again or simplify your query.` };
}

// ─── Helpers ────────────────────────────────────────────

function extractSystemPrompt(messages: ChatMessage[]): string {
  const sys: ChatMessage | undefined = messages.find((m: ChatMessage) => m.role === 'system');
  return sys ? sys.content : '';
}

function formatAnthropicMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages
    .filter((m: ChatMessage) => m.role !== 'system')
    .map((m: ChatMessage) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
}

function extractGoogleSystemInstruction(messages: ChatMessage[]): string {
  const sys: ChatMessage | undefined = messages.find((m: ChatMessage) => m.role === 'system');
  return sys ? sys.content : '';
}

function formatGoogleMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages
    .filter((m: ChatMessage) => m.role !== 'system')
    .map((m: ChatMessage) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}

// ─── Vertex AI (Google Cloud ADC) — @google/genai SDK ───

let genaiRegionalClient: GoogleGenAIClient | null = null;
let genaiGlobalClient: GoogleGenAIClient | null = null;

// ─── 429 Fallback State ─────────────────────────────────────────────────────
const FALLBACK_MODEL = 'gemini-3.5-flash';
const FALLBACK_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
let rateLimitedUntil: number = 0;
let rateLimitOriginalModel: string | null = null;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

function isRateLimited(): boolean {
  return Date.now() < rateLimitedUntil;
}

function activateFallback(originalModel: string): void {
  rateLimitedUntil = Date.now() + FALLBACK_COOLDOWN_MS;
  rateLimitOriginalModel = originalModel;
  console.warn(`[VertexAI] 429 on ${originalModel} — falling back to ${FALLBACK_MODEL} for ${FALLBACK_COOLDOWN_MS / 1000}s`);
  if (cooldownTimer) clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(() => {
    console.log(`[VertexAI] Cooldown expired — restoring ${rateLimitOriginalModel}`);
    rateLimitedUntil = 0;
    rateLimitOriginalModel = null;
    cooldownTimer = null;
  }, FALLBACK_COOLDOWN_MS);
}

function is429Error(err: unknown): boolean {
  const msg = String((err as Error)?.message || err);
  return msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Resource exhausted');
}

/**
 * Preview models (e.g. gemini-3.1-pro-preview) and newest generation models
 * (gemini-3.5+) are only available on the global Vertex AI endpoint.
 * GA models use the regional endpoint.
 */
function getGenAIClient(model: string): GoogleGenAIClient {
  const project: string = config.vertexai.project;
  if (!project) throw new Error('GCP_PROJECT not set. Required for Vertex AI.');

  // Models requiring the global endpoint: preview models and gemini-3.5+
  const needsGlobal: boolean = !!(model && (
    model.includes('-preview') ||
    /^gemini-(?:[3-9]\.[5-9]|[4-9]\.|[1-9]\d+\.)/.test(model)
  ));

  if (needsGlobal) {
    if (!genaiGlobalClient) {
      genaiGlobalClient = new GoogleGenAI({
        vertexai: true,
        project,
        location: 'global',
      });
    }
    return genaiGlobalClient;
  }

  if (!genaiRegionalClient) {
    const location: string = config.vertexai.location;
    genaiRegionalClient = new GoogleGenAI({
      vertexai: true,
      project,
      location,
    });
  }
  return genaiRegionalClient;
}

async function* streamVertexAI(model: string, messages: ChatMessage[], enableTools: boolean, maxRounds: number, signal: AbortSignal | null, enabledToolNames: string[] | null, workspaceConfig: WorkspaceConfig = {}): AsyncGenerator<StreamEvent> {
  const traceCtx = workspaceConfig?.traceContext;
  const llmSpan = workspaceConfig?._llmSpan || null;
  // Auto-fallback: if currently rate-limited, use Flash immediately
  let activeModel: string = isRateLimited() ? FALLBACK_MODEL : model;
  if (activeModel !== model) {
    console.log(`[VertexAI] Rate-limit cooldown active — using ${FALLBACK_MODEL} instead of ${model}`);
  }

  const ai: GoogleGenAIClient = getGenAIClient(activeModel);
  const systemInstruction: string = extractGoogleSystemInstruction(messages);
  const contents: Record<string, unknown>[] = formatGoogleMessages(messages);
  let fullText: string = '';
  const toolFailures = new Map<string, { count: number; lastError: string }>();
  const loopStartTime: number = Date.now();
  const TOOL_LOOP_TIMEOUT_MS: number = 120_000; // 120s wall-clock cap (fail-fast)

  for (let round: number = 0; round < maxRounds; round++) {
    if (signal?.aborted) { yield { type: 'done', fullText }; return; }
    if (Date.now() - loopStartTime > TOOL_LOOP_TIMEOUT_MS) {
      console.warn(`[VertexAI] Tool loop exceeded ${TOOL_LOOP_TIMEOUT_MS}ms wall-clock limit after ${round} rounds`);
      yield { type: 'done', fullText: fullText || 'I ran out of time processing your request. Please try a simpler query.' };
      return;
    }

    const requestConfig: Record<string, unknown> = {};
    if (systemInstruction) {
      requestConfig.systemInstruction = systemInstruction;
    }
    if (enableTools && round < maxRounds - 1) {
      requestConfig.tools = toGoogleTools(enabledToolNames);
    }

    let stream: AsyncIterable<GoogleGenAIChunk>;
    try {
      stream = await ai.models.generateContentStream({
        model: activeModel,
        contents,
        config: requestConfig,
      });
    } catch (err: unknown) {
      // On 429, fall back to Flash and retry this round
      if (is429Error(err) && activeModel !== FALLBACK_MODEL) {
        activateFallback(model);
        activeModel = FALLBACK_MODEL;
        const fallbackAi = getGenAIClient(FALLBACK_MODEL);
        yield { type: 'text-delta', content: '⚡ _Switching to faster model due to high demand..._\n\n' };
        stream = await fallbackAi.models.generateContentStream({
          model: FALLBACK_MODEL,
          contents,
          config: requestConfig,
        });
      } else {
        throw err;
      }
    }

    let text: string = '';
    const functionCalls: GoogleFunctionCall[] = [];
    const rawModelParts: Record<string, unknown>[] = []; // Preserve original parts for thought_signature support
    let usageMetadata: GoogleUsageMetadata | null = null;

    for await (const chunk of stream) {
      if (signal?.aborted) break;

      // New SDK exposes .text and .functionCalls directly on the chunk
      if (chunk.text) {
        text += chunk.text;
        yield { type: 'text-delta', content: chunk.text };
      }

      if (chunk.functionCalls) {
        for (const fc of chunk.functionCalls) {
          functionCalls.push({
            name: fc.name,
            args: fc.args || {},
          });
        }
      }

      // Preserve raw parts from each chunk (includes thought_signature for Gemini 3.1+)
      const candidateParts: Record<string, unknown>[] | undefined = chunk.candidates?.[0]?.content?.parts;
      if (candidateParts) {
        rawModelParts.push(...candidateParts);
      }

      // Capture usage metadata (typically on the last chunk)
      if (chunk.usageMetadata) {
        usageMetadata = chunk.usageMetadata;
      }
    }

    if (signal?.aborted) { yield { type: 'done', fullText: fullText + text }; return; }
    fullText += text;

    // Emit usage if available
    if (usageMetadata) {
      yield {
        type: 'usage',
        promptTokens: usageMetadata.promptTokenCount || 0,
        completionTokens: usageMetadata.candidatesTokenCount || 0,
        totalTokens: usageMetadata.totalTokenCount || 0,
      };
    }

    if (functionCalls.length === 0) {
      if (llmSpan) { endSpan(llmSpan, 'completed', { metadata: { rounds: round + 1, provider: 'vertexai', model: activeModel } }); recordSpan(llmSpan); }
      yield { type: 'done', fullText };
      return;
    }

    // Add model response preserving original parts (includes thought_signature)
    contents.push({
      role: 'model',
      parts: rawModelParts.length > 0 ? rawModelParts : functionCalls.map((fc: GoogleFunctionCall) => ({
        functionCall: { name: fc.name, args: fc.args },
      })),
    });

    // Execute tools in parallel when multiple calls are emitted
    const callIds = functionCalls.map((fc: GoogleFunctionCall) => {
      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${fc.name}`;
      return callId;
    });

    // Yield all tool-call events first
    for (let i = 0; i < functionCalls.length; i++) {
      yield { type: 'tool-call', name: functionCalls[i].name, args: functionCalls[i].args, callId: callIds[i] };
    }

    // Execute all tools in parallel, skipping blocked ones
    const toolResults = await Promise.all(
      functionCalls.map(async (fc: GoogleFunctionCall, i: number) => {
        // ── Fail-fast: skip tools that have exceeded the failure threshold ──
        const _bkey = breakerKey(fc.name, fc.args);
        const priorFailures = toolFailures.get(_bkey);
        if (priorFailures && priorFailures.count >= MAX_TOOL_FAILURES) {
          const errorMsg = blockedToolMessage(_bkey, toolFailures);
          return { fc, callId: callIds[i], result: { error: errorMsg } as Record<string, unknown> };
        }

        console.log(`[aiProvider] Executing tool '${fc.name}' with args: ${JSON.stringify(fc.args)}`);
        const toolStart = Date.now();
        const _io = (global as any)._io;
        const _wsId = workspaceConfig?.workspaceId;
        const configWithProgress = {
          ...workspaceConfig, model,
          _onProgress: _io && _wsId ? (step: string, label: string, state: string, opts?: any) => {
            _io.to(`ws:${_wsId}`).emit('ai-status', { step, label, state, ...opts });
          } : undefined,
        };
        const result = await executeTool(fc.name, fc.args, configWithProgress);
        const toolDurationMs = Date.now() - toolStart;
        console.log(`[aiProvider] Tool '${fc.name}' completed with length ${JSON.stringify(result)?.length || 0}`);
        if (traceCtx) {
          const toolSpan = startSpan({ traceId: traceCtx.traceId, parentSpanId: llmSpan?.spanId || traceCtx.spanId, workspaceId: workspaceConfig?.workspaceId || '', workspaceName: workspaceConfig?.workspaceName || '', operation: 'tool_execution', toolName: fc.name, inputPreview: preview(JSON.stringify(fc.args)), sampled: traceCtx.sampled });
          toolSpan._startTime = toolStart;
          endSpan(toolSpan, 'completed', { outputPreview: preview(JSON.stringify(result)), metadata: { durationMs: toolDurationMs } });
          recordSpan(toolSpan);
        }

        // ── Track failures ──
        checkToolResult(_bkey, result, toolFailures);

        return { fc, callId: callIds[i], result };
      })
    );

    // Yield results and build response parts
    const functionResponses: Record<string, unknown>[] = [];
    for (const { fc, callId, result } of toolResults) {
      yield { type: 'tool-result', name: fc.name, callId, result };
      functionResponses.push({
        functionResponse: { name: fc.name, response: result },
      });
    }

    contents.push({ role: 'user', parts: functionResponses });
  }

  console.warn(`[VertexAI] Exhausted ${maxRounds} tool rounds`);
  if (llmSpan) { endSpan(llmSpan, 'completed', { metadata: { rounds: maxRounds, provider: 'vertexai', model: activeModel } }); recordSpan(llmSpan); }
  yield { type: 'done', fullText: fullText || `I was unable to complete your request after ${maxRounds} tool-call rounds. Some tools may have encountered errors. Please try again or simplify your query.` };
}

module.exports = { streamCompletion };
