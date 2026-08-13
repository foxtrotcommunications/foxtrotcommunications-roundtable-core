// tests/integration/contractAuth.test.ts — Contract cryptography integration tests
//
// Tests HKDF-SHA256 key derivation, AES-256-GCM encrypt/decrypt,
// HMAC signing, verification (including timingSafeEqual), timestamp
// freshness, and findAndValidateContract logic.
//
// All tests use real crypto operations — no mocks on the crypto layer.

const {
  deriveContractKey,
  signRequest,
  verifyRequest,
  findAndValidateContract,
  encryptPayload,
  decryptPayload,
} = require('../../server/utils/contractAuth');

const crypto = require('crypto');

// ─── HKDF Key Derivation ──────────────────────────────────────────

describe('deriveContractKey (HKDF-SHA256)', () => {
  it('should return a 32-byte Buffer', async () => {
    const key = await deriveContractKey('master-secret', 'contract-1', 1);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it('should produce deterministic output — same inputs → same key', async () => {
    const key1 = await deriveContractKey('master-secret', 'contract-1', 1);
    const key2 = await deriveContractKey('master-secret', 'contract-1', 1);
    expect(key1.equals(key2)).toBe(true);
  });

  it('should produce different keys for different master secrets', async () => {
    const key1 = await deriveContractKey('secret-a', 'contract-1', 1);
    const key2 = await deriveContractKey('secret-b', 'contract-1', 1);
    expect(key1.equals(key2)).toBe(false);
  });

  it('should produce different keys for different contract IDs', async () => {
    const key1 = await deriveContractKey('master-secret', 'contract-a', 1);
    const key2 = await deriveContractKey('master-secret', 'contract-b', 1);
    expect(key1.equals(key2)).toBe(false);
  });

  it('should produce different keys for different versions', async () => {
    const key1 = await deriveContractKey('master-secret', 'contract-1', 1);
    const key2 = await deriveContractKey('master-secret', 'contract-1', 2);
    expect(key1.equals(key2)).toBe(false);
  });

  it('should default version to 1', async () => {
    const keyDefault = await deriveContractKey('master-secret', 'contract-1');
    const keyExplicit = await deriveContractKey('master-secret', 'contract-1', 1);
    expect(keyDefault.equals(keyExplicit)).toBe(true);
  });
});

// ─── AES-256-GCM Encryption ───────────────────────────────────────

describe('encryptPayload / decryptPayload (AES-256-GCM)', () => {
  let contractKey: Buffer;

  beforeAll(async () => {
    contractKey = await deriveContractKey('test-master-secret', 'enc-contract', 1);
  });

  it('should round-trip a string payload', () => {
    const plaintext = 'Hello, encrypted world!';
    const { iv, ciphertext, authTag } = encryptPayload(contractKey, plaintext);

    expect(typeof iv).toBe('string');
    expect(typeof ciphertext).toBe('string');
    expect(typeof authTag).toBe('string');

    const { data, error } = decryptPayload(contractKey, iv, ciphertext, authTag);
    expect(error).toBeUndefined();
    expect(data).toBe(plaintext);
  });

  it('should round-trip a JSON object payload', () => {
    const payload = { action: 'delegate', content: 'summarize this', meta: [1, 2, 3] };
    const { iv, ciphertext, authTag } = encryptPayload(contractKey, payload);
    const { data, error } = decryptPayload(contractKey, iv, ciphertext, authTag);

    expect(error).toBeUndefined();
    expect(data).toEqual(payload);
  });

  it('should produce different ciphertexts for the same plaintext (random IV)', () => {
    const plaintext = 'Same input, different output';
    const enc1 = encryptPayload(contractKey, plaintext);
    const enc2 = encryptPayload(contractKey, plaintext);

    // IVs should differ (12 random bytes each time)
    expect(enc1.iv).not.toBe(enc2.iv);
    // Ciphertexts should differ too
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it('should fail decryption when ciphertext is tampered with', () => {
    const { iv, ciphertext, authTag } = encryptPayload(contractKey, 'tamper me');

    // Flip a byte in the ciphertext
    const buf = Buffer.from(ciphertext, 'base64');
    buf[0] ^= 0xff;
    const tampered = buf.toString('base64');

    const { data, error } = decryptPayload(contractKey, iv, tampered, authTag);
    expect(data).toBeNull();
    expect(error).toMatch(/Decryption failed/);
  });

  it('should fail decryption when auth tag is tampered with', () => {
    const { iv, ciphertext, authTag } = encryptPayload(contractKey, 'tag test');

    const tagBuf = Buffer.from(authTag, 'base64');
    tagBuf[0] ^= 0xff;
    const tamperedTag = tagBuf.toString('base64');

    const { data, error } = decryptPayload(contractKey, iv, ciphertext, tamperedTag);
    expect(data).toBeNull();
    expect(error).toMatch(/Decryption failed/);
  });

  it('should fail decryption when IV is tampered with', () => {
    const { iv, ciphertext, authTag } = encryptPayload(contractKey, 'iv test');

    const ivBuf = Buffer.from(iv, 'base64');
    ivBuf[0] ^= 0xff;
    const tamperedIv = ivBuf.toString('base64');

    const { data, error } = decryptPayload(contractKey, tamperedIv, ciphertext, authTag);
    expect(data).toBeNull();
    expect(error).toMatch(/Decryption failed/);
  });

  it('should fail decryption with wrong key', async () => {
    const { iv, ciphertext, authTag } = encryptPayload(contractKey, 'wrong key test');
    const wrongKey = await deriveContractKey('different-secret', 'enc-contract', 1);

    const { data, error } = decryptPayload(wrongKey, iv, ciphertext, authTag);
    expect(data).toBeNull();
    expect(error).toMatch(/Decryption failed/);
  });
});

// ─── HMAC-SHA256 Signing ──────────────────────────────────────────

describe('signRequest (HMAC-SHA256)', () => {
  let contractKey: Buffer;

  beforeAll(async () => {
    contractKey = await deriveContractKey('sign-master', 'sign-contract', 1);
  });

  it('should produce a hex string', () => {
    const sig = signRequest(contractKey, 'contract-1', '1717000000000', 'message');
    expect(typeof sig).toBe('string');
    expect(sig).toMatch(/^[0-9a-f]{64}$/); // SHA-256 → 64 hex chars
  });

  it('should be deterministic', () => {
    const sig1 = signRequest(contractKey, 'contract-1', '1717000000000', 'message');
    const sig2 = signRequest(contractKey, 'contract-1', '1717000000000', 'message');
    expect(sig1).toBe(sig2);
  });

  it('should change when any input changes', () => {
    const base = signRequest(contractKey, 'contract-1', '1717000000000', 'message');
    const diffContract = signRequest(contractKey, 'contract-2', '1717000000000', 'message');
    const diffTime = signRequest(contractKey, 'contract-1', '1717000000001', 'message');
    const diffAction = signRequest(contractKey, 'contract-1', '1717000000000', 'delegate');

    expect(base).not.toBe(diffContract);
    expect(base).not.toBe(diffTime);
    expect(base).not.toBe(diffAction);
  });
});

// ─── Request Verification ─────────────────────────────────────────

describe('verifyRequest', () => {
  let contractKey: Buffer;

  beforeAll(async () => {
    contractKey = await deriveContractKey('verify-master', 'verify-contract', 1);
  });

  it('should accept a valid, fresh signature', () => {
    const timestamp = Date.now().toString();
    const sig = signRequest(contractKey, 'verify-contract', timestamp, 'message');

    const result = verifyRequest(contractKey, 'verify-contract', timestamp, 'message', sig);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should accept ISO timestamp format', () => {
    const timestamp = new Date().toISOString();
    const sig = signRequest(contractKey, 'verify-contract', timestamp, 'delegate');

    const result = verifyRequest(contractKey, 'verify-contract', timestamp, 'delegate', sig);
    expect(result.valid).toBe(true);
  });

  it('should reject an incorrect signature', () => {
    const timestamp = Date.now().toString();
    const wrongSig = 'a'.repeat(64); // valid hex but wrong value

    const result = verifyRequest(contractKey, 'verify-contract', timestamp, 'message', wrongSig);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid signature');
  });

  it('should reject a signature with mismatched action', () => {
    const timestamp = Date.now().toString();
    const sig = signRequest(contractKey, 'verify-contract', timestamp, 'message');

    // Verify with different action
    const result = verifyRequest(contractKey, 'verify-contract', timestamp, 'delegate', sig);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid signature');
  });

  it('should reject an expired timestamp (>5 min old)', () => {
    const oldTimestamp = (Date.now() - 6 * 60 * 1000).toString(); // 6 minutes ago
    const sig = signRequest(contractKey, 'verify-contract', oldTimestamp, 'message');

    const result = verifyRequest(contractKey, 'verify-contract', oldTimestamp, 'message', sig);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Contract signature expired');
  });

  it('should reject a future timestamp beyond the window', () => {
    const futureTimestamp = (Date.now() + 6 * 60 * 1000).toString(); // 6 min in the future
    const sig = signRequest(contractKey, 'verify-contract', futureTimestamp, 'message');

    const result = verifyRequest(contractKey, 'verify-contract', futureTimestamp, 'message', sig);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Contract signature expired');
  });

  it('should accept a timestamp within the 5-minute window', () => {
    const recentTimestamp = (Date.now() - 4 * 60 * 1000).toString(); // 4 minutes ago
    const sig = signRequest(contractKey, 'verify-contract', recentTimestamp, 'message');

    const result = verifyRequest(contractKey, 'verify-contract', recentTimestamp, 'message', sig);
    expect(result.valid).toBe(true);
  });

  it('should accept a custom maxAgeMs parameter', () => {
    const oldTimestamp = (Date.now() - 6 * 60 * 1000).toString();
    const sig = signRequest(contractKey, 'verify-contract', oldTimestamp, 'message');

    // 10 minute window — should accept
    const result = verifyRequest(contractKey, 'verify-contract', oldTimestamp, 'message', sig, 10 * 60 * 1000);
    expect(result.valid).toBe(true);
  });

  it('should reject an invalid timestamp string', () => {
    const sig = signRequest(contractKey, 'verify-contract', 'not-a-number', 'message');
    const result = verifyRequest(contractKey, 'verify-contract', 'not-a-number', 'message', sig);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid timestamp');
  });

  it('should reject non-hex signature format', () => {
    const timestamp = Date.now().toString();
    const result = verifyRequest(contractKey, 'verify-contract', timestamp, 'message', 'not-hex!!!');
    expect(result.valid).toBe(false);
    // Should be 'Invalid signature format' or 'Invalid signature' depending on how Buffer.from handles it
    expect(result.error).toMatch(/Invalid signature/);
  });

  it('should reject signature of wrong length', () => {
    const timestamp = Date.now().toString();
    const shortSig = 'aa'.repeat(16); // 32 hex = 16 bytes, not 32

    const result = verifyRequest(contractKey, 'verify-contract', timestamp, 'message', shortSig);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid signature');
  });
});

// ─── Full Sign → Verify Round-Trip ────────────────────────────────

describe('signRequest → verifyRequest round-trip', () => {
  it('should complete a full key-derive → sign → verify cycle', async () => {
    const masterSecret = 'org-master-secret-2024';
    const contractId = 'contract-abc-123';
    const version = 1;
    const action = 'delegate';

    // 1. Derive key on both sides (same master secret → same key)
    const senderKey = await deriveContractKey(masterSecret, contractId, version);
    const receiverKey = await deriveContractKey(masterSecret, contractId, version);

    // 2. Sender signs
    const timestamp = Date.now().toString();
    const signature = signRequest(senderKey, contractId, timestamp, action);

    // 3. Receiver verifies
    const result = verifyRequest(receiverKey, contractId, timestamp, action, signature);
    expect(result.valid).toBe(true);
  });

  it('should fail when receiver uses a different version', async () => {
    const masterSecret = 'org-master-secret-2024';
    const contractId = 'contract-abc-123';

    const senderKey = await deriveContractKey(masterSecret, contractId, 1);
    const receiverKey = await deriveContractKey(masterSecret, contractId, 2); // version bump!

    const timestamp = Date.now().toString();
    const signature = signRequest(senderKey, contractId, timestamp, 'message');

    const result = verifyRequest(receiverKey, contractId, timestamp, 'message', signature);
    expect(result.valid).toBe(false);
  });
});

// ─── Tenant-bound signatures (pooled runtime) ─────────────────────
// The X-Rt-Tenant claim is bound into the HMAC: header present → the trailing
// tenant is part of the signed string. Old-form signatures must stay
// byte-identical (dedicated fleet), and neither form may verify as the other.

describe('tenant-bound signRequest/verifyRequest', () => {
  const key = Buffer.alloc(32, 7);
  const ts = () => Date.now().toString();

  it('old form is byte-identical when tenantWsId is omitted', () => {
    const t = ts();
    expect(signRequest(key, 'c1', t, 'message')).toBe(
      signRequest(key, 'c1', t, 'message', undefined),
    );
  });

  it('round-trips with a tenant bound in', () => {
    const t = ts();
    const sig = signRequest(key, 'c1', t, 'message', 'ws-tenant-a');
    expect(verifyRequest(key, 'c1', t, 'message', sig, undefined, 'ws-tenant-a').valid).toBe(true);
  });

  it('rejects a tenant-bound signature replayed at a different tenant', () => {
    const t = ts();
    const sig = signRequest(key, 'c1', t, 'message', 'ws-tenant-a');
    expect(verifyRequest(key, 'c1', t, 'message', sig, undefined, 'ws-tenant-b').valid).toBe(false);
  });

  it('rejects cross-form: tenant-bound signature against old-form verify and vice versa', () => {
    const t = ts();
    const bound = signRequest(key, 'c1', t, 'message', 'ws-tenant-a');
    const old = signRequest(key, 'c1', t, 'message');
    expect(verifyRequest(key, 'c1', t, 'message', bound).valid).toBe(false);
    expect(verifyRequest(key, 'c1', t, 'message', old, undefined, 'ws-tenant-a').valid).toBe(false);
  });
});

// ─── Contract Manifest Validation ─────────────────────────────────

describe('findAndValidateContract', () => {
  const contracts = [
    {
      contractId: 'contract-active',
      status: 'active',
      allowedActions: ['message', 'delegate', 'query_data'],
    },
    {
      contractId: 'contract-suspended',
      status: 'suspended',
      allowedActions: ['message'],
    },
  ];

  it('should find and return an active contract', () => {
    const { contract, error } = findAndValidateContract(contracts, 'contract-active', 'message');
    expect(error).toBeUndefined();
    expect(contract).toBeDefined();
    expect(contract.contractId).toBe('contract-active');
  });

  it('should allow transport actions for active contracts', () => {
    // 'message' is a transport action — always allowed
    const { contract, error } = findAndValidateContract(contracts, 'contract-active', 'message');
    expect(error).toBeUndefined();
    expect(contract).toBeDefined();
  });

  it('should allow domain-specific actions in allowedActions', () => {
    const { contract, error } = findAndValidateContract(contracts, 'contract-active', 'query_data');
    expect(error).toBeUndefined();
    expect(contract).toBeDefined();
  });

  it('should reject domain-specific actions NOT in allowedActions', () => {
    const { contract, error } = findAndValidateContract(contracts, 'contract-active', 'admin_delete');
    expect(contract).toBeUndefined();
    expect(error).toMatch(/not permitted/);
  });

  it('should reject unknown contractId', () => {
    const { contract, error } = findAndValidateContract(contracts, 'contract-nonexistent', 'message');
    expect(contract).toBeUndefined();
    expect(error).toMatch(/Unknown contract/);
  });

  it('should reject suspended contracts', () => {
    const { contract, error } = findAndValidateContract(contracts, 'contract-suspended', 'message');
    expect(contract).toBeUndefined();
    expect(error).toMatch(/not active/);
  });

  it('should handle null contracts array', () => {
    const { error } = findAndValidateContract(null, 'contract-active', 'message');
    expect(error).toBe('No contracts configured');
  });

  it('should handle empty contracts array', () => {
    const { error } = findAndValidateContract([], 'contract-active', 'message');
    expect(error).toMatch(/Unknown contract/);
  });

  it('should handle non-array contracts', () => {
    const { error } = findAndValidateContract('not-an-array' as any, 'contract-active', 'message');
    expect(error).toBe('No contracts configured');
  });
});
