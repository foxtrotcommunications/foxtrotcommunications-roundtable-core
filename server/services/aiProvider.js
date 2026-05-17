// server/services/aiProvider.js — Unified multi-provider AI interface with tool support
const fetch = require('node-fetch');
const { GoogleGenAI } = require('@google/genai');
const { executeTool, toOpenAITools, toAnthropicTools, toGoogleTools } = require('../tools');
const config = require('../config');

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
async function* streamCompletion(provider, model, messages, apiKey, enableTools = true, signal = null, enabledToolNames = null, workspaceConfig = {}) {
  const maxToolRounds = 10;

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
        yield* streamVertexAI(model, messages, enableTools, maxToolRounds, signal, enabledToolNames, workspaceConfig);
        break;
      case 'ollama':
        yield* streamOllama(model, messages, enableTools, maxToolRounds, signal, enabledToolNames, workspaceConfig);
        break;
      default:
        yield { type: 'error', error: `Unknown provider: ${provider}` };
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      yield { type: 'done', fullText: '' };
    } else {
      yield { type: 'error', error: err.message };
    }
  }
}

// ─── OpenAI ─────────────────────────────────────────────

async function* streamOpenAI(model, messages, apiKey, enableTools, maxRounds, signal, enabledToolNames, workspaceConfig = {}) {
  let currentMessages = [...messages];
  let fullText = '';

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) { yield { type: 'done', fullText }; return; }

    const body = {
      model,
      messages: currentMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (enableTools && round < maxRounds - 1) {
      body.tools = toOpenAITools(enabledToolNames);
      body.tool_choice = 'auto';
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text();
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
      yield { type: 'done', fullText };
      return;
    }

    // Add assistant message with tool calls
    currentMessages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Execute tools and add results
    for (const tc of toolCalls) {
      yield { type: 'tool-call', name: tc.name, args: JSON.parse(tc.arguments), callId: tc.id };

      const result = await executeTool(tc.name, JSON.parse(tc.arguments), workspaceConfig);
      yield { type: 'tool-result', name: tc.name, callId: tc.id, result };

      currentMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  yield { type: 'done', fullText };
}

async function* parseOpenAIStream(response, signal) {
  const toolCalls = [];
  let text = '';
  let usage = null;

  const body = response.body;
  let buffer = '';

  for await (const chunk of body) {
    if (signal?.aborted) break;
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          text += delta.content;
          yield { type: 'text-delta', content: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
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
        if (parsed.usage) {
          usage = parsed.usage;
        }
      } catch (e) {
        // Skip malformed JSON
      }
    }
  }

  return { toolCalls: toolCalls.filter(Boolean), text, usage };
}

// ─── Anthropic ──────────────────────────────────────────

async function* streamAnthropic(model, messages, apiKey, enableTools, maxRounds, signal, enabledToolNames) {
  let currentMessages = formatAnthropicMessages(messages);
  let systemPrompt = extractSystemPrompt(messages);
  let fullText = '';

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) { yield { type: 'done', fullText }; return; }

    const body = {
      model,
      messages: currentMessages,
      max_tokens: 4096,
      stream: true,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (enableTools && round < maxRounds - 1) {
      body.tools = toAnthropicTools(enabledToolNames);
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text();
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
      yield { type: 'done', fullText };
      return;
    }

    // Build assistant content blocks
    const assistantContent = [];
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
    const toolResults = [];
    for (const tu of toolUses) {
      yield { type: 'tool-call', name: tu.name, args: tu.input, callId: tu.id };

      const result = await executeTool(tu.name, tu.input, workspaceConfig);
      yield { type: 'tool-result', name: tu.name, callId: tu.id, result };

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }

    currentMessages.push({ role: 'user', content: toolResults });
  }

  yield { type: 'done', fullText };
}

