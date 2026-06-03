// @ts-nocheck
// server/tools/callAgent.js — Call an external A2A agent
//
// Sends a task to a remote A2A-compliant agent via JSON-RPC 2.0.
// Follows the same module pattern as bridgeWorkspace.js.

const crypto = require('crypto');

const TIMEOUT_MS = 30000;

import type { Tool } from '../types';
// @ts-ignore


const callAgent: Tool = {
  name: 'call_agent',
  description:
    'Delegate a task to an external AI agent via the A2A (Agent-to-Agent) protocol. ' +
    'The agent must expose an A2A-compliant endpoint. ' +
    'Use this when you need specialized expertise from another agent.',
  parameters: {
    type: 'object',
    properties: {
      agent_url: {
        type: 'string',
        description:
          'Base URL of the A2A agent (e.g., https://agent.example.com). ' +
          'The agent card will be fetched from /.well-known/agent.json',
      },
      message: {
        type: 'string',
        description: 'The task or question to send to the agent',
      },
      api_key: {
        type: 'string',
        description: 'Optional API key for authentication with the remote agent',
      },
    },
    required: ['agent_url', 'message'],
  },

  async execute(args: any, workspaceConfig: any = {}, _context?: any) {
    const { agent_url, message, api_key } = args;

    if (!agent_url || !message) {
      return { error: 'agent_url and message are required' };
    }

    const baseUrl = agent_url.replace(/\/+$/, '');

    // ── 1. Fetch Agent Card ────────────────────────────
    let agentCard;
    try {
      const cardResponse = await fetch(`${baseUrl}/.well-known/agent.json`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!cardResponse.ok) {
        return {
          error: `Failed to fetch agent card from ${baseUrl}/.well-known/agent.json: ${cardResponse.status} ${cardResponse.statusText}`,
        };
      }

      agentCard = await cardResponse.json();
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return { error: `Timeout fetching agent card from ${baseUrl} (${TIMEOUT_MS}ms)` };
      }
      return { error: `Failed to reach agent at ${baseUrl}: ${err.message}` };
    }

    // ── 2. Send JSON-RPC message/send ──────────────────
    const rpcId = crypto.randomUUID();
    const a2aUrl = agentCard.url || `${baseUrl}/a2a`;

    const headers = {
      'Content-Type': 'application/json',
    };
    if (api_key) {
      headers['x-api-key'] = api_key;
    }

    const rpcBody = {
      jsonrpc: '2.0',
      id: rpcId,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          parts: [{ type: 'text', text: message }],
        },
      },
    };

    let rpcResult;
    try {
      const rpcResponse = await fetch(a2aUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(rpcBody),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!rpcResponse.ok) {
        const body = await rpcResponse.text().catch(() => '');
        if (rpcResponse.status === 401 || rpcResponse.status === 403) {
          return {
            error: `Authentication failed with agent "${agentCard.name || baseUrl}". Provide a valid api_key.`,
          };
        }
        return {
          error: `Agent "${agentCard.name || baseUrl}" returned HTTP ${rpcResponse.status}: ${body.slice(0, 200)}`,
        };
      }

      rpcResult = await rpcResponse.json();
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return { error: `Timeout waiting for agent "${agentCard.name || baseUrl}" response (${TIMEOUT_MS}ms)` };
      }
      return { error: `Communication error with agent "${agentCard.name || baseUrl}": ${err.message}` };
    }

    // ── 3. Parse JSON-RPC response ─────────────────────
    if (rpcResult.error) {
      return {
        error: `Agent "${agentCard.name || baseUrl}" returned error: ${rpcResult.error.message || JSON.stringify(rpcResult.error)}`,
      };
    }

    const task = rpcResult.result;
    if (!task) {
      return { error: 'Agent returned an empty result' };
    }

    // ── 4. Extract response text from artifacts ────────
    let responseText = '';

    // Try artifacts first
    if (task.artifacts && Array.isArray(task.artifacts)) {
      for (const artifact of task.artifacts) {
        if (artifact.parts && Array.isArray(artifact.parts)) {
          for (const part of artifact.parts) {
            if (part.type === 'text' && part.text) {
              responseText += (responseText ? '\n' : '') + part.text;
            }
          }
        }
      }
    }

    // Fall back to status message
    if (!responseText && task.status?.message?.parts) {
      for (const part of task.status.message.parts) {
        if (part.type === 'text' && part.text) {
          responseText += (responseText ? '\n' : '') + part.text;
        }
      }
    }

    if (!responseText) {
      responseText = '(Agent returned no text response)';
    }

    return {
      success: true,
      agent_name: agentCard.name || baseUrl,
      response: responseText,
      task_id: task.id || null,
      task_status: task.status?.state || 'unknown',
    };
  },
};

export default callAgent;
