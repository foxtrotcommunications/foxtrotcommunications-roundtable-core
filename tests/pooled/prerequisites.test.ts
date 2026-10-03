/**
 * Executable contract prerequisites (upgrade plan 5.3, doctrine §7).
 *
 *   amount_max / freshness_hours / grant_required — each kind passes and
 *   fails as specified; missing fields, unknown kinds and a missing grant
 *   verifier all deny; a failing prerequisite executes zero tools, is
 *   recorded as { type:'prerequisite', kind, passed:false } in the proof and
 *   leaves nothing in the intent cache; the pooled grant verifier peeks via
 *   the plugin's assertGrant inside a transaction it always rolls back.
 */

jest.mock('../../server/tools/index', () => ({
  executeTool: jest.fn().mockResolvedValue({ rows: [{ n: 1 }] }),
  resolveTools: jest.fn().mockReturnValue({ query_bigquery: { readOnly: true }, read_file: {} }),
  getAvailableTools: jest.fn().mockReturnValue([]),
  tools: { query_bigquery: { readOnly: true } },
}));

import crypto from 'crypto';
import type { CapabilityIntent, QueryIntent, ToolCallIntent } from '../../server/protocols/intentToken';
import { buildIntentToken } from '../../server/protocols/intentTokenCodec';
import { executeIntentToken, type ExecutionContext } from '../../server/protocols/intentExecutor';
import { evaluatePrerequisites, intentParams, CONSENT_GRANT_PARAM } from '../../server/protocols/prerequisites';
import { capabilityRegistry } from '../../server/protocols/capabilityRegistry';
import { intentCache } from '../../server/protocols/intentCache';
import { executeTool } from '../../server/tools/index';
import { buildGrantVerifier } from '../../server/pooled/grantVerifier';

