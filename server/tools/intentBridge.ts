// @ts-nocheck
// server/tools/intentBridge.ts — Intent Bridge tool: execute compiled intents
// on bridged workspaces without LLM inference.
//
// This is the sending-side complement to bridgeWorkspace. Instead of relaying
// a natural-language prompt (which forces the receiver to spin up its own LLM),
// intent_bridge compiles the request into a signed IntentToken and sends it
// directly. The receiving workspace executes it deterministically.
//
// Transport: JSON-RPC (intent/execute) → target workspace's /a2a endpoint.

const config = require('../config');
import crypto from 'crypto';
import { fetchManifest } from '../utils/fetchManifest';
import { buildIntentToken, verifyIntentResult } from '../protocols/intentTokenCodec';
import { validateIntent, intentOpToAction } from '../protocols/intentToken';
import type { IntentOperation, IntentResult } from '../protocols/intentToken';
import type { Tool } from '../types';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Intent requests should be fast — 30s timeout (vs 120s for delegate) */
const INTENT_TIMEOUT_MS = 30_000;

/** Extended timeout when we detect a sleeping workspace and need to wait for wake */
const WAKE_TIMEOUT_MS = 90_000;

/** Interval between retries when waiting for a workspace to wake */
const WAKE_RETRY_INTERVAL_MS = 5_000;

/** Maximum time to wait for a sleeping workspace to come up */
const MAX_WAKE_WAIT_MS = 250_000;   // 50 retries × 5s

/** Approximate prompt tokens saved by skipping LLM inference on the receiver */
const ESTIMATED_TOKENS_SAVED = '~4300';

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Detect if a 503 response indicates a sleeping workspace (vs a real error).
 * The wake proxy returns JSON { waking: true }, nginx returns HTML 503.
 */
