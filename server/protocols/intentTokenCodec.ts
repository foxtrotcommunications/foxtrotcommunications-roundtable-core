// server/protocols/intentTokenCodec.ts — Intent Token Codec
// Handles serialization, canonicalization, signing, verification,
// encryption, and decryption of intent tokens.

import crypto from 'crypto';
import type {
  IntentToken, IntentResult, IntentOperation,
} from './intentToken';

// Re-use existing HKDF key derivation from contractAuth
// @ts-ignore — contractAuth.js is plain JS
import { deriveContractKey, encryptPayload, decryptPayload } from '../utils/contractAuth';
// @ts-ignore — contractKeys.js is plain JS
import { acceptOrgKey, logOrgKeyAccepted } from '../utils/contractKeys';

// ─── Canonicalization ───────────────────────────────────────────────────────

/** Deterministic JSON serialization for signing.
 *  Sorts keys recursively to ensure identical tokens produce identical signatures. */
export function canonicalize(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted: Record<string, unknown>, k) => {
        sorted[k] = (value as Record<string, unknown>)[k];
        return sorted;
      }, {});
    }
    return value;
  });
}

// ─── Token Signing Body ─────────────────────────────────────────────────────

/** Extract the signable portion of a token (everything except signature) */
function getSignableBody(token: Omit<IntentToken, 'signature'>): string {
  const body = {
    version: token.version,
    type: token.type,
    id: token.id,
    intent: token.encrypted ? '__encrypted__' : token.intent,
    contractId: token.contractId,
    contractVersion: token.contractVersion,
    timestamp: token.timestamp,
    expiry: token.expiry,
    nonce: token.nonce,
    ...(token.encryptedIntent ? { encryptedIntent: token.encryptedIntent } : {}),
    // Added only when present so a legacy (org-key) token's signed body is
    // byte-identical to before 5.1.
    ...(token.sender ? { sender: token.sender } : {}),
  };
  return canonicalize(body);
}

// ─── Build ──────────────────────────────────────────────────────────────────

export interface BuildOptions {
  expiryMs?: number;     // Default: 300_000 (5 min)
  encrypt?: boolean;     // Default: true
  /**
   * Per-party signing (5.1): sign (and encrypt) with key(contract, sender)
   * and stamp `sender` on the token. Both or neither; with neither the token
   * is a legacy org-key token derived from `masterSecret`.
   */
  partyKey?: Buffer;
  sender?: string;
}

/** Build a signed (and optionally encrypted) intent token */
export async function buildIntentToken(
  intent: IntentOperation,
  contractId: string,
  contractVersion: number,
  masterSecret: string,
  options: BuildOptions = {},
): Promise<IntentToken> {
  const { expiryMs = 300_000, encrypt = true, partyKey, sender } = options;
  if ((partyKey && !sender) || (!partyKey && sender)) {
    throw new Error('buildIntentToken: partyKey and sender go together');
  }

  const now = Date.now();
  const contractKey: Buffer = partyKey
    ? partyKey
    : await deriveContractKey(masterSecret, contractId, contractVersion);

  // Build the base token
  const token: Partial<IntentToken> = {
    version: 1,
    type: 'intent_token',
    id: crypto.randomUUID(),
    contractId,
    contractVersion,
    timestamp: new Date(now).toISOString(),
    expiry: new Date(now + expiryMs).toISOString(),
    nonce: crypto.randomBytes(16).toString('hex'),
    ...(sender ? { sender } : {}),
  };

  // Optionally encrypt the intent body
  if (encrypt) {
    const encrypted = encryptPayload(contractKey, intent);
    token.encrypted = true;
    token.encryptedIntent = encrypted;
    // Intent is not included in plaintext when encrypted
  } else {
    token.intent = intent;
    token.encrypted = false;
  }

  // Sign the token
  const signable = getSignableBody(token as Omit<IntentToken, 'signature'>);
  const hmac = crypto.createHmac('sha256', contractKey);
  hmac.update(signable);
  token.signature = hmac.digest('hex');

  return token as IntentToken;
}

// ─── Verify ─────────────────────────────────────────────────────────────────

export interface VerifyResult {
  valid: boolean;
  error?: string;
  contractKey?: Buffer;
  /** 'party' when verified with key(contract, token.sender); 'org' for a legacy token. */
  keyKind?: 'party' | 'org';
}

/**
 * Looks up key(contractId, version, sender) for the receiver — pooled via
 * tenantCredentials, dedicated via RT_CONTRACT_KEYS (utils/contractKeys.js
 * resolvePartyKey, pre-bound to the tenant). null = no such key.
 */
export type PartyKeyResolver = (contractId: string, version: number, sender: string) => Promise<Buffer | null>;

export interface VerifyOptions {
  maxAgeMs?: number;
  /**
   * 5.1: required to accept a token that names a `sender`. Without a
   * resolver a sender-bearing token is invalid (fail closed) — the receiver
   * has no way to know the sender's key.
   */
  partyKeyResolver?: PartyKeyResolver;
}

