// tests/protocols/intentToken.test.ts — Intent Compilation Engine (ICE) Tests
// Comprehensive tests for intent token types, codec, nonce store, metrics, and executor.

import type {
  IntentOperation, QueryIntent, ToolCallIntent, AggregateIntent,
  SchemaDiscoveryIntent, IntentToken, IntentResult,
} from '../../server/protocols/intentToken';
import { validateIntent, intentOpToAction } from '../../server/protocols/intentToken';
import {
  canonicalize,
  buildIntentToken,
  verifyIntentToken,
  decryptIntentToken,
  signIntentResult,
  verifyIntentResult,
} from '../../server/protocols/intentTokenCodec';
import { NonceStore } from '../../server/protocols/nonceStore';
import { IntentMetrics } from '../../server/protocols/intentMetrics';

// ─── Mock the tools module before importing the executor ──────────────────────
jest.mock('../../server/tools/index', () => ({
  executeTool: jest.fn().mockResolvedValue({ rows: [{ revenue: 1000 }], rowCount: 1 }),
  resolveTools: jest.fn().mockReturnValue({ query_bigquery: {}, read_file: {} }),
  getAvailableTools: jest.fn().mockReturnValue([
    { name: 'query_bigquery', description: 'Query BigQuery' },
    { name: 'read_file', description: 'Read a file' },
  ]),
}));

import { executeIntentToken, ExecutionContext } from '../../server/protocols/intentExecutor';
import { executeTool, resolveTools, getAvailableTools } from '../../server/tools/index';

// ─── Shared Test Constants ──────────────────────────────────────────────────

const TEST_MASTER_SECRET = 'test-master-secret-for-ice-tests';
const TEST_CONTRACT_ID = 'contract-test-001';
const TEST_CONTRACT_VERSION = 1;

// ─── Helper: derive a contract key for test use ─────────────────────────────

import { deriveContractKey } from '../../server/utils/contractAuth';

async function getTestContractKey(): Promise<Buffer> {
  return deriveContractKey(TEST_MASTER_SECRET, TEST_CONTRACT_ID, TEST_CONTRACT_VERSION);
}

// ─── Helper: build a valid query intent ─────────────────────────────────────

function makeQueryIntent(): QueryIntent {
  return {
    op: 'query',
    tool: 'query_bigquery',
    params: { sql: 'SELECT revenue FROM sales LIMIT 10' },
    responseFormat: 'json_table',
  };
}

function makeToolCallIntent(): ToolCallIntent {
  return {
    op: 'tool_call',
    tool: 'read_file',
    args: { path: '/data/report.csv' },
  };
}

function makeDiscoverIntent(): SchemaDiscoveryIntent {
  return { op: 'discover', scope: 'tools' };
}

function makeAggregateIntent(): AggregateIntent {
  return {
    op: 'aggregate',
    steps: [makeQueryIntent(), makeToolCallIntent()],
    reduce: 'concat',
  };
}

// ─── Helper: build a test execution context ─────────────────────────────────

