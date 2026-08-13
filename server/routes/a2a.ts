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
  getTask: (id: string, expectedTenant?: string) => Record<string, unknown> | undefined;
  cancelTask: (id: string, expectedTenant?: string) => Record<string, unknown> | null;
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
    // Pooled: a service-level card — no single workspace to describe, and
    // consult traffic never reads the card (senders POST directly).
    if (config.pooled) {
      const { capabilityRegistry } = require('../protocols/capabilityRegistry');
      const serviceKind = config.pooledDomainType || 'arthur';
      return res.json({
        name: `${serviceKind}-service`,
        description: `Pooled Roundtable service (${serviceKind}); tenant per request`,
        capabilities: capabilityRegistry.getManifest(),
      });
    }

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
 * A2A auth middleware — accepts:
 * 1. x-api-key header (simple API key auth; dedicated pods only)
 * 2. Contract-based auth (X-Contract-Id + X-Contract-Signature + X-Contract-Timestamp headers)
 * 3. Pooled Arthur only: tenant-bound S2S HMAC (X-Control-Plane-Signature +
 *    X-Control-Plane-Timestamp + X-Rt-Workspace) — the trusted-app chat
 *    ingress (Pendragon's roundtable.ts → message/send), replacing the
 *    guessable per-workspace `a2a-${wsId}` keys. Signed string:
 *    `a2a:${timestamp}:${workspaceId}` (requireHmac('a2a') semantics).
 */
async function requireA2aAuth(req: Request, res: Response, next: () => void): Promise<void> {
  // Option 1: API key auth (existing behavior).
  // Pooled services skip it: the key is a per-pod secret with no tenant
  // semantics — a bare key could not say WHICH workspace is being consulted,
  // so pooled requests must authenticate with contract headers.
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (!config.pooled && apiKey && config.a2aApiKey && apiKey === config.a2aApiKey) {
    return next();
  }

  // Option 3: tenant-bound S2S HMAC (pooled Arthur only). Delegates to the
  // shared middleware — tenantRequired binds X-Rt-Workspace into the signed
  // string and attaches req.rtTenant = { workspaceId } on success. NOTE: this
  // path carries no contract and no masterSecret; message/send resolves the
  // tenant's org master secret itself when it needs one.
  if (config.pooledArthur
      && req.headers['x-control-plane-signature']
      && req.headers['x-control-plane-timestamp']
      && req.headers['x-rt-workspace']) {
    const { requireHmac } = require('../middleware/requireHmac');
    return requireHmac('a2a', { tenantRequired: true })(req, res, next);
  }

  // Option 2: Contract-based HKDF auth
  const contractId = req.headers['x-contract-id'] as string | undefined;
  const contractSig = req.headers['x-contract-signature'] as string | undefined;
  const contractTs = req.headers['x-contract-timestamp'] as string | undefined;

  if (contractId && contractSig && contractTs) {
    try {
      const { deriveContractKey, verifyRequest, findAndValidateContract } = require('../utils/contractAuth');

      // Load contracts from the live manifest (Firestore, 5s TTL cache).
      // On fetch failure the list stays empty and auth FAILS CLOSED below —
      // there is no static fallback.
      let contracts: any[] = [];
      if (!config.pooled) {
        // Pooled mode fetches the CLAIMED tenant's manifest instead (below).
        try {
          const { fetchManifest } = require('../utils/fetchManifest');
          const manifestData = await fetchManifest();
          contracts = manifestData.RT_CONTRACTS || [];
        } catch (err) {
          console.warn('[A2A] fetchManifest failed:', (err as Error).message);
          contracts = [];
        }
      }
      // Dedicated: the org master secret is pod env (org-scoped fleet).
      // Pooled: tenants SPAN orgs (Pendragon is org-per-household), so the
      // master secret is resolved per tenant after the manifest lookup below.
      let masterSecret = process.env.ORG_MASTER_SECRET;

      if (!masterSecret && !config.pooled) {
        res.status(403).json(
          jsonRpcError(req.body?.id || null, -32000, 'Contract auth not available (no master secret configured)')
        );
        return;
      }

      // Find and validate the contract
      // Use the action the sender signed with (from header), default to 'message_send' for backward compat
      const signedAction = (req.headers['x-contract-action'] as string) || 'message_send';

      // Pooled: the contract must be validated against the CLAIMED tenant's
      // manifest (X-Rt-Tenant), not this process's — membership there is the
      // authorization (see server/pooled/tenantResolver.ts). The tenant is
      // then bound into the signature check below.
      let contract: any;
      let resolvedTenant: any = null;
      if (config.pooled) {
        try {
          const { resolveTenantFromRequest } = require('../pooled/tenantResolver');
          resolvedTenant = await resolveTenantFromRequest(req, { contractId, action: signedAction });
          contract = resolvedTenant.contract;
          // Per-tenant master secret: the tenant's ORG owns the HKDF root.
          const { getOrgMasterSecret } = require('../tenantCredentials');
          masterSecret = await getOrgMasterSecret(
            resolvedTenant.workspaceId, resolvedTenant.manifest?.orgId || '',
          );
          if (!masterSecret) {
            res.status(403).json(
              jsonRpcError(req.body?.id || null, -32000, 'Contract auth not available (no org master secret for tenant)')
            );
            return;
          }
          resolvedTenant.masterSecret = masterSecret;
        } catch (e: any) {
          res.status(e?.status || 403).json(
            jsonRpcError(req.body?.id || null, -32000, `Tenant resolution failed: ${e?.message}`)
          );
          return;
        }
      } else {
        const { contract: found, error: contractError } = findAndValidateContract(contracts, contractId, signedAction);
        if (contractError) {
          res.status(403).json(
            jsonRpcError(req.body?.id || null, -32000, `Contract rejected: ${contractError}`)
          );
          return;
        }
        contract = found;
      }

      // Derive key and verify signature. Pooled: the claimed tenant is part
      // of the signed string — a signature minted for tenant A cannot be
      // replayed with tenant B in the header.
      deriveContractKey(masterSecret, contractId, contract.version || 1)
        .then((contractKey: Buffer) => {
          const { valid, error: sigError } = verifyRequest(
            contractKey, contractId, contractTs, signedAction, contractSig,
            undefined, resolvedTenant ? resolvedTenant.workspaceId : undefined
          );

          if (!valid) {
            res.status(401).json(
              jsonRpcError(req.body?.id || null, -32000, `Contract signature invalid: ${sigError}`)
            );
            return;
          }

          // Attach contract info to request for downstream use
          (req as any).contract = contract;
          if (resolvedTenant) (req as any).rtTenant = resolvedTenant;
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
        if ((req as any).contract && (config.pooledDomainType || process.env.RT_CONNECTIONS)) {
          return res.json(
            jsonRpcError(id, -32000,
              'Domain workspaces do not accept message/send via contracts. ' +
              'Use intent/execute with a scoped capability instead.'
            )
          );
        }

        // ── Tenant resolution (pooled) ─────────────────────
        // Contract auth attached rtTenant WITH masterSecret; the S2S HMAC
        // method attached rtTenant WITHOUT one — resolve it here the same way
        // the contract path does (manifest orgId → org master secret) so E2E
        // decryption works on either path. Fail-open: only decryption needs
        // it, and that check still fails closed below.
        const rtTenant = (req as any).rtTenant as
          { workspaceId: string; masterSecret?: string; manifest?: any } | undefined;
        if (config.pooled && rtTenant && !rtTenant.masterSecret) {
          try {
            const { fetchManifest } = require('../utils/fetchManifest');
            const tenantManifest = rtTenant.manifest || await fetchManifest(rtTenant.workspaceId);
            if (!rtTenant.manifest) rtTenant.manifest = tenantManifest;
            const { getOrgMasterSecret } = require('../tenantCredentials');
            const resolved = await getOrgMasterSecret(rtTenant.workspaceId, tenantManifest?.orgId || '');
            if (resolved) rtTenant.masterSecret = resolved;
          } catch (err) {
            console.warn('[A2A] tenant master-secret resolution failed:', (err as Error).message);
          }
        }

        // ── E2E Decryption ────────────────────────────────
        // If the request has X-Contract-Encrypted header, the message parts
        // are AES-256-GCM encrypted. Decrypt before processing.
        let message = params.message;
        const isEncrypted = req.headers['x-contract-encrypted'] === 'aes-256-gcm';
        if (isEncrypted && (req as any).contract) {
          const contractId = req.headers['x-contract-id'] as string;
          // Pooled: the tenant's ORG owns the HKDF root; dedicated pods keep
          // the process-env secret.
          const masterSecret = rtTenant?.masterSecret || process.env.ORG_MASTER_SECRET;
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

        // Resolve workspace for AI config. Pooled: the TENANT's row — a
        // missing row is a JSON-RPC error, never a fallback to a default
        // workspace.
        const db = getAdapter();
        const sendWsId = rtTenant?.workspaceId || config.workspaceId;
        const workspace = await db.getWorkspace(sendWsId);
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

        // Build workspace config (sender contract, pooled-arthur-plan Q3):
        // sender tools resolve the tenant's manifest and org master secret
        // from these fields instead of process env.
        const workspaceConfig: Record<string, unknown> = {
          workspaceId: sendWsId,
          workspaceName: workspace.name,
        };
        if (rtTenant) {
          workspaceConfig.tenant = {
            workspaceId: rtTenant.workspaceId,
            orgId: rtTenant.manifest?.orgId ?? null,
          };
        }
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
          headers: req.headers,
          ...(rtTenant ? { tenantWsId: rtTenant.workspaceId } : {}),
          workspaceName: workspace.name,
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

        // Pooled: a task recorded for another tenant reads as not-found.
        const task = getTask(params.id, config.pooled
          ? ((req as any).rtTenant?.workspaceId ?? '') : undefined);
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

        const task = cancelTask(params.id, config.pooled
          ? ((req as any).rtTenant?.workspaceId ?? '') : undefined);
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
        // Pooled: the token was minted with the TENANT'S org master secret
        // (senders live in the household's org); auth already resolved it.
        const rtTenantEarly = (req as any).rtTenant as { masterSecret?: string } | undefined;
        const masterSecret = rtTenantEarly?.masterSecret || process.env.ORG_MASTER_SECRET;

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

        // 2. Check nonce for replay prevention (DB-backed; survives restarts)
        if (!(await nonceStore.add(token.nonce))) {
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

        // 5. Check contract authorization for this specific operation.
        // Pooled: the token's contract must live in the CLAIMED tenant's
        // manifest — the same membership proof the auth middleware ran; the
        // token adds nonce + its own HMAC on top.
        const rtTenant = (req as any).rtTenant as { workspaceId: string; manifest: any } | undefined;
        if (config.pooled && !rtTenant) {
          return res.json(
            jsonRpcError(id, -32000, 'Pooled service requires contract auth with X-Rt-Tenant')
          );
        }
        let contracts: any[] = [];
        if (rtTenant) {
          contracts = rtTenant.manifest?.RT_CONTRACTS || [];
        } else {
          try {
            const { fetchManifest } = require('../utils/fetchManifest');
            contracts = (await fetchManifest()).RT_CONTRACTS || [];
          } catch (err) {
            console.warn('[A2A:ICE] fetchManifest failed:', (err as Error).message);
            contracts = [];
          }
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
            !contract.allowedActions?.includes('*') &&
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
          // Pooled: the TENANT's workspace row decides enabled tools; a
          // missing row is an error, never a silent all-tools default.
          const wsIdForRow = rtTenant ? rtTenant.workspaceId : config.workspaceId;
          const workspace = await db.getWorkspace(wsIdForRow);
          if (rtTenant && !workspace) {
            return res.json(
              jsonRpcError(id, -32000, 'Workspace not found for tenant')
            );
          }
          let enabledToolNames: string[] | null = null;
          if (workspace?.enabled_tools) {
            try {
              enabledToolNames = JSON.parse(workspace.enabled_tools as string);
            } catch { /* intentionally empty */ }
          }

          // Pooled: assemble the per-request tenant context (service DB URL +
          // per-request credentials) that rides ctx.tenant into the plugin.
          let tenantCtx: Record<string, unknown> | undefined;
          if (rtTenant) {
            const { buildTenantContext } = require('../pooled/tenantContext');
            tenantCtx = await buildTenantContext(rtTenant);
          }

          const result = await executeIntentToken(executableToken, {
            contractKey: verification.contractKey!,
            contract,
            workspaceConfig: tenantCtx ? { workspaceId: rtTenant!.workspaceId, tenant: tenantCtx } : {},
            enabledToolNames,
            ...(tenantCtx ? { tenant: tenantCtx } : {}),
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