async function* parseAnthropicStream(response, signal) {
  const toolUses = [];
  let text = '';
  let stopReason = '';
  let currentToolUse = null;
  let currentToolJson = '';
  let usage = null;

  const body = response.body;
  let buffer = '';

  for await (const chunk of body) {
    if (signal?.aborted) break;
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);

      try {
        const parsed = JSON.parse(data);

        if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
          currentToolUse = {
            id: parsed.content_block.id,
            name: parsed.content_block.name,
            input: {},
          };
          currentToolJson = '';
        }

        if (parsed.type === 'content_block_delta') {
          if (parsed.delta?.type === 'text_delta') {
            text += parsed.delta.text;
            yield { type: 'text-delta', content: parsed.delta.text };
          }
          if (parsed.delta?.type === 'input_json_delta' && currentToolUse) {
            currentToolJson += parsed.delta.partial_json;
          }
        }

        if (parsed.type === 'content_block_stop' && currentToolUse) {
          try {
            currentToolUse.input = JSON.parse(currentToolJson);
          } catch (e) {
            currentToolUse.input = {};
          }
          toolUses.push(currentToolUse);
          currentToolUse = null;
          currentToolJson = '';
        }

        if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
          stopReason = parsed.delta.stop_reason;
        }

        // Capture usage from message_start and message_delta
        if (parsed.type === 'message_start' && parsed.message?.usage) {
          usage = { input_tokens: parsed.message.usage.input_tokens || 0, output_tokens: 0 };
        }
        if (parsed.type === 'message_delta' && parsed.usage) {
          if (usage) {
            usage.output_tokens = parsed.usage.output_tokens || 0;
          } else {
            usage = { input_tokens: 0, output_tokens: parsed.usage.output_tokens || 0 };
          }
        }
      } catch (e) {
        // Skip
      }
    }
  }

  return { toolUses, text, stopReason, usage };
}

// ─── Google / Gemini ────────────────────────────────────

async function* streamGoogle(model, messages, apiKey, enableTools, maxRounds, signal, enabledToolNames, workspaceConfig = {}) {
  let contents = formatGoogleMessages(messages);
  let systemInstruction = extractGoogleSystemInstruction(messages);
  let fullText = '';

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) { yield { type: 'done', fullText }; return; }

    const body = {
      contents,
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    if (enableTools && round < maxRounds - 1) {
      body.tools = toGoogleTools(enabledToolNames);
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text();
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
      yield { type: 'done', fullText };
      return;
    }

    // Add model response with function calls
    contents.push({
      role: 'model',
      parts: functionCalls.map((fc) => ({
        functionCall: { name: fc.name, args: fc.args },
      })),
    });

    // Execute tools and add responses
    const functionResponses = [];
    for (const fc of functionCalls) {
      const callId = `call_${Date.now()}_${fc.name}`;
      yield { type: 'tool-call', name: fc.name, args: fc.args, callId };

      const result = await executeTool(fc.name, fc.args, workspaceConfig);
      yield { type: 'tool-result', name: fc.name, callId, result };

      functionResponses.push({
        functionResponse: { name: fc.name, response: result },
      });
    }

    contents.push({ role: 'user', parts: functionResponses });
  }

  yield { type: 'done', fullText };
}

async function* parseGoogleStream(response, signal) {
  const functionCalls = [];
  let text = '';
  let usage = null;

  const body = response.body;
  let buffer = '';

  for await (const chunk of body) {
    if (signal?.aborted) break;
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);

      try {
        const parsed = JSON.parse(data);
        const parts = parsed.candidates?.[0]?.content?.parts || [];

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
          usage = parsed.usageMetadata;
        }
      } catch (e) {
        // Skip
      }
    }
  }

  return { functionCalls, text, usage };
}

// ─── Ollama / OpenAI-compatible ─────────────────────────