/**
 * Verify an intent token's signature, expiry, and freshness.
 *
 * Key selection (5.1): a token with `sender` MUST verify with
 * key(contract, sender) from `partyKeyResolver`; a token without one is a
 * legacy org-key token, derived from `masterSecret`, accepted only while
 * RT_ACCEPT_ORG_KEY !== 'false' and logged as deprecated. Which party may
 * send (sender ∈ parties, sender is the counterparty) is the caller's check
 * against the manifest — this function only answers "did sender sign it".
 */
export async function verifyIntentToken(
  token: IntentToken,
  masterSecret: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const { maxAgeMs = 300_000, partyKeyResolver } = options;

  // 1. Check required fields
  if (token.version !== 1 || token.type !== 'intent_token') {
    return { valid: false, error: 'Invalid token version or type' };
  }
  if (!token.id || !token.contractId || !token.signature || !token.timestamp || !token.expiry || !token.nonce) {
    return { valid: false, error: 'Missing required token fields' };
  }

  // 2. Check expiry
  const now = Date.now();
  const expiryTime = new Date(token.expiry).getTime();
  if (isNaN(expiryTime) || now > expiryTime) {
    return { valid: false, error: 'Token has expired' };
  }

  // 3. Check timestamp freshness
  const tokenTime = new Date(token.timestamp).getTime();
  if (isNaN(tokenTime) || Math.abs(now - tokenTime) > maxAgeMs) {
    return { valid: false, error: 'Token timestamp outside acceptable window' };
  }

  // 4. Pick the key: the sender's party key, or the legacy org-derived key.
  let contractKey: Buffer;
  let keyKind: 'party' | 'org';
  if (token.sender) {
    if (typeof token.sender !== 'string') {
      return { valid: false, error: 'Token sender must be a workspace id' };
    }
    if (!partyKeyResolver) {
      return { valid: false, error: 'Token names a sender but this receiver cannot resolve party keys' };
    }
    const key = await partyKeyResolver(token.contractId, Number(token.contractVersion) || 1, token.sender);
    if (!key) {
      return { valid: false, error: `No party key for sender ${token.sender} under contract ${token.contractId}` };
    }
    contractKey = key;
    keyKind = 'party';
  } else {
    if (!acceptOrgKey()) {
      return { valid: false, error: 'Token has no sender; org-key tokens are no longer accepted (RT_ACCEPT_ORG_KEY=false)' };
    }
    if (!masterSecret) {
      return { valid: false, error: 'Token has no sender and no org master secret is available' };
    }
    contractKey = await deriveContractKey(masterSecret, token.contractId, token.contractVersion);
    keyKind = 'org';
  }

  // 5. Verify signature (timing-safe)
  const signable = getSignableBody(token);
  const hmac = crypto.createHmac('sha256', contractKey);
  hmac.update(signable);
  const expectedSig = hmac.digest('hex');

  const sigBuffer = Buffer.from(token.signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSig, 'hex');

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return { valid: false, error: 'Invalid token signature' };
  }

  if (keyKind === 'org') logOrgKeyAccepted(token.contractId, 'token');
  return { valid: true, contractKey, keyKind };
}

// ─── Decrypt ────────────────────────────────────────────────────────────────

/** Decrypt an encrypted intent token's body, returning a token with plaintext intent */
export async function decryptIntentToken(
  token: IntentToken,
  contractKey: Buffer,
): Promise<{ token: IntentToken; error?: string }> {
  if (!token.encrypted || !token.encryptedIntent) {
    // Already plaintext
    return { token };
  }

  const { iv, ciphertext, authTag } = token.encryptedIntent;
  const result = decryptPayload(contractKey, iv, ciphertext, authTag);

  if (result.error) {
    return { token, error: `Decryption failed: ${result.error}` };
  }

  // Return a new token with the decrypted intent and encrypted fields removed
  const decrypted: IntentToken = {
    ...token,
    intent: result.data as IntentOperation,
    encrypted: false,
  };
  delete (decrypted as any).encryptedIntent;

  return { token: decrypted };
}

// ─── Result Signing ─────────────────────────────────────────────────────────

/** Sign an intent result so the sender can verify authenticity */
export function signIntentResult(
  result: Omit<IntentResult, 'signature'>,
  contractKey: Buffer,
): IntentResult {
  const signable = canonicalize(result as Record<string, unknown>);
  const hmac = crypto.createHmac('sha256', contractKey);
  hmac.update(signable);
  return {
    ...result,
    signature: hmac.digest('hex'),
  } as IntentResult;
}

/** Verify an intent result signature */
export function verifyIntentResult(
  result: IntentResult,
  contractKey: Buffer,
): boolean {
  const { signature, ...body } = result;
  const signable = canonicalize(body as Record<string, unknown>);
  const hmac = crypto.createHmac('sha256', contractKey);
  hmac.update(signable);
  const expected = hmac.digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
}
