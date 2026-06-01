// server/mcp/server.ts — MCP server handler (raw JSON-RPC 2.0 over HTTP)
//
// Exposes workspace tools to external MCP clients. Implements the MCP
// protocol directly as JSON-RPC to avoid ESM/CJS interop issues with the SDK.
import type { Request, Response } from 'express';

const config = require('../config');
const { resolveTools, executeTool } = require('../tools/index');

// ─── JSON-RPC Types ────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

// ─── JSON-RPC Error Codes ──────────────────────────────────

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

// ─── Helpers ───────────────────────────────────────────────

function jsonRpcSuccess(id: number | string | null, result: unknown): object {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: number | string | null, error: JsonRpcErrorPayload): object {
  return { jsonrpc: '2.0', id, error };
}

// ─── Handler Factory ───────────────────────────────────────

/**
 * Create an Express request handler that speaks MCP (JSON-RPC 2.0).
 * @param enabledToolNames — tool allowlist; null/undefined = all tools
 */
function createMcpRequestHandler(enabledToolNames: string[] | null) {
  return async (req: Request, res: Response): Promise<void> => {
    // Parse and validate JSON-RPC envelope
    const body = req.body as JsonRpcRequest;

    if (!body || body.jsonrpc !== '2.0' || !body.method) {
      res.status(200).json(
        jsonRpcError(body?.id ?? null, {
          code: INVALID_REQUEST,
          message: 'Invalid JSON-RPC 2.0 request',
        }),
      );
      return;
    }

    const { id, method, params } = body;

    try {
      switch (method) {
        // ── Initialize ───────────────────────────────────
        case 'initialize': {
          res.json(
            jsonRpcSuccess(id ?? null, {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: {
                name: `roundtable-${config.workspaceId}`,
                version: '1.0.0',
              },
            }),
          );
          return;
        }

        // ── Client acknowledgment (notification — no response expected) ──
        case 'notifications/initialized': {
          // Notifications have no id — but we send an empty 200 either way
          res.status(200).json({});
          return;
        }

        // ── List Tools ───────────────────────────────────
        case 'tools/list': {
          const activeTools = resolveTools(enabledToolNames);

          const toolList = Object.values(activeTools).map((t: any) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          }));

          res.json(jsonRpcSuccess(id ?? null, { tools: toolList }));
          return;
        }

        // ── Call Tool ────────────────────────────────────
        case 'tools/call': {
          const toolName = (params as any)?.name;
          const toolArgs = (params as any)?.arguments || {};

          if (!toolName) {
            res.json(
              jsonRpcError(id ?? null, {
                code: INVALID_REQUEST,
                message: 'Missing required param: name',
              }),
            );
            return;
          }

          try {
            const result = await executeTool(toolName, toolArgs);

            res.json(
              jsonRpcSuccess(id ?? null, {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(result),
                  },
                ],
              }),
            );
          } catch (toolErr: unknown) {
            const message = toolErr instanceof Error ? toolErr.message : String(toolErr);

            res.json(
              jsonRpcSuccess(id ?? null, {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ error: message }),
                  },
                ],
                isError: true,
              }),
            );
          }
          return;
        }

        // ── Unknown Method ───────────────────────────────
        default: {
          res.json(
            jsonRpcError(id ?? null, {
              code: METHOD_NOT_FOUND,
              message: `Method not found: ${method}`,
            }),
          );
          return;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[MCP Server] Internal error:', message);

      res.json(
        jsonRpcError(id ?? null, {
          code: INTERNAL_ERROR,
          message: 'Internal server error',
        }),
      );
    }
  };
}

module.exports = { createMcpRequestHandler };