async function detectSleepingWorkspace(response: Response): Promise<boolean> {
  try {
    const body = await response.clone().text();
    // Wake proxy JSON response
    if (body.includes('"waking"')) return true;
    // Raw nginx 503 (pod is at 0 replicas)
    if (body.includes('503 Service Temporarily Unavailable')) return true;
    // nginx 502 (service exists but no endpoints)
    if (body.includes('502 Bad Gateway')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Wake a sleeping workspace by scaling its K8s deployment from 0 → 1.
 * Uses the in-cluster K8s API with the pod's service account token.
 */
async function wakeWorkspace(targetWsId: string): Promise<boolean> {
  try {
    const fs = require('fs');
    const https = require('https');

    // In-cluster credentials (auto-mounted by K8s)
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim();
    const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    const namespace = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();

    // Derive org namespace from current pod's namespace (rt-{orgSlug})
    const orgNamespace = namespace; // Already in rt-pendragon-capital, etc.
    const depName = `rt-ws-${targetWsId.slice(0, 12).toLowerCase()}`;

    const payload = JSON.stringify({ spec: { replicas: 1 } });
    const apiHost = process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
    const apiPort = process.env.KUBERNETES_SERVICE_PORT || '443';

    return new Promise((resolve) => {
      const req = https.request({
        hostname: apiHost,
        port: Number(apiPort),
        path: `/apis/apps/v1/namespaces/${orgNamespace}/deployments/${depName}`,
        method: 'PATCH',
        ca,
        rejectUnauthorized: true,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/strategic-merge-patch+json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[intent_bridge] Scaled ${depName} → 1 replica in ns=${orgNamespace}`);
            resolve(true);
          } else {
            console.error(`[intent_bridge] Failed to scale ${depName}: ${res.statusCode} ${data.slice(0, 200)}`);
            resolve(false);
          }
        });
      });
      req.on('error', (err) => {
        console.error(`[intent_bridge] K8s API error: ${err.message}`);
        resolve(false);
      });
      req.write(payload);
      req.end();
    });
  } catch (err: any) {
    console.error(`[intent_bridge] wakeWorkspace error: ${err.message}`);
    return false;
  }
}

// ─── Tool Definition ────────────────────────────────────────────────────────

const intentBridge: Tool = {
  name: 'intent_bridge',
  description:
    'Execute a compiled intent on a bridged workspace. This is your execution tool for cross-workspace operations.\n\n' +
    'Operations:\n' +
    "- Call a tool: { op: 'tool_call', tool: '<tool_name>', args: { ... } }\n" +
    "- Query data: { op: 'query', tool: 'query_bigquery', params: { sql: 'SELECT ...' }, responseFormat: 'json_table' }\n" +
    "- Invoke a capability: { op: 'capability', name: '<name>', input: { ... } }\n" +
    "- Discover capabilities: { op: 'discover', scope: 'tools' }\n\n" +
    'Financial domain tools (use op: tool_call):\n' +
    '- get_financial_snapshot: Complete financial summary (accounts, balances, income, spending, cashflow) in ONE call. Use this first for general financial questions.\n' +
    '- list_accounts: List all accounts with balances\n' +
    '- get_balance: Get current balance for one/all accounts\n' +
    '- get_balance_history: Estimated balance over time (chart-ready)\n' +
    '- get_transactions: Search and filter transactions (supports text search, date range, amount, category)\n' +
    '- get_spending_by_category: Spending breakdown by category (chart-ready)\n' +
    '- get_spending_by_merchant: Spending breakdown by merchant\n' +
    '- get_recurring_charges: Detect subscriptions and recurring bills\n' +
    '- get_income_summary: Income analysis\n' +
    '- get_cashflow: Income vs spending over time (chart-ready)',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Target workspace name or ID',
      },
      op: {
        type: 'string',
        enum: ['query', 'tool_call', 'aggregate', 'discover', 'capability'],
        description: 'Operation type',
      },
      tool: {
        type: 'string',
        description: 'Target tool name (e.g. query_bigquery, read_file)',
      },
      params: {
        type: 'object',
        description: 'For query ops: { sql?, table?, select?, where?, groupBy?, limit? }',
      },
      args: {
        type: 'object',
        description: 'For tool_call ops: the tool arguments',
      },
      responseFormat: {
        type: 'string',
        enum: ['json_table', 'csv', 'summary', 'scalar'],
        description: 'Desired response format (for query ops)',
      },
      scope: {
        type: 'string',
        enum: ['tools', 'tables', 'capabilities'],
        description: 'For discover ops: what to discover',
      },
      name: {
        type: 'string',
        description: 'For capability ops: the capability name (e.g. risk.calculateVar)',
      },
      input: {
        type: 'object',
        description: 'For capability ops: typed input for the capability',
      },
    },
    required: ['target', 'op'],
  },

  /**
   * Execute a compiled intent on a bridged workspace.
   *
   * Flow:
   *  1. Resolve bridge + contract from manifest
   *  2. Build the IntentOperation from tool args
   *  3. Validate, sign, and send as a JSON-RPC intent/execute call
   *  4. Verify the result signature and return structured data
   */
  async execute(args: any, _workspaceConfig: any = {}) {
    const { target, op, tool, params, args: toolArgs, responseFormat, scope, name, input } = args;

    if (!target || !op) {
      return { success: false, error: 'target and op are required' };
    }

    // ── 1. Fetch manifest and resolve bridge ─────────────────────
    const manifest = await fetchManifest();
    const bridges = manifest.RT_BRIDGES;

    if (!bridges || !bridges.length) {
      return {
        success: false,
        error: 'No bridges configured for this workspace. Ask an admin to create a bridge in the dashboard.',
      };
    }

    const bridge = bridges.find(
      (b) =>
        b.targetName.toLowerCase() === target.toLowerCase() ||
        b.targetWsId === target ||
        b.bridgeId === target
    );

    if (!bridge) {
      const available = bridges.map((b) => b.targetName).join(', ');
      return {
        success: false,
        error: `No bridge found for "${target}". Available bridges: ${available || 'none'}`,
      };
    }

    // ── 2. Contract enforcement ──────────────────────────────────
    const contracts = manifest.RT_CONTRACTS;
    let contract = null;
    if (contracts && Array.isArray(contracts)) {
      try {
        contract = contracts.find(
          (c) =>
            c.direction === 'outbound' &&
            c.counterparty.wsId === bridge.targetWsId &&
            c.status === 'active'
        );
      } catch { /* intentionally empty */ }
    }

    if (!contract) {
      return {
        success: false,
        error: `No active governance contract with "${bridge.targetName}". A contract must be approved before any cross-workspace activity. Do NOT retry — this requires administrator action to establish a contract.`,
        permanent: true,
      };
    }

    const targetUrl = bridge.targetUrl;
    if (!targetUrl) {
      return {
        success: false,
        error: `No A2A endpoint configured for "${bridge.targetName}". Contact an administrator.`,
      };
    }

    // ── 3. Construct the IntentOperation from args ───────────────
    let intent: IntentOperation;

    switch (op) {
      case 'query':
        intent = {
          op: 'query',
          tool: tool || '',
          params: params || {},
          responseFormat: responseFormat || 'json_table',
        };
        break;

      case 'tool_call':
        intent = {
          op: 'tool_call',
          tool: tool || '',
          args: toolArgs || {},
        };
        break;

      case 'aggregate':
        // Aggregate expects steps in params — pass through
        intent = {
          op: 'aggregate',
          steps: (params?.steps as any[]) || [],
          reduce: (params?.reduce as 'concat' | 'merge' | 'last') || 'last',
        };
        break;

      case 'discover':
        intent = {
          op: 'discover',
          scope: (scope as 'tools' | 'tables' | 'capabilities') || 'tools',
        };
        break;

      case 'capability':
        intent = {
          op: 'capability',
          name: name || '',
          input: input || {},
        } as IntentOperation;
        break;

      default:
        return { success: false, error: `Unknown operation type: "${op}"` };
    }

    // ── 4. Validate the intent ───────────────────────────────────
    const validation = validateIntent(intent);
    if (!validation.valid) {
      return { success: false, error: `Invalid intent: ${validation.error}` };
    }

    // ── 5. Check ORG_MASTER_SECRET ───────────────────────────────
    const masterSecret = process.env.ORG_MASTER_SECRET;
    if (!masterSecret) {
      return {
        success: false,
        error: 'ORG_MASTER_SECRET not configured. Intent bridge requires contract-based authentication.',
      };
    }

    // ── 6. Build signed intent token ─────────────────────────────
    try {
      const { deriveContractKey, signRequest } = require('../utils/contractAuth');

      const signedToken = await buildIntentToken(
        intent,
        contract.contractId,
        contract.version || 1,
        masterSecret,
      );

      // ── 7. Build contract-level auth headers ─────────────────
      const timestamp = Date.now().toString();
      const contractKey = await deriveContractKey(
        masterSecret,
        contract.contractId,
        contract.version || 1,
      );
      const action = intentOpToAction(intent);
      const contractSignature = signRequest(contractKey, contract.contractId, timestamp, action);

      const a2aEndpoint = `${targetUrl.replace(/\/$/, '')}/a2a`;

      // ── 8. Send JSON-RPC intent/execute ──────────────────────
      const requestId = crypto.randomUUID();
      const startTime = Date.now();

      const requestBody = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'intent/execute',
        params: {
          token: signedToken,
        },
      });

      const requestHeaders = {
        'Content-Type': 'application/json',
        'X-Contract-Id': contract.contractId,
        'X-Contract-Signature': contractSignature,
        'X-Contract-Timestamp': timestamp,
        'X-Contract-Action': action,
      };

      let response = await fetch(a2aEndpoint, {
        method: 'POST',
        headers: requestHeaders,
        body: requestBody,
        signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
      });

      // ── Wake-on-request: retry if workspace is sleeping ──────
      if (response.status === 502 || response.status === 503) {
        const isSleeping = await detectSleepingWorkspace(response);

        if (isSleeping) {
          console.log(`[intent_bridge] ${bridge.targetName} is sleeping — waking and retrying (up to ${MAX_WAKE_WAIT_MS / 1000}s)`);

          // Scale the target deployment from 0 → 1 via K8s API
          await wakeWorkspace(bridge.targetWsId);

          const wakeStart = Date.now();
          let woke = false;

          while (Date.now() - wakeStart < MAX_WAKE_WAIT_MS) {
            await sleep(WAKE_RETRY_INTERVAL_MS);

            // Re-sign the request (timestamp must be fresh for HMAC)
            const retryTimestamp = Date.now().toString();
            const retrySignature = signRequest(contractKey, contract.contractId, retryTimestamp, action);

            try {
              response = await fetch(a2aEndpoint, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Contract-Id': contract.contractId,
                  'X-Contract-Signature': retrySignature,
                  'X-Contract-Timestamp': retryTimestamp,
                  'X-Contract-Action': action,
                },
                body: requestBody,
                signal: AbortSignal.timeout(INTENT_TIMEOUT_MS),
              });

              const elapsed = Math.round((Date.now() - wakeStart) / 1000);
              if (response.ok) {
                woke = true;
                console.log(`[intent_bridge] ${bridge.targetName} is awake after ${elapsed}s`);
                break;
              } else {
                console.log(`[intent_bridge] Retry at ${elapsed}s → HTTP ${response.status}`);
              }
            } catch (retryErr: any) {
              const elapsed = Math.round((Date.now() - wakeStart) / 1000);
              console.log(`[intent_bridge] Retry at ${elapsed}s failed: ${retryErr.message}`);
            }
          }

          if (!woke && !response.ok) {
            return {
              success: false,
              error: `${bridge.targetName} did not respond after ${MAX_WAKE_WAIT_MS / 1000}s. The workspace may still be starting up — try again in a moment.`,
              workspaceWaking: true,
            };
          }
        } else {
          // Non-wake 503 — return error immediately
          const body = await response.text();
          return {
            success: false,
            error: `Intent execution failed: ${response.status} ${body.slice(0, 200)}`,
          };
        }
      }

      if (!response.ok) {
        const body = await response.text();
        return {
          success: false,
          error: `Intent execution failed: ${response.status} ${body.slice(0, 200)}`,
        };
      }

      const rpcResponse = await response.json();

      // ── 9. Parse and verify the IntentResult ─────────────────
      if (rpcResponse.error) {
        return {
          success: false,
          error: `Remote error: ${rpcResponse.error.message || JSON.stringify(rpcResponse.error)}`,
        };
      }

      const result = rpcResponse.result as IntentResult;

      if (!result || !result.signature) {
        return {
          success: false,
          error: 'Invalid response: missing intent result or signature',
        };
      }

      // Verify the result signature from the receiving workspace
      const resultValid = verifyIntentResult(result, contractKey);
      if (!resultValid) {
        return {
          success: false,
          error: 'Intent result signature verification failed — response may have been tampered with',
        };
      }

      // ── 10. Handle result status ─────────────────────────────
      if (result.status === 'error') {
        return {
          success: false,
          error: result.error || 'Intent execution failed on remote workspace',
          executionMs: result.executionMs,
          protocol: 'intent',
        };
      }

      if (result.status === 'denied') {
        return {
          success: false,
          error: result.error || 'Intent was denied by the remote workspace',
          executionMs: result.executionMs,
          protocol: 'intent',
        };
      }

      const roundTripMs = Date.now() - startTime;

      return {
        success: true,
        target,
        data: result.data,
        executionMs: result.executionMs,
        roundTripMs,
        toolExecuted: result.toolExecuted,
        protocol: 'intent',
        tokensSaved: ESTIMATED_TOKENS_SAVED,
        ...(result.cached ? { cached: true } : {}),
        ...(result.proof ? { proof: { inputHash: result.proof.inputHash, outputHash: result.proof.outputHash } } : {}),
        ...(result.compilation ? { compilation: result.compilation } : {}),
      };
    } catch (err: any) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        return {
          success: false,
          error: `Intent execution timed out after ${INTENT_TIMEOUT_MS / 1000} seconds`,
        };
      }
      return {
        success: false,
        error: `Intent bridge failed: ${err.message}`,
      };
    }
  },
};

export default intentBridge;