async function* streamOllama(model, messages, enableTools, maxRounds, signal, enabledToolNames, workspaceConfig = {}) {
  const host = (workspaceConfig.ollamaHost || config.ollama.host || 'http://localhost:11434').replace(/\/+$/, '');
  let currentMessages = [...messages];
  let fullText = '';

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) { yield { type: 'done', fullText }; return; }

    const body = {
      model,
      messages: currentMessages,
      stream: true,
    };

    if (enableTools && round < maxRounds - 1) {
      const tools = toOpenAITools(enabledToolNames);
      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }
    }

    let response;
    try {
      response = await fetch(`${host}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') { yield { type: 'done', fullText }; return; }
      yield { type: 'error', error: `Cannot reach Ollama at ${host}: ${err.message}` };
      return;
    }

    if (!response.ok) {
      const errText = await response.text();
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
      yield { type: 'done', fullText };
      return;
    }

    // Add assistant message with tool calls
    currentMessages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Execute tools and add results
    for (const tc of toolCalls) {
      yield { type: 'tool-call', name: tc.name, args: JSON.parse(tc.arguments), callId: tc.id };

      const result = await executeTool(tc.name, JSON.parse(tc.arguments), workspaceConfig);
      yield { type: 'tool-result', name: tc.name, callId: tc.id, result };

      currentMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  yield { type: 'done', fullText };
}

// ─── Helpers ────────────────────────────────────────────

function extractSystemPrompt(messages) {
  const sys = messages.find((m) => m.role === 'system');
  return sys ? sys.content : '';
}

function formatAnthropicMessages(messages) {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
}

function extractGoogleSystemInstruction(messages) {
  const sys = messages.find((m) => m.role === 'system');
  return sys ? sys.content : '';
}

function formatGoogleMessages(messages) {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}

// ─── Vertex AI (Google Cloud ADC) — @google/genai SDK ───

let genaiRegionalClient = null;
let genaiGlobalClient = null;

/**
 * Preview models (e.g. gemini-3.1-pro-preview) are only available on the
 * global Vertex AI endpoint. GA models use the regional endpoint.
 */
function getGenAIClient(model) {
  const project = config.vertexai.project;
  if (!project) throw new Error('GCP_PROJECT not set. Required for Vertex AI.');

  const isPreview = model && model.includes('-preview');

  if (isPreview) {
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
    const location = config.vertexai.location;
    genaiRegionalClient = new GoogleGenAI({
      vertexai: true,
      project,
      location,
    });
  }
  return genaiRegionalClient;
}

async function* streamVertexAI(model, messages, enableTools, maxRounds, signal, enabledToolNames, workspaceConfig = {}) {
  const ai = getGenAIClient(model);
  const systemInstruction = extractGoogleSystemInstruction(messages);
  const contents = formatGoogleMessages(messages);
  let fullText = '';

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) { yield { type: 'done', fullText }; return; }

    const requestConfig = {};
    if (systemInstruction) {
      requestConfig.systemInstruction = systemInstruction;
    }
    if (enableTools && round < maxRounds - 1) {
      requestConfig.tools = toGoogleTools(enabledToolNames);
    }

    const stream = await ai.models.generateContentStream({
      model,
      contents,
      config: requestConfig,
    });

    let text = '';
    const functionCalls = [];
    const rawModelParts = []; // Preserve original parts for thought_signature support
    let usageMetadata = null;

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
      const candidateParts = chunk.candidates?.[0]?.content?.parts;
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
      yield { type: 'done', fullText };
      return;
    }

    // Add model response preserving original parts (includes thought_signature)
    contents.push({
      role: 'model',
      parts: rawModelParts.length > 0 ? rawModelParts : functionCalls.map((fc) => ({
        functionCall: { name: fc.name, args: fc.args },
      })),
    });

    // Execute tools
    const functionResponses = [];
    for (const fc of functionCalls) {
      const callId = `call_${Date.now()}_${fc.name}`;
      yield { type: 'tool-call', name: fc.name, args: fc.args, callId };

      const result = await executeTool(fc.name, fc.args, workspaceConfig);
      yield { type: 'tool-result', name: fc.name, callId, result };

      functionResponses.push({
        functionResponse: { name: fc.name, response: result },
      });
    }

    contents.push({ role: 'user', parts: functionResponses });
  }

  yield { type: 'done', fullText };
}

module.exports = { streamCompletion };
