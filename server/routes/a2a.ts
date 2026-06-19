// server/routes/a2a.ts — A2A protocol Express router
//
// Routes:
//   GET  /.well-known/agent.json  — public agent card (no auth)
//   POST /a2a                     — JSON-RPC 2.0 endpoint (API key or contract auth)
//
// JSON-RPC Methods:
//   message/send    — AI-interpreted message (full LLM inference on receiving side)
//   intent/execute  — Compiled intent token (direct tool execution, NO LLM)
//   intent/discover — Schema/capability discovery
//   tasks/get       — Get task status
//   tasks/cancel    — Cancel a running task
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
const { getAvailableTools, resolveTools } = require('../tools') as {
  getAvailableTools: () => Array<{ name: string; description: string }>;
  resolveTools: (enabledNames?: string[] | null) => Record<string, unknown>;
};

// Intent Compilation Engine imports
import { validateIntent, intentOpToAction } from '../protocols/intentToken';
import type { IntentToken, IntentResult } from '../protocols/intentToken';
import { verifyIntentToken, decryptIntentToken, signIntentResult } from '../protocols/intentTokenCodec';
import { nonceStore } from '../protocols/nonceStore';
import { intentMetrics } from '../protocols/intentMetrics';

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
async function requireA2aAuth(req: Request, res: Response, next: () => void): Promise<void> {
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

      // Load contracts: prefer live manifest (Firestore, 5s TTL cache),
      // fall back to static env var for resilience during outages
      let contracts: any[] = [];
      try {
        const { fetchManifest } = require('../utils/fetchManifest');
        const manifestData = await fetchManifest();
        contracts = manifestData.RT_CONTRACTS || [];
      } catch (err) {
        console.warn('[A2A] fetchManifest failed:', (err as Error).message);
        contracts = [];
      }
      const masterSecret = process.env.ORG_MASTER_SECRET;

      if (!masterSecret) {
        res.status(403).json(
          jsonRpcError(req.body?.id || null, -32000, 'Contract auth not available (no master secret configured)')
        );
        return;
      }

      // Find and validate the contract
      // Use the action the sender signed with (from header), default to 'message_send' for backward compat
      const signedAction = (req.headers['x-contract-action'] as string) || 'message_send';
      const { contract, error: contractError } = findAndValidateContract(contracts, contractId, signedAction);
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
            contractKey, contractId, contractTs, signedAction, contractSig
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

        // ── Domain Isolation Guard ──────────────────────
        // If this workspace is a domain (has RT_CONNECTIONS), reject
        // free-form message/send from contract-authenticated callers.
        // Domains only accept intent/execute for structured, capability-scoped operations.
        // This prevents external agents from bypassing the capability system.
        if ((req as any).contract && process.env.RT_CONNECTIONS) {
          return res.json(
            jsonRpcError(id, -32000,
              'Domain workspaces do not accept message/send via contracts. ' +
              'Use intent/execute with a scoped capability instead.'
            )
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

      // ── intent/execute ─────────────────────────────────
      // Compiled intent token execution — NO LLM inference.
      // Receives a signed IntentToken, verifies it, executes the operation
      // directly against the tool registry, and returns a signed result.
      case 'intent/execute': {
        if (!params?.token) {
          return res.json(
            jsonRpcError(id, -32602, 'Missing params.token')
          );
        }

        const token: IntentToken = params.token;
        const masterSecret = process.env.ORG_MASTER_SECRET;

        if (!masterSecret) {
          return res.json(
            jsonRpcError(id, -32000, 'Intent execution not available (no master secret)')
          );
        }

        // 1. Verify token signature, expiry, and freshness
        const verification = await verifyIntentToken(token, masterSecret);
        if (!verification.valid) {
          console.warn(`[A2A:ICE] Token verification failed: ${verification.error}`);
          return res.json(
            jsonRpcError(id, -32000, `Token verification failed: ${verification.error}`)
          );
        }

        // 2. Check nonce for replay prevention
        if (!nonceStore.add(token.nonce)) {
          console.warn(`[A2A:ICE] Replay detected: nonce ${token.nonce}`);
          return res.json(
            jsonRpcError(id, -32000, 'Replay detected: token nonce already used')
          );
        }

        // 3. Decrypt if encrypted
        let executableToken = token;
        if (token.encrypted && token.encryptedIntent) {
          const { token: decrypted, error: decryptError } = await decryptIntentToken(token, verification.contractKey!);
          if (decryptError) {
            return res.json(
              jsonRpcError(id, -32000, decryptError)
            );
          }
          executableToken = decrypted;
        }

        // 4. Validate the intent structure
        const intentValid = validateIntent(executableToken.intent);
        if (!intentValid.valid) {
          return res.json(
            jsonRpcError(id, -32602, `Invalid intent: ${intentValid.error}`)
          );
        }

        // 5. Check contract authorization for this specific operation
        let contracts: any[] = [];
        try {
          const { fetchManifest } = require('../utils/fetchManifest');
          contracts = (await fetchManifest()).RT_CONTRACTS || [];
        } catch (err) {
          console.warn('[A2A:ICE] fetchManifest failed:', (err as Error).message);
          contracts = [];
        }
        const contract = contracts.find((c: any) =>
          c.contractId === token.contractId && c.status === 'active'
        );
        if (!contract) {
          return res.json(
            jsonRpcError(id, -32000, 'No active contract found for this token')
          );
        }

        const requiredAction = intentOpToAction(executableToken.intent);
        const TRANSPORT_ACTIONS = ['intent_execute', 'discover'];
        if (!TRANSPORT_ACTIONS.includes(requiredAction) &&
            !contract.allowedActions?.includes(requiredAction) &&
            !contract.allowedActions?.includes('intent_execute')) {
          console.warn(`[A2A:ICE] Action '${requiredAction}' not permitted by contract ${token.contractId}`);
          const deniedResult: Omit<IntentResult, 'signature'> = {
            version: 1,
            type: 'intent_result',
            tokenId: token.id,
            status: 'denied',
            error: `Action '${requiredAction}' not permitted by contract`,
            executionMs: 0,
            timestamp: new Date().toISOString(),
          };
          return res.json(
            jsonRpcSuccess(id, signIntentResult(deniedResult, verification.contractKey!))
          );
        }

        // 6. Execute the intent directly (no LLM!)
        try {
          // Lazy import to avoid circular dependency at module load time
          const { executeIntentToken } = require('../protocols/intentExecutor');

          const db = getAdapter();
          const workspace = await db.getWorkspace(config.workspaceId);
          let enabledToolNames: string[] | null = null;
          if (workspace?.enabled_tools) {
            try {
              enabledToolNames = JSON.parse(workspace.enabled_tools as string);
            } catch { /* intentionally empty */ }
          }

          const result = await executeIntentToken(executableToken, {
            contractKey: verification.contractKey!,
            contract,
            workspaceConfig: {},
            enabledToolNames,
          });

          // Track metrics
          intentMetrics.record(
            executableToken.intent.op === 'discover' ? 'discover' : (executableToken.intent as any).tool || 'unknown',
            result.executionMs,
            true  // compiled execution
          );

          console.log(`[A2A:ICE] Executed intent ${token.id} (${executableToken.intent.op}) in ${result.executionMs}ms — zero LLM tokens used`);
          return res.json(jsonRpcSuccess(id, result));
        } catch (err: unknown) {
          const error = err as Error;
          console.error(`[A2A:ICE] Execution error:`, error.message);
          const errorResult: Omit<IntentResult, 'signature'> = {
            version: 1,
            type: 'intent_result',
            tokenId: token.id,
            status: 'error',
            error: error.message,
            executionMs: 0,
            timestamp: new Date().toISOString(),
          };
          return res.json(
            jsonRpcSuccess(id, signIntentResult(errorResult, verification.contractKey!))
          );
        }
      }

      // ── intent/discover ────────────────────────────────
      case 'intent/discover': {
        // Returns available tools and capabilities — lightweight, no token required
        const tools = getAvailableTools();
        return res.json(jsonRpcSuccess(id, {
          capabilities: ['intent/execute', 'intent/discover', 'message/send'],
          tools: tools.map(t => ({ name: t.name, description: t.description })),
          intentOps: ['query', 'tool_call', 'aggregate', 'discover'],
        }));
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
