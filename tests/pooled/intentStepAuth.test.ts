/**
 * Per-step authorization in the ICE executor (upgrade plan 1.4).
 *
 * 'aggregate' in allowedActions authorizes the envelope only: every step's
 * tool must be allowed as `query:<tool>` / `tool:<tool>`. An unauthorized
 * step denies the whole intent BEFORE any step executes, and each step's
 * check is recorded in the proof. The proof also hashes the compiled SQL
 * that actually ran (executedSqlHash), additively.
 */

jest.mock('../../server/tools/index', () => ({
  executeTool: jest.fn().mockResolvedValue({ rows: [{ n: 1 }], rowCount: 1 }),
  resolveTools: jest.fn().mockReturnValue({ query_bigquery: {}, read_file: {} }),
  getAvailableTools: jest.fn().mockReturnValue([]),
}));

import type { AggregateIntent, QueryIntent, ToolCallIntent } from '../../server/protocols/intentToken';
import { buildIntentToken } from '../../server/protocols/intentTokenCodec';
import { executeIntentToken, ExecutionContext } from '../../server/protocols/intentExecutor';
import { verifyProof, hashExecutedSql, buildProof } from '../../server/protocols/executionProof';
import { intentCache } from '../../server/protocols/intentCache';
import { executeTool } from '../../server/tools/index';
import { deriveContractKey } from '../../server/utils/contractAuth';

const MASTER = 'step-auth-master';
const CONTRACT_ID = 'ctr-steps';

const q1: QueryIntent = { op: 'query', tool: 'query_bigquery', params: { sql: 'SELECT a FROM t1' }, responseFormat: 'json_table' };
const q2: QueryIntent = { op: 'query', tool: 'query_bigquery', params: { sql: 'SELECT b FROM t2' }, responseFormat: 'json_table' };
const tc: ToolCallIntent = { op: 'tool_call', tool: 'read_file', args: { path: '/x' } };

async function ctxWith(allowedActions: string[]): Promise<ExecutionContext> {
  return {
    contractKey: await deriveContractKey(MASTER, CONTRACT_ID, 1),
    contract: { contractId: CONTRACT_ID, allowedActions, status: 'active' },
    workspaceConfig: {},
    enabledToolNames: null,
  };
}

async function token(intent: AggregateIntent | QueryIntent) {
  return buildIntentToken(intent, CONTRACT_ID, 1, MASTER, { encrypt: false });
}

beforeEach(() => {
  (executeTool as jest.Mock).mockClear();
  intentCache.clear();
});

