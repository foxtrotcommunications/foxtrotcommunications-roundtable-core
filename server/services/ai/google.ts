// server/services/ai/google.ts — Google AI Studio (API-key) Gemini streaming
// + tool loop. Bodies moved verbatim from aiProvider.ts (Phase 6.1 split).
// The Vertex AI (ADC) path lives in ./vertexai.ts.
import type { StreamEvent, GoogleFunctionCall, GoogleUsageMetadata, WorkspaceConfig, ChatMessage, ToolProfile } from '../../types';
import type { Response as NodeFetchResponse } from 'node-fetch';
import { runWorkspaceTool, checkToolResult, blockedToolMessage, breakerKey, fineBreakerKey, trippedBreakerKey } from './loop';
import { extractGoogleSystemInstruction, formatGoogleMessages } from './format';

const fetch = require('node-fetch') as typeof import('node-fetch').default;
const { toGoogleTools } = require('../../tools') as {
  toGoogleTools: (enabledToolNames?: string[] | null, profile?: ToolProfile) => Record<string, unknown>[];
};
const { startSpan, endSpan, preview } = require('../../tracing') as typeof import('../../tracing');
const { recordSpan } = require('../../tracing/collector') as typeof import('../../tracing/collector');

// ─── Google / Gemini ────────────────────────────────────

export async function* streamGoogle(model: string, messages: ChatMessage[], apiKey: string, enableTools: boolean, maxRounds: number, signal: AbortSignal | null, enabledToolNames: string[] | null, workspaceConfig: WorkspaceConfig = {}): AsyncGenerator<StreamEvent> {
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
      body.tools = toGoogleTools(enabledToolNames, workspaceConfig?.toolProfile);
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
        const _fkey = fineBreakerKey(fc.name, fc.args);
        const _tripped = trippedBreakerKey(fc.name, fc.args, toolFailures);
        if (_tripped) {
          const errorMsg = blockedToolMessage(_tripped, toolFailures);
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
        const result = await runWorkspaceTool(fc.name, fc.args, configWithProgress, enabledToolNames);
        const toolDurationMs = Date.now() - toolStart;
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
