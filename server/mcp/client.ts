// server/mcp/client.ts — MCP client manager (raw JSON-RPC 2.0 over HTTP)
//
// Connects to external MCP servers, discovers their tools, and wraps them
// as Roundtable Tool objects. Uses plain HTTP rather than the SDK to avoid
// ESM/CJS interop issues.
import type { Tool, ToolParameters } from '../types';

const fetch = require('node-fetch');

// ─── Interfaces ────────────────────────────────────────────

interface McpServerConfig {
  name: string;
  url: string;
  apiKey?: string;
}

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: object;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Cache ─────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  tools: McpToolInfo[];
  timestamp: number;
}

const toolCache = new Map<string, CacheEntry>();

function getCached(serverUrl: string): McpToolInfo[] | null {
  const entry = toolCache.get(serverUrl);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    toolCache.delete(serverUrl);
    return null;
  }
  return entry.tools;
}

function setCache(serverUrl: string, tools: McpToolInfo[]): void {
  toolCache.set(serverUrl, { tools, timestamp: Date.now() });
}

// ─── JSON-RPC Helper ───────────────────────────────────────

let requestIdCounter = 0;

async function rpcCall(
  serverUrl: string,
  method: string,
  params: Record<string, unknown>,
  apiKey?: string,
): Promise<unknown> {
  const id = ++requestIdCounter;
  const body: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeout: 15000,
  });

  if (!res.ok) {
    throw new Error(`MCP server returned HTTP ${res.status}: ${res.statusText}`);
  }

  const json: JsonRpcResponse = await res.json();

  if (json.error) {
    throw new Error(`MCP JSON-RPC error ${json.error.code}: ${json.error.message}`);
  }

  return json.result;
}

// ─── Public API ────────────────────────────────────────────

/**
 * Discover tools from an MCP server by calling initialize + tools/list.
 */
async function discoverMcpTools(serverUrl: string, apiKey?: string): Promise<McpToolInfo[]> {
  // Check cache first
  const cached = getCached(serverUrl);
  if (cached) return cached;

  // Step 1: Initialize the session
  await rpcCall(serverUrl, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'roundtable', version: '1.0.0' },
  }, apiKey);

  // Step 2: List available tools
  const result = await rpcCall(serverUrl, 'tools/list', {}, apiKey) as {
    tools?: Array<{ name: string; description?: string; inputSchema?: object }>;
  };

  const tools: McpToolInfo[] = (result?.tools || []).map((t) => ({
    name: t.name,
    description: t.description || '',
    inputSchema: t.inputSchema || { type: 'object', properties: {} },
  }));

  setCache(serverUrl, tools);
  return tools;
}

/**
 * Call a specific tool on an MCP server.
 */
async function callMcpTool(
  serverUrl: string,
  toolName: string,
  args: object,
  apiKey?: string,
): Promise<unknown> {
  const result = await rpcCall(serverUrl, 'tools/call', {
    name: toolName,
    arguments: args,
  }, apiKey) as { content?: Array<{ type: string; text?: string }> };

  // MCP tool results come as content array — extract text if available
  if (result?.content && Array.isArray(result.content)) {
    const textParts = result.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text);

    if (textParts.length === 1) {
      // Try to parse as JSON for structured results
      try {
        return JSON.parse(textParts[0] as string);
      } catch {
        return { result: textParts[0] };
      }
    }
    if (textParts.length > 1) {
      return { result: textParts.join('\n') };
    }
  }

  return result;
}

/**
 * Discover tools from multiple MCP servers and wrap them as Roundtable Tool objects.
 * Tool names are prefixed: mcp_{serverName}_{toolName}
 */
async function createMcpToolsForWorkspace(servers: McpServerConfig[]): Promise<Tool[]> {
  const allTools: Tool[] = [];

  for (const server of servers) {
    try {
      const mcpTools = await discoverMcpTools(server.url, server.apiKey);

      for (const mcpTool of mcpTools) {
        const prefixedName = `mcp_${server.name}_${mcpTool.name}`;

        // Convert MCP inputSchema to Roundtable ToolParameters
        const inputSchema = mcpTool.inputSchema as Record<string, unknown>;
        const parameters: ToolParameters = {
          type: 'object',
          properties: (inputSchema.properties as Record<string, {
            type: string;
            description?: string;
            enum?: string[];
            default?: unknown;
          }>) || {},
          required: (inputSchema.required as string[]) || [],
        };

        const tool: Tool = {
          name: prefixedName,
          description: `[MCP: ${server.name}] ${mcpTool.description}`,
          parameters,
          execute: async (args: Record<string, unknown>) => {
            try {
              const result = await callMcpTool(server.url, mcpTool.name, args, server.apiKey);
              return { success: true, result };
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              return { success: false, error: message };
            }
          },
        };

        allTools.push(tool);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[MCP Client] Failed to discover tools from "${server.name}" (${server.url}): ${message}`);
      // Skip this server and continue with the rest
    }
  }

  return allTools;
}

module.exports = {
  discoverMcpTools,
  callMcpTool,
  createMcpToolsForWorkspace,
};
