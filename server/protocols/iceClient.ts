// server/protocols/iceClient.ts — Programmatic ICE Client
// Enables tools and capability handlers to make outbound ICE calls
// to other workspaces. This is the "internal hop" mechanism — a
// capability on ws-risk can call a capability on ws-compliance
// without the origin PM ever seeing the hop.
//
// NOT a tool. NOT called by AI. Called programmatically by capability handlers.

import { buildIntentToken } from './intentTokenCodec';
import type { IntentOperation, IntentResult } from './intentToken';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IceCallOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Whether to encrypt the intent body (default: true) */
  encrypt?: boolean;
  /** Contract version (default: 1) */
  contractVersion?: number;
}

export interface IceCallResult {
  data?: unknown;
  error?: string;
  proof?: unknown;
  executionMs?: number;
  cached?: boolean;
}

// ─── ICE Client ─────────────────────────────────────────────────────────────

/**
 * Make a programmatic ICE call to another workspace.
 *
 * This is used by capability handlers to make internal hops.
 * The origin caller never sees these — they are encapsulated
 * inside the capability implementation.
 *
 * @param targetUrl    - The target workspace's base URL
 * @param contractId   - The governance contract authorizing this hop
 * @param intent       - The intent operation to execute
 * @param masterSecret - The ORG_MASTER_SECRET for key derivation
 * @param options      - Optional: timeout, encryption, contract version
 * @returns The execution result with optional proof
 */
export async function iceCall(
  targetUrl: string,
  contractId: string,
  intent: IntentOperation,
  masterSecret: string,
  options: IceCallOptions = {},
): Promise<IceCallResult> {
  const {
    timeoutMs = 30_000,
    encrypt = true,
    contractVersion = 1,
  } = options;

  try {
    // 1. Build and sign the intent token
    const token = await buildIntentToken(
      intent,
      contractId,
      contractVersion,
      masterSecret,
      { encrypt },
    );

    // 2. Send via JSON-RPC to target's /a2a endpoint
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${targetUrl}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: token.id,
          method: 'intent/execute',
          params: { token },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { error: `ICE call failed: HTTP ${response.status}` };
      }

      const rpc = await response.json() as {
        result?: IntentResult;
        error?: { message: string };
      };

      if (rpc.error) {
        return { error: `ICE call RPC error: ${rpc.error.message}` };
      }

      const result = rpc.result;
      if (!result) {
        return { error: 'ICE call returned empty result' };
      }

      if (result.status === 'error' || result.status === 'denied') {
        return { error: result.error || `ICE call ${result.status}` };
      }

      return {
        data: result.data,
        proof: result.proof,
        executionMs: result.executionMs,
        cached: result.cached,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { error: `ICE call timed out after ${timeoutMs}ms` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: `ICE call failed: ${message}` };
  }
}

/**
 * Convenience wrapper: make an ICE capability call to another workspace.
 * Builds the intent as a capability invocation.
 *
 * @param targetUrl      - Target workspace URL
 * @param contractId     - Governance contract ID
 * @param capabilityName - The capability to invoke (e.g. 'compliance.positionLimits')
 * @param input          - Typed input for the capability
 * @param masterSecret   - ORG_MASTER_SECRET
 * @param options        - Optional: timeout, encryption
 */
export async function iceCapabilityCall(
  targetUrl: string,
  contractId: string,
  capabilityName: string,
  input: Record<string, unknown>,
  masterSecret: string,
  options: IceCallOptions = {},
): Promise<IceCallResult> {
  const intent: IntentOperation = {
    op: 'capability',
    name: capabilityName,
    input,
  } as IntentOperation; // capability op will be added to the union type

  return iceCall(targetUrl, contractId, intent, masterSecret, options);
}
