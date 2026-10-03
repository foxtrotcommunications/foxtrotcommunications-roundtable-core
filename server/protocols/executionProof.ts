// server/protocols/executionProof.ts — Verifiable Execution Traces
// Generates cryptographic proofs that a specific computation produced a
// specific result under specific policy constraints. Enables audit-grade
// traceability for cross-workspace intent execution.
//
// Two signatures (upgrade plan 5.2):
//   proofSignature — HMAC-SHA256 with the contract key. Symmetric: anyone
//     holding the key (both parties, the control plane) could have produced
//     it, so it proves integrity between the parties, not WHO executed.
//   signature      — Ed25519 by the EXECUTING party's per-contract signing
//     key (minted by the control plane at approval; the public key rides the
//     manifest as contract.signing[wsId]). Anyone with the manifest can
//     verify it with no secret at all — scripts/verify-proof.js is that
//     verifier. Attached alongside the HMAC, never instead of it.

import crypto from 'crypto';
import { canonicalize } from './intentTokenCodec';
import type { IntentOperation } from './intentToken';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A policy check that was applied during execution */
export interface PolicyCheck {
  type: 'sql_safety' | 'action_auth' | 'tool_exists' | 'capability_exists' | 'rate_limit' | 'data_scope' | 'pooled_op_restriction' | 'prerequisite';
  passed: boolean;
  detail?: string;
  /** For type 'prerequisite' (5.3): amount_max | freshness_hours | grant_required | invalid | <unknown kind>. */
  kind?: string;
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

/** Ed25519 signature by the executing party (5.2). */
export interface ProofSignature {
  alg: 'ed25519';
  /** Workspace id of the party whose key signed; look up contract.signing[signer]. */
  signer: string;
  /** base64 Ed25519 signature over proofSigningDigest(proof). */
  sig: string;
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
  /** The intent token's nonce — binds the proof to one request (5.2). */
  nonce?: string;
  /** SHA-256 of the canonical intent token id+nonce+contract, when known (5.2). */
  intentHash?: string;
  /** Ed25519 signature by the executing party (5.2); covered by proofSignature. */
  signature?: ProofSignature;
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

// ─── Ed25519 signing digest ─────────────────────────────────────────────────

/** Unit separator between fields; SQL never contains it, hex/ISO never do. */
const FIELD_SEP = '\x1f';

/**
 * What the executing party signs (5.2):
 *
 *   sha256( executedSqlHash ∥ outputHash ∥ nonce ∥ timestamp ∥ contractId ∥ intentHash )
 *
 * fields joined with 0x1f; absent fields are the empty string. Every input
 * is already in the proof, so a verifier needs only the proof and the
 * manifest public key — no SQL text, no result payload, no secret.
 * `executedSqlHash` is the hash of the compiled SQL that ran (hashExecutedSql
 * over the ordered statements); a holder of the statements can check it
 * separately (verifyProof's executedSql argument).
 */
export function proofSigningDigest(p: Pick<ExecutionProof, 'executedSqlHash' | 'outputHash' | 'nonce' | 'timestamp' | 'contractId' | 'intentHash' | 'inputHash'>): Buffer {
  const fields = [
    p.executedSqlHash || '',
    p.outputHash,
    p.nonce || '',
    p.timestamp,
    p.contractId,
    p.intentHash || p.inputHash,
  ];
  return crypto.createHash('sha256').update(fields.join(FIELD_SEP), 'utf8').digest();
}

/** The executing party's Ed25519 key, when it has one for this contract. */
export interface ProofSigner {
  wsId: string;
  /** PKCS8 PEM (Secret Manager `signingKey` / RT_CONTRACT_KEYS `signingKey`). */
  privateKeyPem: string;
}

export function signProofDigest(digest: Buffer, signer: ProofSigner): ProofSignature {
  const key = crypto.createPrivateKey(signer.privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Proof signing key must be Ed25519');
  return { alg: 'ed25519', signer: signer.wsId, sig: crypto.sign(null, digest, key).toString('base64') };
}

export function verifyProofSignature(proof: ExecutionProof, publicKeyPem: string): { valid: boolean; error?: string } {
  const sig = proof.signature;
  if (!sig || sig.alg !== 'ed25519' || typeof sig.sig !== 'string') {
    return { valid: false, error: 'Proof carries no Ed25519 signature' };
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey(publicKeyPem);
  } catch (e) {
    return { valid: false, error: `Bad public key: ${(e as Error).message}` };
  }
  if (key.asymmetricKeyType !== 'ed25519') return { valid: false, error: 'Public key is not Ed25519' };
  let ok = false;
  try {
    ok = crypto.verify(null, proofSigningDigest(proof), key, Buffer.from(sig.sig, 'base64'));
  } catch {
    ok = false;
  }
  return ok ? { valid: true } : { valid: false, error: 'Ed25519 proof signature verification failed' };
}

/** Optional inputs to buildProof beyond the pre-5.2 positional ones. */
export interface ProofOptions {
  /** Intent token nonce — recorded in the proof and bound into both signatures. */
  nonce?: string;
  /** SHA-256 of the canonical intent-token identity (id, nonce, contractId). */
  intentHash?: string;
  /** The executing party's Ed25519 key; absent → HMAC-only proof as before. */
  signer?: ProofSigner;
}

/** intentHash for a token: sha256 of canonical { id, nonce, contractId, contractVersion }. */
export function intentHashOf(t: { id: string; nonce: string; contractId: string; contractVersion?: number }): string {
  return crypto.createHash('sha256')
    .update(canonicalize({ id: t.id, nonce: t.nonce, contractId: t.contractId, contractVersion: t.contractVersion ?? 1 }))
    .digest('hex');
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
 * @param opts         - Optional: nonce / intentHash to bind, Ed25519 signer (5.2)
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
  opts: ProofOptions = {},
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
    ...(opts.nonce ? { nonce: opts.nonce } : {}),
    ...(opts.intentHash ? { intentHash: opts.intentHash } : {}),
  };

  // Ed25519 by the executing party (5.2), when it holds a signing key. Goes
  // INSIDE the HMAC-covered body so the symmetric signature also vouches
  // for which party-signature was attached.
  if (opts.signer) {
    proofBody.signature = signProofDigest(proofSigningDigest(proofBody), opts.signer);
  }

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

/** What verifyProof may be given to check the signatures with (5.2). */
export interface ProofVerifyKeys {
  /** Contract key for the HMAC proofSignature. */
  contractKey?: Buffer;
  /** Manifest `contract.signing`: party wsId → Ed25519 public key (SPKI PEM). */
  publicKeys?: Record<string, string>;
}

/**
 * Verify an execution proof's integrity.
 *
 * Checks:
 * 1. Signature(s): with `publicKeys` and a proof that carries an Ed25519
 *    `signature`, the signer's public key verifies it — no secret needed;
 *    with a `contractKey` the HMAC proofSignature is verified. Both are
 *    checked when both are possible; at least one must be. A proof with
 *    an Ed25519 signature whose signer is not in `publicKeys` fails when
 *    public keys were supplied (an unknown signer is not "unsigned").
 * 2. Input hash matches the provided intent (optional)
 * 3. Output hash matches the provided result (optional)
 * 4. executedSqlHash matches the provided statements (optional)
 *
 * @param proof       - The execution proof to verify
 * @param keys        - A contract key (pre-5.2 call shape) or { contractKey?, publicKeys? }
 * @param intent      - Optional: verify input hash matches this intent
 * @param result      - Optional: verify output hash matches this result
 * @param executedSql - Optional: verify executedSqlHash matches these statements
 */
export function verifyProof(
  proof: ExecutionProof,
  keys: Buffer | ProofVerifyKeys,
  intent?: IntentOperation,
  result?: unknown,
  executedSql?: string[],
): { valid: boolean; error?: string; verifiedWith?: Array<'ed25519' | 'hmac'> } {
  const k: ProofVerifyKeys = Buffer.isBuffer(keys) ? { contractKey: keys } : (keys || {});
  const verifiedWith: Array<'ed25519' | 'hmac'> = [];

  // 1a. Ed25519 by the executing party, when we know the parties' keys.
  if (k.publicKeys) {
    if (proof.signature) {
      const pem = k.publicKeys[proof.signature.signer];
      if (!pem) return { valid: false, error: `No public key for proof signer ${proof.signature.signer}` };
      const r = verifyProofSignature(proof, pem);
      if (!r.valid) return r;
      verifiedWith.push('ed25519');
    } else if (!k.contractKey) {
      return { valid: false, error: 'Proof carries no Ed25519 signature and no contract key was supplied' };
    }
  }

  // 1b. HMAC with the contract key.
  if (k.contractKey) {
    const { proofSignature, ...body } = proof;
    const expectedSig = crypto
      .createHmac('sha256', k.contractKey)
      .update(canonicalize(body as Record<string, unknown>))
      .digest('hex');

    const sigBuf = Buffer.from(proofSignature || '', 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, error: 'Proof signature verification failed' };
    }
    verifiedWith.push('hmac');
  }

  if (verifiedWith.length === 0) {
    return { valid: false, error: 'No key to verify the proof with' };
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

  return { valid: true, verifiedWith };
}
