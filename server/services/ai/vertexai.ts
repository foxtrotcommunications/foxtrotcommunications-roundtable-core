// server/services/ai/vertexai.ts — Vertex AI (Google Cloud ADC) streaming via
// the @google/genai SDK, with the 429 → Flash fallback. Bodies moved verbatim
// from aiProvider.ts (Phase 6.1 split).
import type { StreamEvent, GoogleFunctionCall, GoogleUsageMetadata, WorkspaceConfig, ChatMessage, ToolProfile } from '../../types';
import { runWorkspaceTool, checkToolResult, blockedToolMessage, breakerKey, fineBreakerKey, trippedBreakerKey } from './loop';
import { extractGoogleSystemInstruction, formatGoogleMessages } from './format';

const { GoogleGenAI } = require('@google/genai') as { GoogleGenAI: new (opts: Record<string, unknown>) => GoogleGenAIClient };
const { toGoogleTools } = require('../../tools') as {
  toGoogleTools: (enabledToolNames?: string[] | null, profile?: ToolProfile) => Record<string, unknown>[];
};
const config = require('../../config') as import('../../types').AppConfig;
const { startSpan, endSpan, preview } = require('../../tracing') as typeof import('../../tracing');
const { recordSpan } = require('../../tracing/collector') as typeof import('../../tracing/collector');

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

export async function* streamVertexAI(model: string, messages: ChatMessage[], enableTools: boolean, maxRounds: number, signal: AbortSignal | null, enabledToolNames: string[] | null, workspaceConfig: WorkspaceConfig = {}): AsyncGenerator<StreamEvent> {
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
      requestConfig.tools = toGoogleTools(enabledToolNames, workspaceConfig?.toolProfile);
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
        const _fkey = fineBreakerKey(fc.name, fc.args);
        const _tripped = trippedBreakerKey(fc.name, fc.args, toolFailures);
        if (_tripped) {
          const errorMsg = blockedToolMessage(_tripped, toolFailures);
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
        const result = await runWorkspaceTool(fc.name, fc.args, configWithProgress, enabledToolNames);
        const toolDurationMs = Date.now() - toolStart;
        console.log(`[aiProvider] Tool '${fc.name}' completed with length ${JSON.stringify(result)?.length || 0}`);
        if (traceCtx) {
          const toolSpan = startSpan({ traceId: traceCtx.traceId, parentSpanId: llmSpan?.spanId || traceCtx.spanId, workspaceId: workspaceConfig?.workspaceId || '', workspaceName: workspaceConfig?.workspaceName || '', operation: 'tool_execution', toolName: fc.name, inputPreview: preview(JSON.stringify(fc.args)), sampled: traceCtx.sampled });
          toolSpan._startTime = toolStart;
          endSpan(toolSpan, 'completed', { outputPreview: preview(JSON.stringify(result)), metadata: { durationMs: toolDurationMs } });
          recordSpan(toolSpan);
        }

        // ── Track failures ──
        checkToolResult(_bkey, result, toolFailures, _fkey);

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
