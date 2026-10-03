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
 *    guessable per-workspace `a2a-${wsId}` keys. Signed string (v1):
 *    `a2a:${timestamp}:${workspaceId}`; v2 adds nonce + body hash
 *    (requireHmac('a2a') semantics, SIGNING_SPEC.md).
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
      const { verifyContractRequest, findAndValidateContract, resolveContractKeyForRequest } = require('../utils/contractAuth');
      const { logOrgKeyAccepted } = require('../utils/contractKeys');

      // Load contracts from the live manifest (Firestore, 5s TTL cache).
      // fetchManifest fails closed (1.1): a 200 is the truth, env
      // RT_CONTRACTS is consulted only before the FIRST successful fetch and
      // only for this pod's own workspace, a last-known-good manifest is
      // served for at most RT_MANIFEST_STALE_MAX_MS, then the list is empty
      // and auth FAILS CLOSED below.
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
          resolvedTenant = await resolveTenantFromRequest(req, {
            contractId,
            action: signedAction,
            sender: req.headers['x-contract-sender'] as string | undefined,
          });
          contract = resolvedTenant.contract;
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

      // Which key (5.1): X-Contract-Sender → the sender's per-party key
      // (sender must be the counterparty of the workspace addressed);
      // no sender → legacy org-derived key while RT_ACCEPT_ORG_KEY. The org
      // master is resolved LAZILY — dedicated from pod env, pooled per
      // tenant (tenants span orgs) — so a per-party request never needs it.
      const selfWsId = resolvedTenant ? resolvedTenant.workspaceId : config.workspaceId;
      const getMasterSecret = async (): Promise<string | null> => {
        if (!config.pooled) return process.env.ORG_MASTER_SECRET || null;
        const { getOrgMasterSecret } = require('../tenantCredentials');
        const m = await getOrgMasterSecret(resolvedTenant.workspaceId, resolvedTenant.manifest?.orgId || '');
        if (m) resolvedTenant.masterSecret = m;
        return m;
      };
      const keyRes = await resolveContractKeyForRequest({
        headers: req.headers,
        contract,
        selfWsId,
        tenant: resolvedTenant ? { workspaceId: resolvedTenant.workspaceId } : undefined,
        getMasterSecret,
      });
      if (keyRes.error) {
        res.status(keyRes.status || 403).json(
          jsonRpcError(req.body?.id || null, -32000, keyRes.status === 403 && /party|parties|receiving/.test(keyRes.error)
            ? `Contract rejected: ${keyRes.error}`
            : keyRes.error)
        );
        return;
      }

      // Verify signature (v1 while RT_HMAC_ACCEPT_V1, v2 with X-Rt-Sig-V: 2
      // — nonce + body hash; SIGNING_SPEC.md). Pooled: the claimed tenant is
      // part of the signed string — a signature minted for tenant A cannot
      // be replayed with tenant B in the header.
      const { valid, error: sigError } = await verifyContractRequest(keyRes.key, {
        headers: req.headers,
        rawBody: (req as any).rawBody,
        contractId,
        action: signedAction,
        tenantWsId: resolvedTenant ? resolvedTenant.workspaceId : undefined,
      });

      if (!valid) {
        res.status(401).json(
          jsonRpcError(req.body?.id || null, -32000, `Contract signature invalid: ${sigError}`)
        );
        return;
      }
      if (keyRes.kind === 'org') logOrgKeyAccepted(contractId, 'request');

      // Attach contract info to request for downstream use. contractKey is
      // the key that verified the request (party or org) — E2E decryption
      // and result signing use it rather than re-deriving from the master.
      (req as any).contract = contract;
      (req as any).contractKey = keyRes.key;
      (req as any).contractKeyKind = keyRes.kind;
      if (keyRes.sender) (req as any).contractSender = keyRes.sender;
      if (resolvedTenant) (req as any).rtTenant = resolvedTenant;
      next();
      return;
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

        // ── message/send through allowedActions (upgrade plan 1.5) ────
        // A contract-authenticated message/send is a delegated LLM turn on
        // this workspace. The action the caller signed must be a message
        // action AND be granted by the contract — the auth middleware proved
        // the signature and that the signed action is allowed, not that
        // `capability:x` entitles anyone to a chat. No warn mode: the
        // message actions left the transport allowlist in contractAuth.js,
        // so a contract that does not grant them already fails at auth.
        const isDelegatedTurn = !!(req as any).contract;
        if (isDelegatedTurn) {
          const { isActionAllowed, MESSAGE_ACTIONS } = require('../utils/contractAuth');
          const signedAction = (req.headers['x-contract-action'] as string) || 'message_send';
          const contract = (req as any).contract;
          let denial: string | null = null;
          if (!MESSAGE_ACTIONS.includes(signedAction)) {
            denial = `message/send requires a message action (${MESSAGE_ACTIONS.join('|')}); signed action was '${signedAction}'`;
          } else if (!isActionAllowed(contract.allowedActions, signedAction)) {
            denial = `Action '${signedAction}' is not granted by contract ${contract.contractId} (allowed: ${(contract.allowedActions || []).join(', ')})`;
          }
          if (denial) {
            console.warn(`[A2A] message/send DENIED: ${denial}`);
            return res.status(403).json(jsonRpcError(id, -32000, `Contract rejected: ${denial}`));
          }
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
          // The key that verified the request (5.1: the sender's party key,
          // or the legacy org key) is the key the sender encrypted with.
          const contractKey: Buffer | undefined = (req as any).contractKey;

          if (!contractKey) {
            return res.json(
              jsonRpcError(id, -32000, 'Cannot decrypt: no contract key for this request')
            );
          }

          try {
            const { decryptPayload } = require('../utils/contractAuth');

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
          // Delegated turns run under the 'delegated' tool profile: read-only
          // tools + intent_bridge (tools/index.ts resolveTools). The trusted
          // app's own chat ingress (S2S HMAC, no contract) keeps the
          // workspace's normal profile.
          ...(isDelegatedTurn ? { toolProfile: 'delegated' } : {}),
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
        // Key for the token (5.1): a token with `sender` verifies with
        // key(contract, sender) — resolved for the addressed workspace
        // (pooled: the tenant, via Secret Manager; dedicated: RT_CONTRACT_KEYS).
        // A legacy token (no sender) uses the org master: pooled, the
        // TENANT's org secret auth already resolved (or resolves now);
        // dedicated, pod env. Missing master only matters for legacy tokens.
        const rtTenantEarly = (req as any).rtTenant as { workspaceId: string; masterSecret?: string; manifest?: any } | undefined;
        let masterSecret: string | undefined = rtTenantEarly?.masterSecret || (config.pooled ? undefined : process.env.ORG_MASTER_SECRET);
        if (!token.sender && !masterSecret && rtTenantEarly) {
          try {
            const { getOrgMasterSecret } = require('../tenantCredentials');
            masterSecret = (await getOrgMasterSecret(rtTenantEarly.workspaceId, rtTenantEarly.manifest?.orgId || '')) || undefined;
          } catch (e) {
            console.warn('[A2A:ICE] tenant master-secret resolution failed:', (e as Error).message);
          }
        }
        if (!token.sender && !masterSecret) {
          return res.json(
            jsonRpcError(id, -32000, 'Intent execution not available (no master secret)')
          );
        }
        // The token's sender must be the request's sender when both are
        // named — one identity per call, like header contract == token
        // contract below.
        const headerSender = (req as any).contractSender as string | undefined;
        if (token.sender && headerSender && token.sender !== headerSender) {
          return res.json(
            jsonRpcError(id, -32000, 'Token sender does not match X-Contract-Sender')
          );
        }
        const selfWsIdForToken = rtTenantEarly ? rtTenantEarly.workspaceId : config.workspaceId;
        const { resolvePartyKey, senderPartyError } = require('../utils/contractKeys');
        const partyKeyResolver = async (cId: string, version: number, sender: string): Promise<Buffer | null> => {
          const r = await resolvePartyKey({
            contractId: cId, version, partyWsId: sender,
            tenant: rtTenantEarly ? { workspaceId: rtTenantEarly.workspaceId } : undefined,
          });
          return r ? r.key : null;
        };

        // 0. Header contract must be the token's contract (1.6). The auth
        //    middleware authorized X-Contract-Id; the token names the contract
        //    whose key signed it. If they differ, a caller authorized under a
        //    narrow contract could present a token minted under a broader one.
        const headerContractId = req.headers['x-contract-id'] as string | undefined;
        if (headerContractId && headerContractId !== token.contractId) {
          console.warn(`[A2A:ICE] Contract mismatch: header ${headerContractId} vs token ${token.contractId}`);
          return res.json(
            jsonRpcError(id, -32000, 'Token contractId does not match the authenticated contract')
          );
        }

        // 1. Verify token signature, expiry, and freshness
        const verification = await verifyIntentToken(token, masterSecret || '', { partyKeyResolver });
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
        const { contractLivenessError } = require('../utils/contractAuth');
        const contractEntry = contracts.find((c: any) => c.contractId === token.contractId);
        const livenessError = contractLivenessError(contractEntry);
        if (!contractEntry || livenessError) {
          return res.json(
            jsonRpcError(id, -32000, contractEntry
              ? `Contract not live: ${livenessError}`
              : 'No active contract found for this token')
          );
        }
        const contract = contractEntry;

        // 5a. Per-party identity (5.1): the token's sender must be a party to
        //     the contract and the counterparty of the workspace addressed.
        //     The signature proved the sender holds key(C, sender); this
        //     proves that key was ALLOWED to be used toward this workspace.
        if (token.sender) {
          const partyErr = senderPartyError(contract, selfWsIdForToken, token.sender);
          if (partyErr) {
            console.warn(`[A2A:ICE] ${partyErr}`);
            return res.json(
              jsonRpcError(id, -32000, `Token rejected: ${partyErr}`)
            );
          }
        }

        // 5b. The token's contractVersion must be the manifest's (1.6). The
        //     signature verified above was checked with the key for the
        //     version the TOKEN claimed; a rotated contract (version bump)
        //     must not keep accepting tokens minted under the old key.
        const manifestVersion = Number(contract.version || 1);
        const tokenVersion = Number(token.contractVersion || 1);
        if (manifestVersion !== tokenVersion) {
          console.warn(`[A2A:ICE] contractVersion mismatch for ${token.contractId}: token ${tokenVersion}, manifest ${manifestVersion}`);
          return res.json(
            jsonRpcError(id, -32000, `Token contractVersion ${tokenVersion} does not match manifest version ${manifestVersion}`)
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

          // 5.2: this party's Ed25519 proof-signing key for the contract
          // (minted with the party key; absent on pre-5.2 mints → HMAC-only
          // proof). Lookup failure is not an execution failure.
          let signer: { wsId: string; privateKeyPem: string } | undefined;
          try {
            const own = await resolvePartyKey({
              contractId: token.contractId, version: manifestVersion, partyWsId: selfWsIdForToken,
              tenant: rtTenant ? { workspaceId: rtTenant.workspaceId } : undefined,
            });
            if (own?.signingKey) signer = { wsId: selfWsIdForToken, privateKeyPem: own.signingKey };
          } catch (e) {
            console.warn('[A2A:ICE] proof signing key lookup failed:', (e as Error).message);
          }

          const result = await executeIntentToken(executableToken, {
            contractKey: verification.contractKey!,
            contract,
            workspaceConfig: tenantCtx ? { workspaceId: rtTenant!.workspaceId, tenant: tenantCtx } : {},
            enabledToolNames,
            ...(tenantCtx ? { tenant: tenantCtx } : {}),
            ...(signer ? { signer } : {}),
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
