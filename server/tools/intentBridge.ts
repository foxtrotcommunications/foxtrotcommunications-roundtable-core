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

/** Approximate prompt tokens saved by skipping LLM inference on the receiver */
const ESTIMATED_TOKENS_SAVED = '~4300';

// ─── Tool Definition ────────────────────────────────────────────────────────

const intentBridge: Tool = {
  name: 'intent_bridge',
  description:
    'Execute a compiled intent on a bridged workspace. This is your execution tool for cross-workspace operations.\n\n' +
    'Operations:\n' +
    "- Query data: { op: 'query', tool: 'query_bigquery', params: { sql: 'SELECT ...' }, responseFormat: 'json_table' }\n" +
    "- Call a tool: { op: 'tool_call', tool: 'read_file', args: { path: '/data/report.csv' } }\n" +
    "- Invoke a capability: { op: 'capability', name: 'risk.calculateVar', input: { product: 'CL' } }\n" +
    "- Discover capabilities: { op: 'discover', scope: 'capabilities' }",
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
        error: `No active governance contract with "${bridge.targetName}". A contract must be approved before any cross-workspace activity.`,
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

      const response = await fetch(a2aEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Contract-Id': contract.contractId,
          'X-Contract-Signature': contractSignature,
          'X-Contract-Timestamp': timestamp,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method: 'intent/execute',
          params: {
            token: signedToken,
          },
        }),
        signal: AbortSignal.timeout(INTENT_TIMEOUT_MS),
      });

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
