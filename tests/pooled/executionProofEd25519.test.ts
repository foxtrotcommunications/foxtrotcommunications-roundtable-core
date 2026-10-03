/**
 * Ed25519 execution proofs (upgrade plan 5.2).
 *
 *   - buildProof with a signer attaches { alg:'ed25519', signer, sig } beside
 *     the HMAC proofSignature (never instead of it);
 *   - verifyProof verifies with the manifest PUBLIC key only — no contract
 *     key, no master;
 *   - tampering with any signed field (executedSqlHash, outputHash, nonce,
 *     timestamp, contractId, intentHash) fails;
 *   - an unknown signer fails when public keys are supplied;
 *   - the executor threads token nonce / intentHash / ctx.signer through;
 *   - scripts/verify-proof.js verifies from manifest.json + proof.json alone.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildProof, verifyProof, proofSigningDigest, intentHashOf, hashExecutedSql,
} from '../../server/protocols/executionProof';
import type { ExecutionProof } from '../../server/protocols/executionProof';
import type { QueryIntent } from '../../server/protocols/intentToken';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PRIV_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;
const OTHER_PUB = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string;

const CONTRACT_KEY = crypto.randomBytes(32);
const intent: QueryIntent = { op: 'query', tool: 'query_bigquery', params: { sql: 'SELECT 1' }, responseFormat: 'json_table' };
const token = { id: 'tok-1', nonce: 'n'.repeat(32), contractId: 'ctr_1', contractVersion: 1 };
const SQL = ['SELECT 1 LIMIT 100'];

function signedProof(): ExecutionProof {
  return buildProof(intent, { rows: [1] }, 'query_bigquery', 7, 'ctr_1', CONTRACT_KEY, [{ type: 'sql_safety', passed: true }],
    { sql: SQL }, { nonce: token.nonce, intentHash: intentHashOf(token), signer: { wsId: 'wsB', privateKeyPem: PRIV_PEM } });
}
const PUBLIC_KEYS = { wsA: OTHER_PUB, wsB: PUB_PEM };

describe('buildProof with an Ed25519 signer', () => {
  it('attaches signature alongside the HMAC and binds nonce + intentHash', () => {
    const p = signedProof();
    expect(p.signature).toEqual({ alg: 'ed25519', signer: 'wsB', sig: expect.any(String) });
    expect(p.proofSignature).toMatch(/^[0-9a-f]{64}$/);
    expect(p.nonce).toBe(token.nonce);
    expect(p.intentHash).toBe(intentHashOf(token));
    expect(p.executedSqlHash).toBe(hashExecutedSql(SQL));
  });

  it('HMAC still verifies and covers the Ed25519 signature', () => {
    const p = signedProof();
    expect(verifyProof(p, CONTRACT_KEY)).toEqual({ valid: true, verifiedWith: ['hmac'] });
    const swapped = { ...p, signature: { ...p.signature!, signer: 'wsA' } };
    expect(verifyProof(swapped, CONTRACT_KEY).valid).toBe(false);
  });

  it('a proof without a signer is HMAC-only and byte-compatible with before (no new fields)', () => {
    const p = buildProof(intent, { ok: true }, 'query_bigquery', 1, 'ctr_1', CONTRACT_KEY, []);
    expect(p.signature).toBeUndefined();
    expect('nonce' in p).toBe(false);
    expect('intentHash' in p).toBe(false);
    expect(verifyProof(p, CONTRACT_KEY).valid).toBe(true);
  });

  it('refuses a non-Ed25519 signing key', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => buildProof(intent, {}, 't', 1, 'ctr_1', CONTRACT_KEY, [], undefined, { signer: { wsId: 'wsB', privateKeyPem: rsa } })).toThrow(/Ed25519/);
  });
});

describe('verifyProof with the public key only', () => {
  it('verifies with no contract key', () => {
    const p = signedProof();
    expect(verifyProof(p, { publicKeys: PUBLIC_KEYS })).toEqual({ valid: true, verifiedWith: ['ed25519'] });
    expect(verifyProof(p, { publicKeys: PUBLIC_KEYS, contractKey: CONTRACT_KEY })).toEqual({ valid: true, verifiedWith: ['ed25519', 'hmac'] });
  });

  it.each(['executedSqlHash', 'outputHash', 'nonce', 'timestamp', 'contractId', 'intentHash'] as const)('tampering with %s fails', (field) => {
    const p: any = signedProof();
    p[field] = field === 'timestamp' ? new Date(Date.now() + 1000).toISOString() : 'x'.repeat(String(p[field]).length);
    expect(verifyProof(p, { publicKeys: PUBLIC_KEYS }).valid).toBe(false);
  });

  it('a signature from the wrong party key fails; an unknown signer fails', () => {
    const p = signedProof();
    expect(verifyProof(p, { publicKeys: { wsB: OTHER_PUB } }).error).toMatch(/Ed25519/);
    expect(verifyProof({ ...p, signature: { ...p.signature!, signer: 'wsZ' } }, { publicKeys: PUBLIC_KEYS }).error).toMatch(/No public key for proof signer wsZ/);
  });

  it('an unsigned proof cannot be verified by public keys alone (fails closed), HMAC still can', () => {
    const p = buildProof(intent, { ok: true }, 't', 1, 'ctr_1', CONTRACT_KEY, []);
    expect(verifyProof(p, { publicKeys: PUBLIC_KEYS }).valid).toBe(false);
    expect(verifyProof(p, { publicKeys: PUBLIC_KEYS, contractKey: CONTRACT_KEY })).toEqual({ valid: true, verifiedWith: ['hmac'] });
    expect(verifyProof(p, {}).error).toMatch(/No key/);
  });

  it('the signing digest is sha256 over the six fields joined by 0x1f (pinned layout)', () => {
    const p = signedProof();
    const expected = crypto.createHash('sha256').update(
      [p.executedSqlHash, p.outputHash, p.nonce, p.timestamp, p.contractId, p.intentHash].join('\x1f'), 'utf8',
    ).digest();
    expect(proofSigningDigest(p).equals(expected)).toBe(true);
  });
});

describe('scripts/verify-proof.js — no secrets', () => {
  const cli = require('../../scripts/verify-proof.js');
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-proof-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const write = (name: string, obj: unknown) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
  const manifest = { RT_CONTRACTS: [{ contractId: 'ctr_1', parties: ['wsA', 'wsB'], signing: PUBLIC_KEYS, allowedActions: ['*'] }] };

  it('exit 0 for a genuine proof (unwrapping a JSON-RPC envelope), with --sql check', () => {
    const p = signedProof();
    const m = write('manifest.json', manifest);
    const pr = write('proof.json', { jsonrpc: '2.0', id: 1, result: { status: 'success', proof: p } });
    const sql = write('sql.json', SQL);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(cli.main(['node', 'verify-proof.js', m, pr, '--sql', sql])).toBe(0);
    expect(cli.main(['node', 'verify-proof.js', m, pr])).toBe(0);
  });

  it('exit 1 on a tampered output hash, an unknown signer, or a wrong --sql', () => {
    const p = signedProof();
    const m = write('manifest2.json', manifest);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    expect(cli.main(['node', 'x', m, write('t1.json', { ...p, outputHash: 'f'.repeat(64) })])).toBe(1);
    expect(cli.main(['node', 'x', m, write('t2.json', { ...p, signature: { ...p.signature, signer: 'wsZ' } })])).toBe(1);
    expect(cli.main(['node', 'x', m, write('t3.json', p), '--sql', write('badsql.json', ['SELECT 2'])])).toBe(1);
    // HMAC-only proofs cannot be checked without a secret: honest failure.
    const unsigned = buildProof(intent, { ok: true }, 't', 1, 'ctr_1', CONTRACT_KEY, []);
    expect(cli.main(['node', 'x', m, write('t4.json', unsigned)])).toBe(1);
  });
});

describe('executor threads nonce / intentHash / signer into the proof', () => {
  jest.doMock('../../server/tools/index', () => ({
    executeTool: jest.fn().mockResolvedValue({ rows: [{ n: 1 }] }),
    resolveTools: jest.fn().mockReturnValue({ query_bigquery: {} }),
    getAvailableTools: jest.fn().mockReturnValue([]),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { executeIntentToken } = require('../../server/protocols/intentExecutor');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildIntentToken } = require('../../server/protocols/intentTokenCodec');

  it('a success proof is Ed25519-signed by ctx.signer and bound to the token nonce', async () => {
    const tok = await buildIntentToken(intent, 'ctr_1', 1, 'm', { encrypt: false });
    const result = await executeIntentToken(tok, {
      contractKey: CONTRACT_KEY,
      contract: { contractId: 'ctr_1', allowedActions: ['*'], status: 'active' },
      workspaceConfig: {}, enabledToolNames: null,
      signer: { wsId: 'wsB', privateKeyPem: PRIV_PEM },
    });
    expect(result.status).toBe('success');
    expect(result.proof!.nonce).toBe(tok.nonce);
    expect(result.proof!.intentHash).toBe(intentHashOf(tok));
    expect(result.proof!.signature?.signer).toBe('wsB');
    expect(verifyProof(result.proof!, { publicKeys: PUBLIC_KEYS })).toEqual({ valid: true, verifiedWith: ['ed25519'] });
    expect(verifyProof(result.proof!, CONTRACT_KEY).valid).toBe(true);
  });

  it('without ctx.signer the proof is HMAC-only (pre-5.2 pods, pre-5.2 mints)', async () => {
    const tok = await buildIntentToken(intent, 'ctr_1', 1, 'm', { encrypt: false });
    const result = await executeIntentToken(tok, {
      contractKey: CONTRACT_KEY,
      contract: { contractId: 'ctr_1', allowedActions: ['*'], status: 'active' },
      workspaceConfig: {}, enabledToolNames: null,
    });
    expect(result.proof!.signature).toBeUndefined();
    expect(result.proof!.nonce).toBe(tok.nonce);
    expect(verifyProof(result.proof!, CONTRACT_KEY).valid).toBe(true);
  });
});
