// server/protocols/executionProof.ts — Verifiable Execution Traces
// Generates cryptographic proofs that a specific computation produced a
// specific result under specific policy constraints. Enables audit-grade
// traceability for cross-workspace intent execution.

import crypto from 'crypto';
import { canonicalize } from './intentTokenCodec';
import type { IntentOperation } from './intentToken';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A policy check that was applied during execution */
export interface PolicyCheck {
  type: 'sql_safety' | 'action_auth' | 'tool_exists' | 'capability_exists' | 'rate_limit' | 'data_scope';
  passed: boolean;
  detail?: string;
}

/**
 * Proof grade determines the evidentiary weight of an execution proof.
 *
 * - 'audit': Capability execution with typed inputs/outputs.
 *   Semantically meaningful, suitable for regulatory audit.
 *   e.g. "risk.calculateVar was invoked with {product: 'CL', qty: 500}"
 *
 * - 'trace': Raw tool execution (query/tool_call).
 *   Useful for debugging and monitoring, but not audit-grade.
 *   e.g. "this SQL string was executed on BigQuery"
 */
export type ProofGrade = 'audit' | 'trace';

/** Cryptographic proof of execution */
export interface ExecutionProof {
  /** Evidentiary grade: 'audit' (capability) or 'trace' (raw tool) */
  proofGrade: ProofGrade;
  /** SHA-256 hash of the canonical intent input */
  inputHash: string;
  /** SHA-256 hash of the canonical execution output */
  outputHash: string;
  /** The tool or capability that was executed */
  toolName: string;
  /** Wall-clock execution time in milliseconds */
  executionMs: number;
  /** Contract that authorized this execution */
  contractId: string;
  /** All policy checks applied (passed and failed) */
  policyChecks: PolicyCheck[];
  /** ISO 8601 timestamp of execution */
  timestamp: string;
  /** HMAC signature of the proof itself (tamper detection) */
  proofSignature: string;
}

// ─── Hash Helpers ───────────────────────────────────────────────────────────

/** SHA-256 hash of any value via canonical JSON */
function hashValue(value: unknown): string {
  const canonical = typeof value === 'string'
    ? value
    : canonicalize(value as Record<string, unknown>);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ─── Proof Builder ──────────────────────────────────────────────────────────

/**
 * Build a verifiable execution proof.
 *
 * @param intent       - The intent operation that was executed
 * @param result       - The execution result (data or error)
 * @param toolName     - The tool that was invoked
 * @param executionMs  - Wall-clock execution time
 * @param contractId   - The contract that authorized execution
 * @param contractKey  - The contract key for signing the proof
 * @param policyChecks - All policy checks applied during execution
 */
export function buildProof(
  intent: IntentOperation,
  result: unknown,
  toolName: string,
  executionMs: number,
  contractId: string,
  contractKey: Buffer,
  policyChecks: PolicyCheck[],
): ExecutionProof {
  const inputHash = hashValue(intent);
  const outputHash = hashValue(result ?? { empty: true });
  const timestamp = new Date().toISOString();

  // Capability executions produce audit-grade proofs.
  // Raw tool access (query/tool_call) produces informational traces.
  const proofGrade: ProofGrade = intent.op === 'capability' ? 'audit' : 'trace';

  // Build the proof body (everything except proofSignature)
  const proofBody = {
    proofGrade,
    inputHash,
    outputHash,
    toolName,
    executionMs,
    contractId,
    policyChecks,
    timestamp,
  };

  // Sign the proof for tamper detection
  const proofSignature = crypto
    .createHmac('sha256', contractKey)
    .update(canonicalize(proofBody))
    .digest('hex');

  return {
    ...proofBody,
    proofSignature,
  };
}

// ─── Proof Verification ─────────────────────────────────────────────────────

/**
 * Verify an execution proof's integrity.
 *
 * Checks:
 * 1. Proof signature is valid (not tampered)
 * 2. Input hash matches the provided intent (optional)
 * 3. Output hash matches the provided result (optional)
 *
 * @param proof       - The execution proof to verify
 * @param contractKey - The contract key used to sign
 * @param intent      - Optional: verify input hash matches this intent
 * @param result      - Optional: verify output hash matches this result
 */
export function verifyProof(
  proof: ExecutionProof,
  contractKey: Buffer,
  intent?: IntentOperation,
  result?: unknown,
): { valid: boolean; error?: string } {
  // 1. Verify proof signature
  const { proofSignature, ...body } = proof;
  const expectedSig = crypto
    .createHmac('sha256', contractKey)
    .update(canonicalize(body as Record<string, unknown>))
    .digest('hex');

  const sigBuf = Buffer.from(proofSignature, 'hex');
  const expBuf = Buffer.from(expectedSig, 'hex');

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, error: 'Proof signature verification failed' };
  }

  // 2. Optionally verify input hash
  if (intent) {
    const expectedInputHash = hashValue(intent);
    if (proof.inputHash !== expectedInputHash) {
      return { valid: false, error: 'Input hash does not match provided intent' };
    }
  }

  // 3. Optionally verify output hash
  if (result !== undefined) {
    const expectedOutputHash = hashValue(result);
    if (proof.outputHash !== expectedOutputHash) {
      return { valid: false, error: 'Output hash does not match provided result' };
    }
  }

  return { valid: true };
}
