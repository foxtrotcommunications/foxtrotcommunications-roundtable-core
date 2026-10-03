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
  type: 'sql_safety' | 'action_auth' | 'tool_exists' | 'capability_exists' | 'rate_limit' | 'data_scope' | 'pooled_op_restriction';
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

/**
 * What actually ran, collected by the executor as it goes (upgrade plan
 * 1.4). `sql` holds every SQL string handed to a tool, in execution order,
 * AFTER the fusion compiler and LIMIT injection — the compiled text, not the
 * requested text, which `inputHash` already covers.
 */
export interface ExecutionTrace {
  sql: string[];
}

/** SHA-256 over the canonical JSON array of executed SQL strings. */
export function hashExecutedSql(sql: string[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(sql)).digest('hex');
}

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
  /**
   * SHA-256 of the SQL strings actually executed (compiled form, in order) —
   * present only when at least one SQL step ran. Additive: proofs without
   * SQL, and proofs minted before this field existed, verify unchanged.
   */
  executedSqlHash?: string;
  /** Number of SQL statements behind executedSqlHash. */
  executedSqlCount?: number;
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
 * @param trace        - Optional: what actually ran (executed SQL)
 */
export function buildProof(
  intent: IntentOperation,
  result: unknown,
  toolName: string,
  executionMs: number,
  contractId: string,
  contractKey: Buffer,
  policyChecks: PolicyCheck[],
  trace?: ExecutionTrace,
): ExecutionProof {
  const inputHash = hashValue(intent);
  const outputHash = hashValue(result ?? { empty: true });
  const timestamp = new Date().toISOString();

  // Capability executions produce audit-grade proofs.
  // Raw tool access (query/tool_call) produces informational traces.
  const proofGrade: ProofGrade = intent.op === 'capability' ? 'audit' : 'trace';

  // Build the proof body (everything except proofSignature). The executed-SQL
  // fields are added only when SQL ran, so the signed body of a no-SQL proof
  // is byte-identical to before.
  const proofBody: Omit<ExecutionProof, 'proofSignature'> = {
    proofGrade,
    inputHash,
    outputHash,
    toolName,
    executionMs,
    contractId,
    policyChecks,
    timestamp,
    ...(trace && trace.sql.length > 0
      ? { executedSqlHash: hashExecutedSql(trace.sql), executedSqlCount: trace.sql.length }
      : {}),
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
 * @param executedSql - Optional: verify executedSqlHash matches these statements
 */
export function verifyProof(
  proof: ExecutionProof,
  contractKey: Buffer,
  intent?: IntentOperation,
  result?: unknown,
  executedSql?: string[],
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

  // 4. Optionally verify the executed-SQL hash
  if (executedSql !== undefined) {
    if (!proof.executedSqlHash) {
      return { valid: false, error: 'Proof carries no executedSqlHash' };
    }
    if (proof.executedSqlHash !== hashExecutedSql(executedSql)) {
      return { valid: false, error: 'Executed SQL hash does not match provided statements' };
    }
  }

  return { valid: true };
}
