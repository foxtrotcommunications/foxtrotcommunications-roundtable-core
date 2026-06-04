// server/routes/a2a.ts — A2A protocol Express router
//
// Routes:
//   GET  /.well-known/agent.json  — public agent card (no auth)
//   POST /a2a                     — JSON-RPC 2.0 endpoint (API key auth)
//
import type { Request, Response } from 'express';

const express = require('express');
const config = require('../config') as import('../types').AppConfig;
const { getAdapter } = require('../db/adapter') as { getAdapter: () => import('../types').DatabaseAdapter };
const { generateAgentCard } = require('../a2a/agentCard') as {
  generateAgentCard: (workspace: any, enabledTools: any[], config: any) => Record<string, unknown>;
};
const { processMessage, getTask, cancelTask } = require('../a2a/server') as {
  processMessage: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getTask: (id: string) => Record<string, unknown> | undefined;
  cancelTask: (id: string) => Record<string, unknown> | null;
};
const { getAvailableTools } = require('../tools') as {
  getAvailableTools: () => Array<{ name: string; description: string }>;
};

const router = express.Router();

// ─── JSON-RPC Helpers ──────────────────────────────────────

function jsonRpcSuccess(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

// ─── Agent Card (Public — No Auth) ─────────────────────────

router.get('/.well-known/agent.json', async (_req: Request, res: Response) => {
  try {
    const db = getAdapter();
    const workspace = await db.getWorkspace(config.workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const enabledTools = getAvailableTools();
    const card = generateAgentCard(workspace, enabledTools, config);
    res.json(card);
  } catch (err: unknown) {
    const error = err as Error;
    console.error('[A2A] Agent card error:', error.message);
    res.status(500).json({ error: 'Failed to generate agent card' });
  }
});

// ─── Auth Middleware (API Key or Contract) ─────────────────

/**
 * A2A auth middleware — accepts either:
 * 1. x-api-key header (simple API key auth)
 * 2. Contract-based auth (X-Contract-Id + X-Contract-Signature + X-Contract-Timestamp headers)
 */
function requireA2aAuth(req: Request, res: Response, next: () => void): void {
  // Option 1: API key auth (existing behavior)
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (apiKey && config.a2aApiKey && apiKey === config.a2aApiKey) {
    return next();
  }

  // Option 2: Contract-based HKDF auth
  const contractId = req.headers['x-contract-id'] as string | undefined;
  const contractSig = req.headers['x-contract-signature'] as string | undefined;
  const contractTs = req.headers['x-contract-timestamp'] as string | undefined;

  if (contractId && contractSig && contractTs) {
    try {
      const { deriveContractKey, verifyRequest, findAndValidateContract } = require('../utils/contractAuth');

      // Load contract manifest from env
      const contracts = process.env.RT_CONTRACTS ? JSON.parse(process.env.RT_CONTRACTS) : [];
      const masterSecret = process.env.ORG_MASTER_SECRET;

      if (!masterSecret) {
        res.status(403).json(
          jsonRpcError(req.body?.id || null, -32000, 'Contract auth not available (no master secret configured)')
        );
        return;
      }

      // Find and validate the contract
      const { contract, error: contractError } = findAndValidateContract(contracts, contractId, 'message_send');
      if (contractError) {
        res.status(403).json(
          jsonRpcError(req.body?.id || null, -32000, `Contract rejected: ${contractError}`)
        );
        return;
      }

      // Derive key and verify signature
      deriveContractKey(masterSecret, contractId, contract.version || 1)
        .then((contractKey: Buffer) => {
          const { valid, error: sigError } = verifyRequest(
            contractKey, contractId, contractTs, 'message_send', contractSig
          );

          if (!valid) {
            res.status(401).json(
              jsonRpcError(req.body?.id || null, -32000, `Contract signature invalid: ${sigError}`)
            );
            return;
          }

          // Attach contract info to request for downstream use
          (req as any).contract = contract;
          next();
        })
        .catch((err: Error) => {
          res.status(500).json(
            jsonRpcError(req.body?.id || null, -32000, `Contract auth error: ${err.message}`)
          );
        });
      return; // async — don't fall through
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json(
        jsonRpcError(req.body?.id || null, -32000, `Contract auth error: ${error.message}`)
      );
      return;
    }
  }

  // Neither auth method provided
  if (!config.a2aApiKey) {
    res.status(403).json(
      jsonRpcError(req.body?.id || null, -32000, 'A2A server is not configured (no API key set)')
    );
    return;
  }

  res.status(401).json(
    jsonRpcError(req.body?.id || null, -32000, 'Unauthorized: provide x-api-key or contract headers (X-Contract-Id, X-Contract-Signature, X-Contract-Timestamp)')
  );
}

// ─── JSON-RPC Endpoint (Authenticated) ─────────────────────

router.post('/a2a', requireA2aAuth, async (req: Request, res: Response) => {
  const { jsonrpc, id, method, params } = req.body;

  // Validate JSON-RPC 2.0 envelope
  if (jsonrpc !== '2.0' || !method) {
    return res.status(400).json(
      jsonRpcError(id || null, -32600, 'Invalid JSON-RPC 2.0 request')
    );
  }

  try {
    switch (method) {
      // ── message/send ─────────────────────────────────
      case 'message/send': {
        if (!params?.message) {
          return res.json(
            jsonRpcError(id, -32602, 'Missing params.message')
          );
        }

        // ── E2E Decryption ────────────────────────────────
        // If the request has X-Contract-Encrypted header, the message parts
        // are AES-256-GCM encrypted. Decrypt before processing.
        let message = params.message;
        const isEncrypted = req.headers['x-contract-encrypted'] === 'aes-256-gcm';
        if (isEncrypted && (req as any).contract) {
          const contractId = req.headers['x-contract-id'] as string;
          const masterSecret = process.env.ORG_MASTER_SECRET;
          const contract = (req as any).contract;

          if (!masterSecret) {
            return res.json(
              jsonRpcError(id, -32000, 'Cannot decrypt: no master secret configured')
            );
          }

          try {
            const { deriveContractKey, decryptPayload } = require('../utils/contractAuth');
            const contractKey = await deriveContractKey(masterSecret, contractId, contract.version || 1);

            // Decrypt each encrypted part
            const decryptedParts = [];
            for (const part of (message.parts || [])) {
              if (part.encrypted) {
                const { data, error } = decryptPayload(
                  contractKey,
                  part.encrypted.iv,
                  part.encrypted.ciphertext,
                  part.encrypted.authTag
                );
                if (error) {
                  return res.json(
                    jsonRpcError(id, -32000, `Decryption failed: ${error}`)
                  );
                }
                // data is { text: "the original message" }
                decryptedParts.push({ type: 'text', text: data.text || data });
              } else {
                decryptedParts.push(part);
              }
            }

            message = { ...message, parts: decryptedParts };
            console.log(`[A2A] Decrypted E2E message via contract ${contractId}`);
          } catch (err: unknown) {
            const error = err as Error;
            return res.json(
              jsonRpcError(id, -32000, `Decryption error: ${error.message}`)
            );
          }
        }

        // Resolve workspace for AI config
        const db = getAdapter();
        const workspace = await db.getWorkspace(config.workspaceId);
        if (!workspace) {
          return res.json(
            jsonRpcError(id, -32000, 'Workspace not found')
          );
        }

        // Determine AI provider, model, and API key
        const provider = workspace.ai_provider || 'openai';
        const model = workspace.ai_model || 'gpt-4o-mini';

        // Use server-level AI key for the configured provider
        const aiKeys: Record<string, string> = config.ai as unknown as Record<string, string>;
        const apiKey = aiKeys[provider] || '';

        // Parse enabled tools
        let enabledToolNames: string[] | null = null;
        if (workspace.enabled_tools) {
          try {
            enabledToolNames = JSON.parse(workspace.enabled_tools as string);
          } catch (_) {
            enabledToolNames = null;
          }
        }

        // Build workspace config
        const workspaceConfig: Record<string, unknown> = {};
        if (workspace.data_sources) {
          try {
            workspaceConfig.dataSources =
              typeof workspace.data_sources === 'string'
                ? JSON.parse(workspace.data_sources)
                : workspace.data_sources;
          } catch { /* intentionally empty */ }
        }
        if (workspace.ollama_host) {
          workspaceConfig.ollamaHost = workspace.ollama_host;
        }

        const task = await processMessage({
          message,
          provider,
          model,
          apiKey,
          enabledToolNames,
          workspaceConfig,
          systemPrompt: workspace.system_prompt || undefined,
        });

        return res.json(jsonRpcSuccess(id, task));
      }

      // ── tasks/get ────────────────────────────────────
      case 'tasks/get': {
        if (!params?.id) {
          return res.json(
            jsonRpcError(id, -32602, 'Missing params.id')
          );
        }

        const task = getTask(params.id);
        if (!task) {
          return res.json(
            jsonRpcError(id, -32001, `Task not found: ${params.id}`)
          );
        }

        return res.json(jsonRpcSuccess(id, task));
      }

      // ── tasks/cancel ─────────────────────────────────
      case 'tasks/cancel': {
        if (!params?.id) {
          return res.json(
            jsonRpcError(id, -32602, 'Missing params.id')
          );
        }

        const task = cancelTask(params.id);
        if (!task) {
          return res.json(
            jsonRpcError(id, -32001, `Task not found: ${params.id}`)
          );
        }

        return res.json(jsonRpcSuccess(id, task));
      }

      // ── Unknown method ───────────────────────────────
      default:
        return res.json(
          jsonRpcError(id, -32601, `Method not found: ${method}`)
        );
    }
  } catch (err: unknown) {
    const error = err as Error;
    console.error('[A2A] JSON-RPC error:', error.message);
    return res.json(
      jsonRpcError(id, -32000, `Internal error: ${error.message}`)
    );
  }
});

module.exports = router;
