// server/services/ai/index.ts — Unified multi-provider AI interface with tool
// support. streamCompletion dispatches to one provider module per vendor;
// the shared tool loop lives in ./loop.ts. Split out of aiProvider.ts in
// Phase 6.1 (pure move); server/services/aiProvider.ts re-exports from here.
import type { StreamEvent, WorkspaceConfig, ChatMessage } from '../../types';
import { streamOpenAI } from './openai';
import { streamAnthropic } from './anthropic';
import { streamGoogle } from './google';
import { streamVertexAI } from './vertexai';
import { streamOllama } from './ollama';

const { startSpan, endSpan, preview } = require('../../tracing') as typeof import('../../tracing');
const { recordSpan } = require('../../tracing/collector') as typeof import('../../tracing/collector');

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
 * @param {string[]|null} enabledToolNames — optional tool allowlist; null = default profile (registry minus dangerous tools)
 * @param {object} [workspaceConfig] — per-workspace config { dataSources: {...} }
 */
export async function* streamCompletion(provider: string, model: string, messages: ChatMessage[], apiKey: string, enableTools: boolean = true, signal: AbortSignal | null = null, enabledToolNames: string[] | null = null, workspaceConfig: WorkspaceConfig = {}): AsyncGenerator<StreamEvent> {
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