const KEY = crypto.randomBytes(32);
const NOW = Date.parse('2026-10-03T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 3_600_000;

describe('evaluatePrerequisites — each kind', () => {
  it('no prerequisites → nothing to check', async () => {
    expect(await evaluatePrerequisites(undefined, { amount: 1 })).toEqual({ checks: [] });
    expect(await evaluatePrerequisites([], { amount: 1 })).toEqual({ checks: [] });
  });

  it('amount_max: ≤ passes, > fails, missing / non-numeric fails', async () => {
    const p = [{ kind: 'amount_max', field: 'amount', value: 10_000 }];
    expect((await evaluatePrerequisites(p, { amount: 10_000 })).denied).toBeUndefined();
    expect((await evaluatePrerequisites(p, { amount: 10_000.01 })).denied).toMatch(/exceeds 10000/);
    expect((await evaluatePrerequisites(p, {})).denied).toMatch(/missing or not a number/);
    expect((await evaluatePrerequisites(p, { amount: '5' })).denied).toMatch(/not a number/);
    expect((await evaluatePrerequisites(p, { amount: NaN })).denied).toMatch(/not a number/);
    const r = await evaluatePrerequisites(p, { amount: 5 });
    expect(r.checks).toEqual([{ type: 'prerequisite', kind: 'amount_max', passed: true, detail: expect.stringContaining("'amount' = 5 ≤ 10000") }]);
  });

  it('freshness_hours: within window passes, older fails, future fails, missing / bad timestamp fails', async () => {
    const p = [{ kind: 'freshness_hours', field: 'as_of', value: 24 }];
    expect((await evaluatePrerequisites(p, { as_of: iso(23 * H) }, { now: NOW })).denied).toBeUndefined();
    expect((await evaluatePrerequisites(p, { as_of: iso(25 * H) }, { now: NOW })).denied).toMatch(/25.00 h old, limit 24 h/);
    expect((await evaluatePrerequisites(p, { as_of: iso(-10 * 60_000) }, { now: NOW })).denied).toMatch(/in the future/);
    expect((await evaluatePrerequisites(p, { as_of: iso(-60_000) }, { now: NOW })).denied).toBeUndefined(); // ≤ 5 min skew
    expect((await evaluatePrerequisites(p, {}, { now: NOW })).denied).toMatch(/missing or not an ISO timestamp/);
    expect((await evaluatePrerequisites(p, { as_of: 'yesterday' }, { now: NOW })).denied).toMatch(/not an ISO timestamp/);
  });

  it('grant_required: verifier true passes; false / throw / missing id / no verifier deny', async () => {
    const p = [{ kind: 'grant_required', scope: 'goals.plan.activate' }];
    const yes = jest.fn().mockResolvedValue(true);
    const r = await evaluatePrerequisites(p, { [CONSENT_GRANT_PARAM]: 'g1', plan_id: 'pl' }, { grantVerifier: yes });
    expect(r.denied).toBeUndefined();
    expect(yes).toHaveBeenCalledWith('g1', 'goals.plan.activate', { [CONSENT_GRANT_PARAM]: 'g1', plan_id: 'pl' });
    expect((await evaluatePrerequisites(p, { [CONSENT_GRANT_PARAM]: 'g1' }, { grantVerifier: async () => false })).denied).toMatch(/did not verify/);
    expect((await evaluatePrerequisites(p, { [CONSENT_GRANT_PARAM]: 'g1' }, { grantVerifier: async () => { throw new Error('db'); } })).denied).toMatch(/did not verify/);
    expect((await evaluatePrerequisites(p, { [CONSENT_GRANT_PARAM]: 'g1' }, { grantVerifier: (async () => 'yes') as any })).denied).toMatch(/did not verify/);
    expect((await evaluatePrerequisites(p, {}, { grantVerifier: yes })).denied).toMatch(/consent_grant_id' is missing/);
    expect((await evaluatePrerequisites(p, { [CONSENT_GRANT_PARAM]: 'g1' })).denied).toMatch(/no grant verifier is wired/);
  });

  it('unknown kind, malformed entry, non-list → deny', async () => {
    expect((await evaluatePrerequisites([{ kind: 'rate_limit', value: 1 }], {})).denied).toMatch(/unknown kind 'rate_limit'/);
    expect((await evaluatePrerequisites([{ kind: 'amount_max' }], { x: 1 })).denied).toMatch(/no field\/value/);
    expect((await evaluatePrerequisites(['nope'], {})).denied).toMatch(/malformed/);
    expect((await evaluatePrerequisites({ kind: 'amount_max' } as any, {})).denied).toMatch(/not a list/);
  });

  it('evaluates ALL prerequisites and records each, denying on the first failure', async () => {
    const p = [
      { kind: 'amount_max', field: 'amount', value: 10 },
      { kind: 'freshness_hours', field: 'as_of', value: 1 },
      { kind: 'amount_max', field: 'fee', value: 1 },
    ];
    const r = await evaluatePrerequisites(p, { amount: 50, as_of: iso(0), fee: 0.5 }, { now: NOW });
    expect(r.checks.map((c) => [c.kind, c.passed])).toEqual([['amount_max', false], ['freshness_hours', true], ['amount_max', true]]);
    expect(r.denied).toMatch(/'amount' = 50 exceeds 10/);
  });

  it('intentParams: capability input / tool args / query params; aggregates have none', () => {
    expect(intentParams({ op: 'capability', name: 'x', input: { a: 1 } } as CapabilityIntent)).toEqual({ a: 1 });
    expect(intentParams({ op: 'tool_call', tool: 't', args: { b: 2 } } as ToolCallIntent)).toEqual({ b: 2 });
    expect(intentParams({ op: 'query', tool: 'q', params: { sql: 's' }, responseFormat: 'json_table' } as QueryIntent)).toEqual({ sql: 's' });
    expect(intentParams({ op: 'aggregate', steps: [], reduce: 'last' } as any)).toEqual({});
    expect(intentParams({ op: 'discover', scope: 'tools' } as any)).toEqual({});
  });
});

describe('executor: prerequisites run after action auth, before cache, before any tool', () => {
  const q: QueryIntent = { op: 'query', tool: 'query_bigquery', params: { sql: 'SELECT 1', amount: 500 } as any, responseFormat: 'json_table' };
  const ctx = (prerequisites: unknown, extra: Partial<ExecutionContext> = {}): ExecutionContext => ({
    contractKey: KEY,
    contract: { contractId: 'ctr_p', allowedActions: ['*'], status: 'active', prerequisites },
    workspaceConfig: {}, enabledToolNames: null, ...extra,
  });
  const tok = () => buildIntentToken(q, 'ctr_p', 1, 'm', { encrypt: false });

  beforeEach(() => { (executeTool as jest.Mock).mockClear(); intentCache.clear(); });

  it('a failing prerequisite denies, executes zero tools, records the check, and is not cached', async () => {
    const r = await executeIntentToken(await tok(), ctx([{ kind: 'amount_max', field: 'amount', value: 100 }]));
    expect(r.status).toBe('denied');
    expect(r.error).toMatch(/Prerequisite not met for contract 'ctr_p': amount_max: 'amount' = 500 exceeds 100/);
    expect(executeTool).not.toHaveBeenCalled();
    expect(r.proof!.policyChecks).toEqual(expect.arrayContaining([
      { type: 'action_auth', passed: true, detail: expect.any(String) },
      { type: 'prerequisite', kind: 'amount_max', passed: false, detail: expect.stringContaining('exceeds 100') },
    ]));
    expect(intentCache.get(q, '')).toBeNull();
    // And a later caller whose contract has no prerequisite is not served a cached denial either.
    const ok = await executeIntentToken(await tok(), ctx(undefined));
    expect(ok.status).toBe('success');
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('a passing prerequisite executes and the proof records it as passed', async () => {
    const r = await executeIntentToken(await tok(), ctx([{ kind: 'amount_max', field: 'amount', value: 1000 }]));
    expect(r.status).toBe('success');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(r.proof!.policyChecks).toEqual(expect.arrayContaining([{ type: 'prerequisite', kind: 'amount_max', passed: true, detail: expect.any(String) }]));
  });

  it('a cached result is NOT served to a request that fails the prerequisite', async () => {
    // Warm the cache with a contract that has no prerequisite…
    const first = await executeIntentToken(await tok(), ctx(undefined));
    expect(first.status).toBe('success');
    expect(intentCache.get(q, '')).not.toBeNull();
    // …then the same intent under a contract whose limit it exceeds.
    const r = await executeIntentToken(await tok(), ctx([{ kind: 'amount_max', field: 'amount', value: 1 }]));
    expect(r.status).toBe('denied');
    expect(r.cached).toBeUndefined();
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('action authorization still comes first (an unauthorized action never reaches the prerequisites)', async () => {
    const r = await executeIntentToken(await tok(), {
      ...ctx([{ kind: 'amount_max', field: 'amount', value: 1 }]),
      contract: { contractId: 'ctr_p', allowedActions: ['tool:other'], status: 'active', prerequisites: [{ kind: 'amount_max', field: 'amount', value: 1 }] },
    });
    expect(r.status).toBe('denied');
    expect(r.error).toMatch(/not authorized/);
    expect(r.proof!.policyChecks.some((c) => c.type === 'prerequisite')).toBe(false);
  });

  it('grant_required on a capability: no verifier → denied, verifier true → runs', async () => {
    capabilityRegistry.register({
      name: 'plan.activate', description: 'x', readOnly: false,
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      handler: async () => ({ data: { activated: true } }),
    } as any);
    const cap: CapabilityIntent = { op: 'capability', name: 'plan.activate', input: { plan_id: 'pl', [CONSENT_GRANT_PARAM]: 'g1' } };
    const ctok = await buildIntentToken(cap, 'ctr_p', 1, 'm', { encrypt: false });
    const prereq = [{ kind: 'grant_required', scope: 'goals.plan.activate' }];
    const denied = await executeIntentToken(ctok, ctx(prereq));
    expect(denied.status).toBe('denied');
    expect(denied.error).toMatch(/no grant verifier is wired/);
    const verifier = jest.fn().mockResolvedValue(true);
    const ok = await executeIntentToken(await buildIntentToken(cap, 'ctr_p', 1, 'm', { encrypt: false }), ctx(prereq, { grantVerifier: verifier }));
    expect(ok.status).toBe('success');
    expect(verifier).toHaveBeenCalledWith('g1', 'goals.plan.activate', cap.input);
    capabilityRegistry.unregister?.('plan.activate');
  });
});

describe('pooled grant verifier (plugin assertGrant peeked in a rolled-back tenant transaction)', () => {
  const queries: string[] = [];
  const client = { query: jest.fn(async (sql: string) => { queries.push(sql); return { rows: [] }; }), release: jest.fn() };
  const pool: any = { connect: jest.fn(async () => client) };
  const plugin = {
    assertGrant: jest.fn(),
    targetFor: jest.fn((_s: string, input: Record<string, unknown>) => String(input.plan_id ?? null)),
    isGrantScope: jest.fn((s: unknown) => s === 'goals.plan.activate'),
  };
  const tenant = { workspaceId: 'wsB', databaseUrl: 'postgresql://x' };
  beforeEach(() => { queries.length = 0; jest.clearAllMocks(); });

  it('returns undefined without a plugin, a tenant, or a database (→ grant_required denies)', () => {
    expect(buildGrantVerifier(tenant, null)).toBeUndefined();
    expect(buildGrantVerifier(undefined, plugin as any)).toBeUndefined();
    expect(buildGrantVerifier({ workspaceId: 'wsB' }, plugin as any)).toBeUndefined();
    expect(buildGrantVerifier({ ...tenant, workspaceId: ' ' }, plugin as any)).toBeUndefined();
  });

  it('pins the tenant, runs assertGrant with the plugin-derived target, and ALWAYS rolls back', async () => {
    plugin.assertGrant.mockResolvedValue({ grant_id: 'g1' });
    const verify = buildGrantVerifier(tenant, plugin as any, () => pool)!;
    expect(await verify('g1', 'goals.plan.activate', { plan_id: 'pl' })).toBe(true);
    expect(plugin.assertGrant).toHaveBeenCalledWith(client, { workspaceId: 'wsB', grantId: 'g1', scope: 'goals.plan.activate', target: 'pl' });
    expect(queries[0]).toBe('BEGIN');
    expect(client.query).toHaveBeenCalledWith("SELECT set_config('app.workspace_id', $1, true)", ['wsB']);
    expect(queries[queries.length - 1]).toBe('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('a refused grant → false (still rolled back, still released)', async () => {
    plugin.assertGrant.mockRejectedValue(new Error('consent_grant_used'));
    const verify = buildGrantVerifier(tenant, plugin as any, () => pool)!;
    expect(await verify('g1', 'goals.plan.activate', { plan_id: 'pl' })).toBe(false);
    expect(queries[queries.length - 1]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('an unknown scope → false without touching the database', async () => {
    const verify = buildGrantVerifier(tenant, plugin as any, () => pool)!;
    expect(await verify('g1', 'not.a.scope', {})).toBe(false);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