async function makeExecutionContext(
  overrides: Partial<ExecutionContext> = {},
): Promise<ExecutionContext> {
  const contractKey = await getTestContractKey();
  return {
    contractKey,
    contract: {
      contractId: TEST_CONTRACT_ID,
      allowedActions: ['query:query_bigquery', 'tool:read_file', 'aggregate', 'discover'],
      status: 'active',
    },
    workspaceConfig: {},
    enabledToolNames: null,
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 — Intent Token Types (intentToken.ts)
// ═════════════════════════════════════════════════════════════════════════════

describe('Intent Token Types', () => {
  describe('validateIntent', () => {
    it('accepts a valid query intent', () => {
      const result = validateIntent(makeQueryIntent());
      expect(result).toEqual({ valid: true });
    });

    it('accepts a valid tool_call intent', () => {
      const result = validateIntent(makeToolCallIntent());
      expect(result).toEqual({ valid: true });
    });

    it('accepts a valid discover intent', () => {
      const result = validateIntent(makeDiscoverIntent());
      expect(result).toEqual({ valid: true });
    });

    it('accepts a valid aggregate intent', () => {
      const result = validateIntent(makeAggregateIntent());
      expect(result).toEqual({ valid: true });
    });

    it('rejects an invalid op type', () => {
      const result = validateIntent({ op: 'hack' } as any);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid op');
    });

    it('rejects null/undefined intent', () => {
      expect(validateIntent(null as any).valid).toBe(false);
      expect(validateIntent(undefined as any).valid).toBe(false);
    });

    it('rejects a query intent missing tool', () => {
      const intent = { ...makeQueryIntent(), tool: '' };
      const result = validateIntent(intent);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('tool name');
    });

    it('rejects a query intent missing params', () => {
      const intent = { ...makeQueryIntent(), params: undefined } as any;
      const result = validateIntent(intent);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('params');
    });

    it('rejects a query intent missing sql and table', () => {
      const intent: QueryIntent = {
        op: 'query',
        tool: 'query_bigquery',
        params: {},
        responseFormat: 'json_table',
      };
      const result = validateIntent(intent);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('sql or table');
    });

    it('rejects a query intent with invalid responseFormat', () => {
      const intent = { ...makeQueryIntent(), responseFormat: 'xml' as any };
      const result = validateIntent(intent);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('responseFormat');
    });

    it('rejects a tool_call intent missing tool', () => {
      const intent = { op: 'tool_call', tool: '', args: {} } as ToolCallIntent;
      const result = validateIntent(intent);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('tool name');
    });

    it('rejects a tool_call intent missing args', () => {
      const intent = { op: 'tool_call', tool: 'read_file', args: undefined } as any;
      const result = validateIntent(intent);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('args');
    });

    it('rejects an aggregate intent with empty steps', () => {
      const intent: AggregateIntent = { op: 'aggregate', steps: [], reduce: 'concat' };
      const result = validateIntent(intent);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('steps');
    });

    it('rejects an aggregate intent with invalid reduce', () => {
      const intent = { ...makeAggregateIntent(), reduce: 'sum' as any };
      const result = validateIntent(intent);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('reduce');
    });

    it('rejects a discover intent with invalid scope', () => {
      const intent = { op: 'discover', scope: 'secrets' } as any;
      const result = validateIntent(intent);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('scope');
    });
  });

  describe('intentOpToAction', () => {
    it('maps query to query:<tool>', () => {
      expect(intentOpToAction(makeQueryIntent())).toBe('query:query_bigquery');
    });

    it('maps tool_call to tool:<tool>', () => {
      expect(intentOpToAction(makeToolCallIntent())).toBe('tool:read_file');
    });

    it('maps aggregate to "aggregate"', () => {
      expect(intentOpToAction(makeAggregateIntent())).toBe('aggregate');
    });

    it('maps discover to "discover"', () => {
      expect(intentOpToAction(makeDiscoverIntent())).toBe('discover');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 — Token Codec (intentTokenCodec.ts)
// ═════════════════════════════════════════════════════════════════════════════

describe('Token Codec', () => {
  describe('canonicalize', () => {
    it('produces deterministic output with sorted keys', () => {
      const a = canonicalize({ z: 1, a: 2, m: 3 });
      const b = canonicalize({ a: 2, m: 3, z: 1 });
      expect(a).toBe(b);
      // Verify key order in the output string
      const parsed = JSON.parse(a);
      expect(Object.keys(parsed)).toEqual(['a', 'm', 'z']);
    });

    it('handles nested objects with deterministic ordering', () => {
      const a = canonicalize({ outer: { z: 1, a: 2 }, b: 3 });
      const b = canonicalize({ b: 3, outer: { a: 2, z: 1 } });
      expect(a).toBe(b);
    });

    it('preserves arrays without sorting them', () => {
      const result = canonicalize({ items: [3, 1, 2] });
      expect(JSON.parse(result).items).toEqual([3, 1, 2]);
    });
  });

  describe('buildIntentToken', () => {
    it('creates a valid token with all required fields', async () => {
      const token = await buildIntentToken(
        makeQueryIntent(),
        TEST_CONTRACT_ID,
        TEST_CONTRACT_VERSION,
        TEST_MASTER_SECRET,
        { encrypt: false },
      );

      expect(token.version).toBe(1);
      expect(token.type).toBe('intent_token');
      expect(token.id).toBeDefined();
      expect(typeof token.id).toBe('string');
      expect(token.contractId).toBe(TEST_CONTRACT_ID);
      expect(token.contractVersion).toBe(TEST_CONTRACT_VERSION);
      expect(token.signature).toBeDefined();
      expect(token.timestamp).toBeDefined();
      expect(token.expiry).toBeDefined();
      expect(token.nonce).toBeDefined();
      expect(token.intent).toEqual(makeQueryIntent());
    });

    it('with encrypt=true produces encryptedIntent and sets encrypted=true', async () => {
      const token = await buildIntentToken(
        makeQueryIntent(),
        TEST_CONTRACT_ID,
        TEST_CONTRACT_VERSION,
        TEST_MASTER_SECRET,
        { encrypt: true },
      );

      expect(token.encrypted).toBe(true);
      expect(token.encryptedIntent).toBeDefined();
      expect(token.encryptedIntent!.iv).toBeDefined();
      expect(token.encryptedIntent!.ciphertext).toBeDefined();
      expect(token.encryptedIntent!.authTag).toBeDefined();
      // Plaintext intent should NOT be present when encrypted
      expect(token.intent).toBeUndefined();
    });

    it('with encrypt=false includes plaintext intent', async () => {
      const token = await buildIntentToken(
        makeToolCallIntent(),
        TEST_CONTRACT_ID,
        TEST_CONTRACT_VERSION,
        TEST_MASTER_SECRET,
        { encrypt: false },
      );

      expect(token.encrypted).toBe(false);
      expect(token.intent).toEqual(makeToolCallIntent());
      expect(token.encryptedIntent).toBeUndefined();
    });

    it('defaults to encrypt=true when no option specified', async () => {
      const token = await buildIntentToken(
        makeQueryIntent(),
        TEST_CONTRACT_ID,
        TEST_CONTRACT_VERSION,
        TEST_MASTER_SECRET,
      );

      expect(token.encrypted).toBe(true);
      expect(token.encryptedIntent).toBeDefined();
    });
  });

  describe('verifyIntentToken', () => {
    it('succeeds for a freshly built token', async () => {
      const token = await buildIntentToken(
        makeQueryIntent(),
        TEST_CONTRACT_ID,
        TEST_CONTRACT_VERSION,
        TEST_MASTER_SECRET,
        { encrypt: false },
      );

      const result = await verifyIntentToken(token, TEST_MASTER_SECRET);
      expect(result.valid).toBe(true);
      expect(result.contractKey).toBeDefined();
    });

    it('succeeds for an encrypted token', async () => {
      const token = await buildIntentToken(
        makeQueryIntent(),
        TEST_CONTRACT_ID,
        TEST_CONTRACT_VERSION,
        TEST_MASTER_SECRET,
        { encrypt: true },
      );

      const result = await verifyIntentToken(token, TEST_MASTER_SECRET);
      expect(result.valid).toBe(true);
    });

    it('fails for tampered signature', async () => {
      const token = await buildIntentToken(
        makeQueryIntent(),
        TEST_CONTRACT_ID,
        TEST_CONTRACT_VERSION,
        TEST_MASTER_SECRET,
        { encrypt: false },
      );

      // Tamper with the signature
      const tampered = { ...token, signature: 'a'.repeat(64) };
      const result = await verifyIntentToken(tampered, TEST_MASTER_SECRET);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('signature');
    });

    it('fails for expired token', async () => {
      const token = await buildIntentToken(
        makeQueryIntent(),
        TEST_CONTRACT_ID,
        TEST_CONTRACT_VERSION,
        TEST_MASTER_SECRET,
        { encrypt: false, expiryMs: 1 },
      );

      // Wait just long enough for the token to expire
      await new Promise((resolve) => setTimeout(resolve, 20));

      const result = await verifyIntentToken(token, TEST_MASTER_SECRET);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expired');
    });

    it('fails for wrong master secret', async () => {
      const token = await buildIntentToken(
        makeQueryIntent(),
        TEST_CONTRACT_ID,
        TEST_CONTRACT_VERSION,
        TEST_MASTER_SECRET,
        { encrypt: false },
      );

      const result = await verifyIntentToken(token, 'wrong-secret-entirely');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('signature');
    });
  });

  describe('decryptIntentToken', () => {
    it('successfully decrypts an encrypted token', async () => {
      const intent = makeQueryIntent();
      const token = await buildIntentToken(
        intent,
        TEST_CONTRACT_ID,
        TEST_CONTRACT_VERSION,
        TEST_MASTER_SECRET,
        { encrypt: true },
      );

      const contractKey = await getTestContractKey();
      const { token: decrypted, error } = await decryptIntentToken(token, contractKey);

      expect(error).toBeUndefined();
      expect(decrypted.encrypted).toBe(false);
      expect(decrypted.intent).toEqual(intent);
      expect((decrypted as any).encryptedIntent).toBeUndefined();
    });

    it('returns plaintext token unchanged', async () => {
      const intent = makeQueryIntent();
      const token = await buildIntentToken(
        intent,
        TEST_CONTRACT_ID,
        TEST_CONTRACT_VERSION,
        TEST_MASTER_SECRET,
        { encrypt: false },
      );

      const contractKey = await getTestContractKey();
      const { token: returned, error } = await decryptIntentToken(token, contractKey);

      expect(error).toBeUndefined();
      expect(returned.intent).toEqual(intent);
    });
  });

  describe('signIntentResult / verifyIntentResult', () => {
    it('round-trips correctly (sign then verify)', async () => {
      const contractKey = await getTestContractKey();
      const unsigned: Omit<IntentResult, 'signature'> = {
        version: 1,
        type: 'intent_result',
        tokenId: 'test-token-id',
        status: 'success',
        data: { revenue: 1000 },
        executionMs: 42,
        timestamp: new Date().toISOString(),
      };

      const signed = signIntentResult(unsigned, contractKey);
      expect(signed.signature).toBeDefined();
      expect(typeof signed.signature).toBe('string');

      const isValid = verifyIntentResult(signed, contractKey);
      expect(isValid).toBe(true);
    });

    it('fails for tampered result', async () => {
      const contractKey = await getTestContractKey();
      const unsigned: Omit<IntentResult, 'signature'> = {
        version: 1,
        type: 'intent_result',
        tokenId: 'test-token-id',
        status: 'success',
        data: { revenue: 1000 },
        executionMs: 42,
        timestamp: new Date().toISOString(),
      };

      const signed = signIntentResult(unsigned, contractKey);

      // Tamper with the data
      const tampered = { ...signed, data: { revenue: 9999 } };
      const isValid = verifyIntentResult(tampered, contractKey);
      expect(isValid).toBe(false);
    });

    it('fails with a different contract key', async () => {
      const contractKey = await getTestContractKey();
      const wrongKey = await deriveContractKey('wrong-secret', 'wrong-contract', 1);

      const unsigned: Omit<IntentResult, 'signature'> = {
        version: 1,
        type: 'intent_result',
        tokenId: 'test-token-id',
        status: 'success',
        data: { result: 'ok' },
        executionMs: 10,
        timestamp: new Date().toISOString(),
      };

      const signed = signIntentResult(unsigned, contractKey);
      const isValid = verifyIntentResult(signed, wrongKey);
      expect(isValid).toBe(false);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 — Nonce Store (nonceStore.ts)
// ═════════════════════════════════════════════════════════════════════════════

describe('NonceStore', () => {
  let store: NonceStore;

  beforeEach(() => {
    // Use a very long cleanup interval to avoid automatic cleanup during tests
    store = new NonceStore(60_000);
  });

  afterEach(() => {
    store.destroy();
  });

  it('add() returns true for a new nonce', () => {
    expect(store.add('nonce-1', 10_000)).toBe(true);
  });

  it('add() returns false for a duplicate nonce (replay)', () => {
    store.add('nonce-dup', 10_000);
    expect(store.add('nonce-dup', 10_000)).toBe(false);
  });

  it('has() returns false after nonce TTL expires', async () => {
    store.add('nonce-ttl', 10); // 10ms TTL
    // Wait for TTL to pass
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.has('nonce-ttl')).toBe(false);
  });

  it('allows re-adding a nonce after TTL expires', async () => {
    store.add('nonce-reuse', 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Should be allowed since the old one expired
    expect(store.add('nonce-reuse', 10_000)).toBe(true);
  });

  it('cleanup() removes expired nonces', async () => {
    store.add('fresh', 10_000);
    store.add('expired', 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    store.cleanup();
    expect(store.size).toBe(1); // only 'fresh' remains
  });

  it('size tracks the number of stored nonces', () => {
    expect(store.size).toBe(0);
    store.add('a', 10_000);
    expect(store.size).toBe(1);
    store.add('b', 10_000);
    expect(store.size).toBe(2);
  });

  it('destroy() clears everything', () => {
    store.add('nonce-x', 10_000);
    store.add('nonce-y', 10_000);
    expect(store.size).toBe(2);
    store.destroy();
    expect(store.size).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 — Intent Metrics (intentMetrics.ts)
// ═════════════════════════════════════════════════════════════════════════════

describe('IntentMetrics', () => {
  let metrics: IntentMetrics;

  beforeEach(() => {
    metrics = new IntentMetrics();
  });

  it('returns zero stats when no records exist', () => {
    const stats = metrics.getStats();
    expect(stats.totalExecutions).toBe(0);
    expect(stats.compiledExecutions).toBe(0);
    expect(stats.interpretedExecutions).toBe(0);
    expect(stats.avgExecutionMs).toBe(0);
    expect(stats.p95ExecutionMs).toBe(0);
    expect(stats.estimatedTokensSaved).toBe(0);
    expect(stats.estimatedCostSaved).toBe(0);
  });

  it('record and getStats return correct counts', () => {
    metrics.record('query_bigquery', 50, true);
    metrics.record('read_file', 30, true);
    metrics.record('web_search', 100, false);

    const stats = metrics.getStats();
    expect(stats.totalExecutions).toBe(3);
    expect(stats.compiledExecutions).toBe(2);
    expect(stats.interpretedExecutions).toBe(1);
  });

  it('estimatedTokensSaved = compiledExecutions * 4300', () => {
    metrics.record('tool-a', 10, true);
    metrics.record('tool-b', 20, true);
    metrics.record('tool-c', 30, true);

    const stats = metrics.getStats();
    expect(stats.estimatedTokensSaved).toBe(3 * 4300);
  });

  it('p95ExecutionMs is calculated correctly', () => {
    // Record 20 executions with known latencies (1..20)
    for (let i = 1; i <= 20; i++) {
      metrics.record('tool', i, true);
    }

    const stats = metrics.getStats();
    // p95Index = Math.ceil(20 * 0.95) - 1 = 19 - 1 = 18  → sorted[18] = 19
    expect(stats.p95ExecutionMs).toBe(19);
  });

  it('avgExecutionMs is computed correctly', () => {
    metrics.record('a', 10, true);
    metrics.record('b', 20, true);
    metrics.record('c', 30, true);

    const stats = metrics.getStats();
    expect(stats.avgExecutionMs).toBe(20);
  });

  it('estimatedCostSaved is computed from tokens saved', () => {
    metrics.record('tool-a', 10, true);
    const stats = metrics.getStats();
    // 1 * 4300 * 0.000015 = 0.0645
    expect(stats.estimatedCostSaved).toBe(0.0645);
  });

  it('reset() clears stats', () => {
    metrics.record('tool-a', 10, true);
    metrics.record('tool-b', 20, false);

    metrics.reset();
    const stats = metrics.getStats();
    expect(stats.totalExecutions).toBe(0);
    expect(stats.compiledExecutions).toBe(0);
    expect(stats.estimatedTokensSaved).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 — Intent Executor (intentExecutor.ts)
// ═════════════════════════════════════════════════════════════════════════════

describe('Intent Executor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('executes a query intent successfully', async () => {
    const token = await buildIntentToken(
      makeQueryIntent(),
      TEST_CONTRACT_ID,
      TEST_CONTRACT_VERSION,
      TEST_MASTER_SECRET,
      { encrypt: false },
    );

    const ctx = await makeExecutionContext();
    const result = await executeIntentToken(token, ctx);

    expect(result.status).toBe('success');
    expect(result.tokenId).toBe(token.id);
    expect(result.data).toEqual({ rows: [{ revenue: 1000 }], rowCount: 1 });
    expect(result.toolExecuted).toBe('query_bigquery');
    expect(result.signature).toBeDefined();
    expect(executeTool).toHaveBeenCalledWith(
      'query_bigquery',
      makeQueryIntent().params,
      {},
    );
  });

  it('executes a tool_call intent successfully', async () => {
    const token = await buildIntentToken(
      makeToolCallIntent(),
      TEST_CONTRACT_ID,
      TEST_CONTRACT_VERSION,
      TEST_MASTER_SECRET,
      { encrypt: false },
    );

    const ctx = await makeExecutionContext();
    const result = await executeIntentToken(token, ctx);

    expect(result.status).toBe('success');
    expect(result.toolExecuted).toBe('read_file');
    expect(executeTool).toHaveBeenCalledWith(
      'read_file',
      { path: '/data/report.csv' },
      {},
    );
  });

  it('executes a discover intent returning tools list', async () => {
    const token = await buildIntentToken(
      makeDiscoverIntent(),
      TEST_CONTRACT_ID,
      TEST_CONTRACT_VERSION,
      TEST_MASTER_SECRET,
      { encrypt: false },
    );

    const ctx = await makeExecutionContext();
    const result = await executeIntentToken(token, ctx);

    expect(result.status).toBe('success');
    expect(result.data).toEqual([
      { name: 'query_bigquery', description: 'Query BigQuery' },
      { name: 'read_file', description: 'Read a file' },
    ]);
    expect(getAvailableTools).toHaveBeenCalled();
  });

  it('denies action not in contract allowedActions', async () => {
    const intent: ToolCallIntent = {
      op: 'tool_call',
      tool: 'shell_exec',
      args: { command: 'ls' },
    };

    const token = await buildIntentToken(
      intent,
      TEST_CONTRACT_ID,
      TEST_CONTRACT_VERSION,
      TEST_MASTER_SECRET,
      { encrypt: false },
    );

    // The allowedActions do NOT include 'tool:shell_exec'
    const ctx = await makeExecutionContext();
    const result = await executeIntentToken(token, ctx);

    expect(result.status).toBe('denied');
    expect(result.error).toContain('not authorized');
    expect(result.error).toContain('tool:shell_exec');
  });

  it('does not serve a cached result to a contract that lacks the action', async () => {
    // Unique SQL so this intent's cache entry cannot collide with other tests.
    const intent: QueryIntent = {
      op: 'query',
      tool: 'query_bigquery',
      params: { sql: 'SELECT cached_auth_probe FROM sales LIMIT 1' },
      responseFormat: 'json_table',
    };

    // 1. An authorized contract runs the intent and populates the intent cache.
    const authedToken = await buildIntentToken(
      intent, TEST_CONTRACT_ID, TEST_CONTRACT_VERSION, TEST_MASTER_SECRET, { encrypt: false },
    );
    const first = await executeIntentToken(authedToken, await makeExecutionContext());
    expect(first.status).toBe('success');

    // 2. A different contract WITHOUT query:query_bigquery replays the same
    //    intent. It must be denied and must NOT receive the cached data —
    //    authorization runs before the cache lookup.
    const deniedToken = await buildIntentToken(
      intent, TEST_CONTRACT_ID, TEST_CONTRACT_VERSION, TEST_MASTER_SECRET, { encrypt: false },
    );
    const deniedCtx = await makeExecutionContext({
      contract: { contractId: 'contract-restricted', allowedActions: ['discover'], status: 'active' },
    });
    const second = await executeIntentToken(deniedToken, deniedCtx);

    expect(second.status).toBe('denied');
    expect(second.error).toContain('not authorized');
    expect(second.data).toBeUndefined();
  });

  it('returns error for invalid intent (missing tool name)', async () => {
    const badIntent = { op: 'query', tool: '', params: { sql: 'SELECT 1' }, responseFormat: 'json_table' } as QueryIntent;

    const token = await buildIntentToken(
      badIntent,
      TEST_CONTRACT_ID,
      TEST_CONTRACT_VERSION,
      TEST_MASTER_SECRET,
      { encrypt: false },
    );

    const ctx = await makeExecutionContext();
    const result = await executeIntentToken(token, ctx);

    expect(result.status).toBe('error');
    expect(result.error).toContain('Invalid intent');
  });

  it('blocks dangerous SQL (DROP TABLE)', async () => {
    const dangerousIntent: QueryIntent = {
      op: 'query',
      tool: 'query_bigquery',
      params: { sql: 'DROP TABLE users' },
      responseFormat: 'json_table',
    };

    const token = await buildIntentToken(
      dangerousIntent,
      TEST_CONTRACT_ID,
      TEST_CONTRACT_VERSION,
      TEST_MASTER_SECRET,
      { encrypt: false },
    );

    const ctx = await makeExecutionContext();
    const result = await executeIntentToken(token, ctx);

    expect(result.status).toBe('error');
    expect(result.error).toContain('read-only');
  });

  it('blocks dangerous SQL (DELETE FROM)', async () => {
    const dangerousIntent: QueryIntent = {
      op: 'query',
      tool: 'query_bigquery',
      params: { sql: 'DELETE FROM users WHERE id = 1' },
      responseFormat: 'json_table',
    };

    const token = await buildIntentToken(
      dangerousIntent,
      TEST_CONTRACT_ID,
      TEST_CONTRACT_VERSION,
      TEST_MASTER_SECRET,
      { encrypt: false },
    );

    const ctx = await makeExecutionContext();
    const result = await executeIntentToken(token, ctx);

    expect(result.status).toBe('error');
    expect(result.error).toContain('read-only');
  });

  it('blocks dangerous SQL (INSERT INTO)', async () => {
    const dangerousIntent: QueryIntent = {
      op: 'query',
      tool: 'query_bigquery',
      params: { sql: 'INSERT INTO users (name) VALUES ("evil")' },
      responseFormat: 'json_table',
    };

    const token = await buildIntentToken(
      dangerousIntent,
      TEST_CONTRACT_ID,
      TEST_CONTRACT_VERSION,
      TEST_MASTER_SECRET,
      { encrypt: false },
    );

    const ctx = await makeExecutionContext();
    const result = await executeIntentToken(token, ctx);

    expect(result.status).toBe('error');
    expect(result.error).toContain('read-only');
  });

  it('signs the result so it can be verified', async () => {
    const token = await buildIntentToken(
      makeQueryIntent(),
      TEST_CONTRACT_ID,
      TEST_CONTRACT_VERSION,
      TEST_MASTER_SECRET,
      { encrypt: false },
    );

    const ctx = await makeExecutionContext();
    const result = await executeIntentToken(token, ctx);

    expect(result.signature).toBeDefined();
    expect(typeof result.signature).toBe('string');

    // Verify the result signature with the contract key
    const isValid = verifyIntentResult(result, ctx.contractKey);
    expect(isValid).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §6 — Execution Proofs (executionProof.ts)
// ═════════════════════════════════════════════════════════════════════════════

import { buildProof, verifyProof, type PolicyCheck } from '../../server/protocols/executionProof';

describe('Execution Proofs', () => {
  let contractKey: Buffer;

  beforeAll(async () => {
    contractKey = await getTestContractKey();
  });

  const sampleIntent: QueryIntent = {
    op: 'query',
    tool: 'query_bigquery',
    params: { sql: 'SELECT revenue FROM `project.dataset.sales` LIMIT 10' },
    responseFormat: 'json_table',
  };
  const sampleResult = { rows: [{ revenue: 42 }], rowCount: 1 };
  const samplePolicies: PolicyCheck[] = [
    { type: 'sql_safety', passed: true },
    { type: 'tool_exists', passed: true, detail: 'query_bigquery' },
  ];

  it('buildProof generates valid proof with all fields', () => {
    const proof = buildProof(
      sampleIntent, sampleResult, 'query_bigquery', 55,
      TEST_CONTRACT_ID, contractKey, samplePolicies,
    );

    expect(proof.inputHash).toBeDefined();
    expect(typeof proof.inputHash).toBe('string');
    expect(proof.outputHash).toBeDefined();
    expect(typeof proof.outputHash).toBe('string');
    expect(proof.toolName).toBe('query_bigquery');
    expect(proof.executionMs).toBe(55);
    expect(proof.contractId).toBe(TEST_CONTRACT_ID);
    expect(proof.timestamp).toBeDefined();
    expect(proof.proofSignature).toBeDefined();
    expect(typeof proof.proofSignature).toBe('string');
    expect(proof.policyChecks).toEqual(samplePolicies);
  });

  it('inputHash is SHA-256 of canonical intent', () => {
    const proof = buildProof(
      sampleIntent, sampleResult, 'query_bigquery', 10,
      TEST_CONTRACT_ID, contractKey, [],
    );

    const crypto = require('crypto');
    const { canonicalize: canon } = require('../../server/protocols/intentTokenCodec');
    const expected = crypto.createHash('sha256').update(canon(sampleIntent)).digest('hex');
    expect(proof.inputHash).toBe(expected);
  });

  it('outputHash is SHA-256 of canonical result', () => {
    const proof = buildProof(
      sampleIntent, sampleResult, 'query_bigquery', 10,
      TEST_CONTRACT_ID, contractKey, [],
    );

    const crypto = require('crypto');
    const { canonicalize: canon } = require('../../server/protocols/intentTokenCodec');
    const expected = crypto.createHash('sha256').update(canon(sampleResult)).digest('hex');
    expect(proof.outputHash).toBe(expected);
  });

  it('verifyProof succeeds for valid proof', () => {
    const proof = buildProof(
      sampleIntent, sampleResult, 'query_bigquery', 10,
      TEST_CONTRACT_ID, contractKey, samplePolicies,
    );

    const result = verifyProof(proof, contractKey);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('verifyProof fails for tampered proofSignature', () => {
    const proof = buildProof(
      sampleIntent, sampleResult, 'query_bigquery', 10,
      TEST_CONTRACT_ID, contractKey, samplePolicies,
    );

    const tampered = { ...proof, proofSignature: 'a'.repeat(64) };
    const result = verifyProof(tampered, contractKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('signature');
  });

  it('verifyProof fails for mismatched intent (inputHash check)', () => {
    const proof = buildProof(
      sampleIntent, sampleResult, 'query_bigquery', 10,
      TEST_CONTRACT_ID, contractKey, [],
    );

    const differentIntent: QueryIntent = {
      op: 'query',
      tool: 'query_bigquery',
      params: { sql: 'SELECT * FROM other_table' },
      responseFormat: 'json_table',
    };

    const result = verifyProof(proof, contractKey, differentIntent);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Input hash');
  });

  it('verifyProof fails for mismatched result (outputHash check)', () => {
    const proof = buildProof(
      sampleIntent, sampleResult, 'query_bigquery', 10,
      TEST_CONTRACT_ID, contractKey, [],
    );

    const differentResult = { rows: [{ revenue: 9999 }], rowCount: 1 };
    const result = verifyProof(proof, contractKey, undefined, differentResult);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Output hash');
  });

  it('policyChecks are preserved in proof', () => {
    const policies: PolicyCheck[] = [
      { type: 'sql_safety', passed: true },
      { type: 'rate_limit', passed: false, detail: 'exceeded 100 req/min' },
      { type: 'data_scope', passed: true, detail: 'project.dataset' },
    ];

    const proof = buildProof(
      sampleIntent, sampleResult, 'query_bigquery', 10,
      TEST_CONTRACT_ID, contractKey, policies,
    );

    expect(proof.policyChecks).toHaveLength(3);
    expect(proof.policyChecks[0]).toEqual({ type: 'sql_safety', passed: true });
    expect(proof.policyChecks[1]).toEqual({ type: 'rate_limit', passed: false, detail: 'exceeded 100 req/min' });
    expect(proof.policyChecks[2]).toEqual({ type: 'data_scope', passed: true, detail: 'project.dataset' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §7 — Intent Cache (intentCache.ts)
// ═════════════════════════════════════════════════════════════════════════════

import { IntentCache } from '../../server/protocols/intentCache';

describe('Intent Cache', () => {
  let cache: IntentCache;

  beforeEach(() => {
    cache = new IntentCache({ maxSize: 3, defaultTtlMs: 60_000, cleanupIntervalMs: 999_999 });
  });

  afterEach(() => {
    cache.destroy();
  });

  const queryIntent: QueryIntent = {
    op: 'query',
    tool: 'query_bigquery',
    params: { sql: 'SELECT revenue FROM sales LIMIT 10' },
    responseFormat: 'json_table',
  };

  const successResult: IntentResult = {
    version: 1,
    type: 'intent_result',
    tokenId: 'tok-001',
    status: 'success',
    data: { rows: [{ revenue: 100 }] },
    executionMs: 42,
    signature: 'sig-placeholder',
    timestamp: new Date().toISOString(),
  };

  it('cache miss returns null for unknown intent', () => {
    const result = cache.get(queryIntent);
    expect(result).toBeNull();
  });

  it('cache hit returns result after set', () => {
    cache.set(queryIntent, successResult);
    const result = cache.get(queryIntent);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('success');
    expect(result!.data).toEqual({ rows: [{ revenue: 100 }] });
  });

  it('cache respects TTL (set with ttlMs: 1, wait 10ms, get returns null)', async () => {
    cache.set(queryIntent, successResult, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = cache.get(queryIntent);
    expect(result).toBeNull();
  });

  it('cache skips non-cacheable ops (discover)', () => {
    const discoverIntent: SchemaDiscoveryIntent = { op: 'discover', scope: 'tools' };
    const discoverResult: IntentResult = {
      version: 1, type: 'intent_result', tokenId: 'tok-d',
      status: 'success', data: [], executionMs: 5,
      signature: 'sig', timestamp: new Date().toISOString(),
    };

    cache.set(discoverIntent, discoverResult);
    const result = cache.get(discoverIntent);
    expect(result).toBeNull();
  });

  it('cache skips non-cacheable ops (aggregate)', () => {
    const aggIntent: AggregateIntent = {
      op: 'aggregate',
      steps: [queryIntent],
      reduce: 'concat',
    };
    const aggResult: IntentResult = {
      version: 1, type: 'intent_result', tokenId: 'tok-a',
      status: 'success', data: [], executionMs: 10,
      signature: 'sig', timestamp: new Date().toISOString(),
    };

    cache.set(aggIntent, aggResult);
    const result = cache.get(aggIntent);
    expect(result).toBeNull();
  });

  it('cache only stores successful results', () => {
    const errorResult: IntentResult = {
      version: 1, type: 'intent_result', tokenId: 'tok-err',
      status: 'error', error: 'boom', executionMs: 5,
      signature: 'sig', timestamp: new Date().toISOString(),
    };

    cache.set(queryIntent, errorResult);
    const result = cache.get(queryIntent);
    expect(result).toBeNull();
  });

  it('LRU eviction when maxSize reached', () => {
    const makeQ = (id: number): QueryIntent => ({
      op: 'query',
      tool: 'query_bigquery',
      params: { sql: `SELECT col${id} FROM t LIMIT 10` },
      responseFormat: 'json_table',
    });
    const makeR = (id: number): IntentResult => ({
      version: 1, type: 'intent_result', tokenId: `tok-${id}`,
      status: 'success', data: { id }, executionMs: 1,
      signature: 'sig', timestamp: new Date().toISOString(),
    });

    // Use mocked Date.now to ensure deterministic LRU ordering
    const realNow = Date.now;
    let fakeTime = 1000;
    Date.now = () => fakeTime;

    try {
      // Fill cache (maxSize=3) with ascending timestamps
      fakeTime = 1000;
      cache.set(makeQ(1), makeR(1)); // lastAccessed = 1000
      fakeTime = 2000;
      cache.set(makeQ(2), makeR(2)); // lastAccessed = 2000
      fakeTime = 3000;
      cache.set(makeQ(3), makeR(3)); // lastAccessed = 3000

      // Access q1 to make it recently used
      fakeTime = 4000;
      cache.get(makeQ(1)); // lastAccessed = 4000

      // Adding q4 should evict q2 (lastAccessed = 2000, the oldest)
      fakeTime = 5000;
      cache.set(makeQ(4), makeR(4));

      fakeTime = 6000;
      expect(cache.get(makeQ(1))).not.toBeNull(); // still present (was accessed at 4000)
      expect(cache.get(makeQ(2))).toBeNull();     // evicted (LRU, lastAccessed = 2000)
      expect(cache.get(makeQ(3))).not.toBeNull(); // still present (lastAccessed = 3000)
      expect(cache.get(makeQ(4))).not.toBeNull(); // newly added
    } finally {
      Date.now = realNow;
    }
  });


  it('invalidate removes specific entry', () => {
    cache.set(queryIntent, successResult);
    expect(cache.get(queryIntent)).not.toBeNull();

    const removed = cache.invalidate(queryIntent);
    expect(removed).toBe(true);
    expect(cache.get(queryIntent)).toBeNull();
  });

  it('clear resets everything', () => {
    cache.set(queryIntent, successResult);
    expect(cache.stats().size).toBe(1);

    cache.clear();
    expect(cache.stats().size).toBe(0);
    expect(cache.stats().hits).toBe(0);
    expect(cache.stats().misses).toBe(0);
  });

  it('stats tracks hits and misses correctly', () => {
    // 1 miss
    cache.get(queryIntent);
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);

    // Set then hit
    cache.set(queryIntent, successResult);
    cache.get(queryIntent);
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hitRate).toBe(50);
  });

  it('key produces deterministic hash', () => {
    const k1 = cache.key(queryIntent);
    const k2 = cache.key(queryIntent);
    expect(k1).toBe(k2);
    expect(typeof k1).toBe('string');
    expect(k1).toHaveLength(64); // SHA-256 hex
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §8 — Intent Compiler (intentCompiler.ts)
// ═════════════════════════════════════════════════════════════════════════════

import { compileIntents, type CompilationResult } from '../../server/protocols/intentCompiler';

describe('Intent Compiler', () => {
  // ── SQL Fusion ──────────────────────────────────────────────────────────

  describe('SQL Fusion', () => {
    it('fuses 2 queries against same table into 1', () => {
      const q1: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT revenue FROM `project.dataset.sales` WHERE year = 2024' },
        responseFormat: 'json_table',
      };
      const q2: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT dept FROM `project.dataset.sales` WHERE year = 2024' },
        responseFormat: 'json_table',
      };

      const result = compileIntents([q1, q2]);
      expect(result.fusionCount).toBeGreaterThan(0);
      expect(result.optimizedCount).toBeLessThan(result.originalCount);

      // The fused query should contain both columns
      const fusedSql = (result.optimized[result.optimized.length - 1] as QueryIntent).params.sql!;
      expect(fusedSql).toContain('revenue');
      expect(fusedSql).toContain('dept');
    });

    it('fuses 3 queries against same table, merging SELECT columns', () => {
      const makeQ = (col: string): QueryIntent => ({
        op: 'query', tool: 'query_bigquery',
        params: { sql: `SELECT ${col} FROM \`project.dataset.sales\` WHERE year = 2024` },
        responseFormat: 'json_table',
      });

      const result = compileIntents([makeQ('revenue'), makeQ('dept'), makeQ('region')]);
      expect(result.fusionCount).toBe(2); // 3 queries -> 1 = 2 fusions
      expect(result.optimizedCount).toBe(1);

      const fusedSql = (result.optimized[0] as QueryIntent).params.sql!;
      expect(fusedSql).toContain('revenue');
      expect(fusedSql).toContain('dept');
      expect(fusedSql).toContain('region');
    });

    it('does NOT fuse queries against different tables', () => {
      const q1: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT revenue FROM `project.dataset.sales` WHERE year = 2024' },
        responseFormat: 'json_table',
      };
      const q2: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT name FROM `project.dataset.users` WHERE year = 2024' },
        responseFormat: 'json_table',
      };

      const result = compileIntents([q1, q2]);
      expect(result.fusionCount).toBe(0);
    });

    it('does NOT fuse queries with different WHERE clauses', () => {
      const q1: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT revenue FROM `project.dataset.sales` WHERE year = 2024' },
        responseFormat: 'json_table',
      };
      const q2: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT dept FROM `project.dataset.sales` WHERE year = 2023' },
        responseFormat: 'json_table',
      };

      const result = compileIntents([q1, q2]);
      expect(result.fusionCount).toBe(0);
    });

    it('does NOT fuse queries with CTE (WITH clause)', () => {
      const q1: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'WITH cte AS (SELECT 1) SELECT revenue FROM `project.dataset.sales`' },
        responseFormat: 'json_table',
      };
      const q2: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT dept FROM `project.dataset.sales`' },
        responseFormat: 'json_table',
      };

      const result = compileIntents([q1, q2]);
      expect(result.fusionCount).toBe(0);
    });

    it('does NOT fuse queries from different tools', () => {
      const q1: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT revenue FROM `project.dataset.sales` WHERE year = 2024' },
        responseFormat: 'json_table',
      };
      const q2: QueryIntent = {
        op: 'query', tool: 'query_snowflake',
        params: { sql: 'SELECT dept FROM `project.dataset.sales` WHERE year = 2024' },
        responseFormat: 'json_table',
      };

      const result = compileIntents([q1, q2]);
      expect(result.fusionCount).toBe(0);
    });
  });

  // ── Deduplication ───────────────────────────────────────────────────────

  describe('Deduplication', () => {
    it('removes duplicate intents from batch', () => {
      const q: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT revenue FROM sales WHERE year = 2024' },
        responseFormat: 'json_table',
      };

      const result = compileIntents([q, q, q]);
      expect(result.deduplicationCount).toBe(2); // removed 2 duplicates
      expect(result.optimizedCount).toBe(1);
    });

    it('keeps non-duplicate intents unchanged', () => {
      const q1: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT a FROM t1 LIMIT 10' },
        responseFormat: 'json_table',
      };
      const q2: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT b FROM t2 LIMIT 10' },
        responseFormat: 'json_table',
      };

      const result = compileIntents([q1, q2]);
      expect(result.deduplicationCount).toBe(0);
    });
  });

  // ── LIMIT Injection ─────────────────────────────────────────────────────

  describe('LIMIT Injection', () => {
    it('injects LIMIT 1000 on queries without LIMIT', () => {
      const q: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT revenue FROM sales WHERE year = 2024' },
        responseFormat: 'json_table',
      };

      const result = compileIntents([q]);
      expect(result.limitInjections).toBe(1);
      const sql = (result.optimized[0] as QueryIntent).params.sql!;
      expect(sql).toContain('LIMIT 1000');
    });

    it('does NOT inject LIMIT on queries that already have one', () => {
      const q: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT revenue FROM sales LIMIT 50' },
        responseFormat: 'json_table',
      };

      const result = compileIntents([q]);
      expect(result.limitInjections).toBe(0);
      const sql = (result.optimized[0] as QueryIntent).params.sql!;
      expect(sql).toContain('LIMIT 50');
      expect(sql).not.toContain('LIMIT 1000');
    });

    it('does NOT inject LIMIT on pure aggregate queries', () => {
      const q: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT COUNT(*) FROM sales' },
        responseFormat: 'scalar',
      };

      const result = compileIntents([q]);
      expect(result.limitInjections).toBe(0);
      const sql = (result.optimized[0] as QueryIntent).params.sql!;
      expect(sql).not.toContain('LIMIT');
    });
  });

  // ── Single operation ────────────────────────────────────────────────────

  it('single op only gets LIMIT injection, no fusion', () => {
    const q: QueryIntent = {
      op: 'query', tool: 'query_bigquery',
      params: { sql: 'SELECT revenue FROM sales' },
      responseFormat: 'json_table',
    };

    const result = compileIntents([q]);
    expect(result.originalCount).toBe(1);
    expect(result.optimizedCount).toBe(1);
    expect(result.fusionCount).toBe(0);
    expect(result.deduplicationCount).toBe(0);
    expect(result.limitInjections).toBe(1);
  });

  // ── Empty ───────────────────────────────────────────────────────────────

  it('empty array returns empty result', () => {
    const result = compileIntents([]);
    expect(result.optimized).toEqual([]);
    expect(result.originalCount).toBe(0);
    expect(result.optimizedCount).toBe(0);
    expect(result.fusionCount).toBe(0);
    expect(result.deduplicationCount).toBe(0);
    expect(result.limitInjections).toBe(0);
    expect(result.wasOptimized).toBe(false);
  });

  // ── CompilationResult stats ─────────────────────────────────────────────

  describe('CompilationResult stats', () => {
    it('wasOptimized is true when optimizations applied', () => {
      const q: QueryIntent = {
        op: 'query', tool: 'query_bigquery',
        params: { sql: 'SELECT revenue FROM sales' },
        responseFormat: 'json_table',
      };

      const result = compileIntents([q]);
      // LIMIT injection applied
      expect(result.wasOptimized).toBe(true);
    });

    it('wasOptimized is false when nothing changed', () => {
      const q: ToolCallIntent = {
        op: 'tool_call',
        tool: 'read_file',
        args: { path: '/data/report.csv' },
      };

      const result = compileIntents([q]);
      expect(result.wasOptimized).toBe(false);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §9 — Capability Registry (capabilityRegistry.ts)
// ═════════════════════════════════════════════════════════════════════════════

import { CapabilityRegistry, validateInput } from '../../server/protocols/capabilityRegistry';
import type { CapabilityContext } from '../../server/protocols/capabilityRegistry';

describe('Capability Registry', () => {
  let registry: CapabilityRegistry;

  const testSchema = {
    type: 'object',
    properties: {
      a: { type: 'number' },
      b: { type: 'number' },
      mode: { type: 'string', enum: ['add', 'multiply'] },
    },
    required: ['a', 'b'],
  };

  const testCapability = {
    name: 'math.add',
    description: 'Adds two numbers',
    inputSchema: testSchema,
    outputSchema: { type: 'object', properties: { sum: { type: 'number' } } },
  };

  const dummyHandler = async (input: Record<string, unknown>) => ({ sum: (input.a as number) + (input.b as number) });

  beforeEach(() => {
    registry = new CapabilityRegistry();
  });

  it('register adds a capability', () => {
    registry.register(testCapability, dummyHandler);
    expect(registry.has('math.add')).toBe(true);
  });

  it('register rejects duplicate names', () => {
    registry.register(testCapability, dummyHandler);
    expect(() => registry.register(testCapability, dummyHandler)).toThrow("already registered");
  });

  it('get returns registered capability', () => {
    registry.register(testCapability, dummyHandler);
    const cap = registry.get('math.add');
    expect(cap).toBeDefined();
    expect(cap!.name).toBe('math.add');
    expect(cap!.description).toBe('Adds two numbers');
  });

  it('get returns undefined for unknown capability', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('has returns true for registered, false for unknown', () => {
    registry.register(testCapability, dummyHandler);
    expect(registry.has('math.add')).toBe(true);
    expect(registry.has('unknown.cap')).toBe(false);
  });

  it('getManifest returns all capabilities without handlers', () => {
    registry.register(testCapability, dummyHandler);
    registry.register(
      { name: 'math.multiply', description: 'Multiplies', inputSchema: testSchema, outputSchema: {} },
      dummyHandler,
    );

    const manifest = registry.getManifest();
    expect(manifest).toHaveLength(2);
    expect(manifest[0].name).toBe('math.add');
    expect(manifest[1].name).toBe('math.multiply');
  });

  it('getManifest does NOT include handler functions', () => {
    registry.register(testCapability, dummyHandler);
    const manifest = registry.getManifest();
    expect((manifest[0] as any).handler).toBeUndefined();
  });

  it('size returns count of registered capabilities', () => {
    expect(registry.size).toBe(0);
    registry.register(testCapability, dummyHandler);
    expect(registry.size).toBe(1);
    registry.register(
      { name: 'math.subtract', description: 'Subtracts', inputSchema: testSchema, outputSchema: {} },
      dummyHandler,
    );
    expect(registry.size).toBe(2);
  });

  it('clear removes all capabilities', () => {
    registry.register(testCapability, dummyHandler);
    expect(registry.size).toBe(1);
    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.has('math.add')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §10 — Capability Input Validation (capabilityRegistry.ts → validateInput)
// ═════════════════════════════════════════════════════════════════════════════

describe('Capability Input Validation', () => {
  const testSchema = {
    type: 'object',
    properties: {
      a: { type: 'number' },
      b: { type: 'number' },
      mode: { type: 'string', enum: ['add', 'multiply'] },
    },
    required: ['a', 'b'],
  };

  it('validateInput passes for valid input matching schema', () => {
    const result = validateInput({ a: 1, b: 2 }, testSchema);
    expect(result).toEqual({ valid: true });
  });

  it('validateInput fails for missing required field', () => {
    const result = validateInput({ a: 1 }, testSchema);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("'b'");
  });

  it('validateInput fails for wrong type', () => {
    const result = validateInput({ a: 'not-a-number', b: 2 }, testSchema);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("'number'");
  });

  it('validateInput fails for invalid enum value', () => {
    const result = validateInput({ a: 1, b: 2, mode: 'divide' }, testSchema);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must be one of');
  });

  it('validateInput passes when optional fields are omitted', () => {
    // 'mode' is optional (not in required) — should be fine to omit
    const result = validateInput({ a: 1, b: 2 }, testSchema);
    expect(result).toEqual({ valid: true });
  });

  it('validateInput fails when input is not an object', () => {
    const result = validateInput(null as any, testSchema);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must be an object');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §11 — Capability Execution (capabilityRegistry.ts → CapabilityRegistry.execute)
// ═════════════════════════════════════════════════════════════════════════════

describe('Capability Execution', () => {
  let registry: CapabilityRegistry;

  const testSchema = {
    type: 'object',
    properties: {
      a: { type: 'number' },
      b: { type: 'number' },
      mode: { type: 'string', enum: ['add', 'multiply'] },
    },
    required: ['a', 'b'],
  };

  const testCapability = {
    name: 'math.add',
    description: 'Adds two numbers',
    inputSchema: testSchema,
    outputSchema: { type: 'object', properties: { sum: { type: 'number' } } },
  };

  const handler = async (input: Record<string, unknown>, _ctx: CapabilityContext) => {
    return { sum: (input.a as number) + (input.b as number) };
  };

  const mockCtx: CapabilityContext = {
    executionCtx: {} as any,
    iceCall: jest.fn().mockResolvedValue({ data: { mock: true } }),
  };

  beforeEach(() => {
    registry = new CapabilityRegistry();
    registry.register(testCapability, handler);
  });

  it('execute runs handler and returns data', async () => {
    const result = await registry.execute('math.add', { a: 3, b: 7 }, mockCtx);
    expect(result.data).toEqual({ sum: 10 });
    expect(result.error).toBeUndefined();
  });

  it('execute validates input before running handler', async () => {
    const result = await registry.execute('math.add', { a: 'bad' } as any, mockCtx);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Input validation failed');
    expect(result.data).toBeUndefined();
  });

  it('execute returns error for unknown capability', async () => {
    const result = await registry.execute('unknown.cap', { a: 1, b: 2 }, mockCtx);
    expect(result.error).toContain('not found');
    expect(result.data).toBeUndefined();
  });

  it('execute catches handler errors gracefully', async () => {
    const failingHandler = async () => { throw new Error('boom'); };
    registry.register(
      { name: 'math.fail', description: 'Fails', inputSchema: { type: 'object', required: [] }, outputSchema: {} },
      failingHandler,
    );

    const result = await registry.execute('math.fail', {}, mockCtx);
    expect(result.error).toContain('execution failed');
    expect(result.error).toContain('boom');
    expect(result.data).toBeUndefined();
  });

  it('handler receives CapabilityContext with iceCall function', async () => {
    const spyHandler = jest.fn().mockResolvedValue({ ok: true });
    registry.register(
      { name: 'test.ctx', description: 'Tests ctx', inputSchema: { type: 'object', required: [] }, outputSchema: {} },
      spyHandler,
    );

    await registry.execute('test.ctx', {}, mockCtx);

    expect(spyHandler).toHaveBeenCalledTimes(1);
    const receivedCtx = spyHandler.mock.calls[0][1];
    expect(receivedCtx).toHaveProperty('iceCall');
    expect(typeof receivedCtx.iceCall).toBe('function');
  });

  it('getAction returns capability:name format', () => {
    const action = registry.getAction('math.add');
    expect(action).toBe('capability:math.add');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §12 — CapabilityIntent Validation (intentToken.ts → validateIntent / intentOpToAction)
// ═════════════════════════════════════════════════════════════════════════════

import type { CapabilityIntent } from '../../server/protocols/intentToken';

describe('CapabilityIntent Validation', () => {
  it('validateIntent accepts valid capability intent', () => {
    const intent: CapabilityIntent = {
      op: 'capability',
      name: 'risk.calculateVar',
      input: { product: 'bond', desk: 'rates', proposedQty: 100 },
    };
    const result = validateIntent(intent);
    expect(result).toEqual({ valid: true });
  });

  it('validateIntent rejects capability without name', () => {
    const intent = { op: 'capability', name: '', input: { a: 1 } } as any;
    const result = validateIntent(intent);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('name');
  });

  it('validateIntent rejects capability without input', () => {
    const intent = { op: 'capability', name: 'risk.calculateVar' } as any;
    const result = validateIntent(intent);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('input');
  });

  it('intentOpToAction returns capability:name', () => {
    const intent: CapabilityIntent = {
      op: 'capability',
      name: 'risk.calculateVar',
      input: { product: 'bond' },
    };
    expect(intentOpToAction(intent)).toBe('capability:risk.calculateVar');
  });
});