describe('aggregate per-step authorization', () => {
  it('denies the whole intent before any step runs when one step is unauthorized', async () => {
    const intent: AggregateIntent = { op: 'aggregate', steps: [q1, tc], reduce: 'concat' };
    const result = await executeIntentToken(await token(intent), await ctxWith(['aggregate', 'query:query_bigquery']));
    expect(result.status).toBe('denied');
    expect(result.error).toMatch(/step 1 action 'tool:read_file' is not authorized/);
    expect(executeTool).not.toHaveBeenCalled();
    const stepChecks = result.proof!.policyChecks.filter((c) => c.type === 'action_auth' && /^Step/.test(c.detail || ''));
    expect(stepChecks).toHaveLength(2);
    expect(stepChecks[0]).toMatchObject({ passed: true });
    expect(stepChecks[1]).toMatchObject({ passed: false });
  });

  it('denies when the envelope is allowed but no step tool is', async () => {
    const intent: AggregateIntent = { op: 'aggregate', steps: [q1], reduce: 'last' };
    const result = await executeIntentToken(await token(intent), await ctxWith(['aggregate']));
    expect(result.status).toBe('denied');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('runs when every step is authorized and records a check per step', async () => {
    const intent: AggregateIntent = { op: 'aggregate', steps: [q1, tc], reduce: 'concat' };
    const result = await executeIntentToken(await token(intent), await ctxWith(['aggregate', 'query:query_bigquery', 'tool:read_file']));
    expect(result.status).toBe('success');
    expect(executeTool).toHaveBeenCalledTimes(2);
    const stepChecks = result.proof!.policyChecks.filter((c) => c.type === 'action_auth' && /^Step/.test(c.detail || ''));
    expect(stepChecks.every((c) => c.passed)).toBe(true);
    expect(stepChecks.length).toBeGreaterThanOrEqual(2);
  });

  it("'*' authorizes every step", async () => {
    const intent: AggregateIntent = { op: 'aggregate', steps: [q1, tc], reduce: 'concat' };
    const result = await executeIntentToken(await token(intent), await ctxWith(['*']));
    expect(result.status).toBe('success');
  });

  it('a top-level query still needs query:<tool> (unchanged) and is denied otherwise', async () => {
    const result = await executeIntentToken(await token(q1), await ctxWith(['aggregate']));
    expect(result.status).toBe('denied');
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe('proof hashes the compiled SQL actually executed', () => {
  it('top-level query: executedSqlHash covers the SQL passed to the tool', async () => {
    const ctx = await ctxWith(['query:query_bigquery']);
    const result = await executeIntentToken(await token(q1), ctx);
    expect(result.status).toBe('success');
    const executed = (executeTool as jest.Mock).mock.calls.map((c) => c[1].sql);
    expect(executed).toEqual(['SELECT a FROM t1']);
    expect(result.proof!.executedSqlHash).toBe(hashExecutedSql(executed));
    expect(result.proof!.executedSqlCount).toBe(1);
    expect(verifyProof(result.proof!, ctx.contractKey, undefined, undefined, executed)).toEqual({ valid: true });
    expect(verifyProof(result.proof!, ctx.contractKey, undefined, undefined, ['SELECT a FROM t1 LIMIT 1']).valid).toBe(false);
  });

  it('aggregate: hashes the FUSED statement(s) the tool received, not the requested ones', async () => {
    const intent: AggregateIntent = { op: 'aggregate', steps: [q1, q2], reduce: 'concat' };
    const ctx = await ctxWith(['*']);
    const result = await executeIntentToken(await token(intent), ctx);
    expect(result.status).toBe('success');
    const executed = (executeTool as jest.Mock).mock.calls.map((c) => c[1].sql);
    expect(executed.length).toBeGreaterThanOrEqual(1);
    expect(result.proof!.executedSqlCount).toBe(executed.length);
    expect(result.proof!.executedSqlHash).toBe(hashExecutedSql(executed));
    if (result.compilation?.fusionCount) {
      // fused: one statement differing from either original
      expect(executed).not.toEqual([q1.params.sql, q2.params.sql]);
    }
  });

  it('a proof without SQL carries no executed-SQL fields and still verifies (backward compatible)', async () => {
    const ctx = await ctxWith(['tool:read_file']);
    const result = await executeIntentToken(await token({ op: 'aggregate', steps: [tc], reduce: 'last' } as AggregateIntent), await ctxWith(['*']));
    expect(result.status).toBe('success');
    expect(result.proof!.executedSqlHash).toBeUndefined();
    expect(result.proof!.executedSqlCount).toBeUndefined();
    expect(verifyProof(result.proof!, (await ctxWith(['*'])).contractKey).valid).toBe(true);
    // Asking to verify SQL against a no-SQL proof fails explicitly
    expect(verifyProof(result.proof!, ctx.contractKey, undefined, undefined, ['SELECT 1']).error).toMatch(/no executedSqlHash/);
  });

  it('buildProof without a trace is byte-compatible with the pre-1.4 proof body', async () => {
    const key = await deriveContractKey(MASTER, CONTRACT_ID, 1);
    const p = buildProof(q1, { ok: true }, 'query_bigquery', 1, CONTRACT_ID, key, []);
    expect(Object.keys(p).sort()).toEqual(
      ['contractId', 'executionMs', 'inputHash', 'outputHash', 'policyChecks', 'proofGrade', 'proofSignature', 'timestamp', 'toolName'],
    );
    expect(verifyProof(p, key).valid).toBe(true);
  });
});
