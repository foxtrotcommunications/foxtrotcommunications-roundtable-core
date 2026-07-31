// tests/a2a/extractProvenance.test.ts — provenance extraction from tool results
//
// Regression coverage for the provenance-footer defects observed in live
// Pendragon responses:
//   - inferred_amount equalling the whole balance on non-historical calls
//   - discover/verify_workspace transport ops rendered as $0/$0 noise rows
//   - completeness/historical_support reported as 0 for scoped balance
//     questions where they were never factors in the confidence calc

import { extractProvenance } from '../../server/a2a/server';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bridgeResult(
  target: string,
  capability: string,
  provenance: Record<string, unknown> | null,
  extraData: Record<string, unknown> = {},
) {
  return {
    name: 'intent_bridge',
    result: {
      success: true,
      target,
      capability,
      executionMs: 25,
      data: provenance ? { provenance, ...extraData } : { ...extraData },
    } as Record<string, unknown>,
  };
}

function balanceProvenance(total: number) {
  return {
    balance_verified: total,
    historical_verified: 0,
    total_balance: total,
    accounts: [
      {
        account_id: 'acct-1',
        current_balance: total,
        current_balance_verified: true,
        historical_series_verified: false,
      },
    ],
    last_synced: new Date().toISOString(),
  };
}

function historicalProvenance(total: number) {
  return {
    ...balanceProvenance(total),
    historical_verified: total,
    accounts: [
      {
        account_id: 'acct-1',
        current_balance: total,
        current_balance_verified: true,
        historical_series_verified: true,
      },
    ],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('extractProvenance', () => {
  it('reports inferred_amount = 0 for fully verified balances (non-historical)', () => {
    const p = extractProvenance([
      bridgeResult('Checking & Savings', 'capability:plaid.getBalances', balanceProvenance(73077.74)),
    ]) as any;

    const domain = p.domains.find((d: any) => /Checking/.test(d.name));
    expect(domain.verified_amount).toBeCloseTo(73077.74);
    expect(domain.inferred_amount).toBe(0);
  });

  it('omits completeness and historical_support for scoped non-historical queries', () => {
    const p = extractProvenance([
      bridgeResult('Real Estate', 'capability:property.getMortgageDetails', balanceProvenance(1565000)),
    ]) as any;

    // These were never factors in the confidence calc for a balance query —
    // they must not be reported as 0% (the "0% completeness beside 100%
    // confidence" bug).
    expect(p.confidence_factors.completeness).toBeUndefined();
    expect(p.confidence_factors.historical_support).toBeUndefined();
    expect(p.confidence_factors.freshness).toBeDefined();
  });

  it('reports completeness for historical queries', () => {
    const p = extractProvenance([
      bridgeResult('Checking & Savings', 'capability:plaid.getTransactions', historicalProvenance(73077.74)),
    ]) as any;

    expect(p.confidence_factors.completeness).toBe(100);
    expect(p.confidence_factors.historical_support).toBe(100);
  });

  it('filters transport/discovery ops out of the domains list', () => {
    const p = extractProvenance([
      bridgeResult('Checking & Savings', 'discover', null),
      bridgeResult('Checking & Savings', 'tool:verify_workspace', null),
      bridgeResult('Checking & Savings', 'capability:plaid.getBalances', balanceProvenance(100)),
    ]) as any;

    expect(p.domains).toHaveLength(1);
    expect(p.domains[0].capability).toBe('capability:plaid.getBalances');
  });

  it('sums verified amounts across multiple domains', () => {
    const p = extractProvenance([
      bridgeResult('Checking & Savings', 'capability:plaid.getBalances', balanceProvenance(100)),
      bridgeResult('Debt Management', 'capability:plaid.getDebtSummary', balanceProvenance(50)),
    ]) as any;

    expect(p.domains).toHaveLength(2);
    const verified = p.domains.reduce((s: number, d: any) => s + d.verified_amount, 0);
    expect(verified).toBe(150);
  });

  it('skips failed tool results entirely', () => {
    const p = extractProvenance([
      { name: 'intent_bridge', result: { success: false, target: 'Taxes', capability: 'capability:plaid.getBalances' } },
      bridgeResult('Checking & Savings', 'capability:plaid.getBalances', balanceProvenance(100)),
    ]) as any;

    expect(p.domains).toHaveLength(1);
  });
});

// declare_missing_data is a real tool call whose result echoes its args.
// Observed live 2026-07-31: the pod executed it, the artifact never carried
// it, and the client rendered "none emitted" — the declaration died here.
describe('extractProvenance — declare_missing_data', () => {
  const declResult = {
    name: 'declare_missing_data',
    result: {
      recorded: true,
      domains: ['Retirement'],
      wouldEnable: ['I could compare the plans against your actual contribution room'],
    } as Record<string, unknown>,
  };

  it('a declaration alone produces a minimal provenance carrying it', () => {
    const p = extractProvenance([declResult]) as any;
    expect(p).not.toBeNull();
    expect(p.domains).toHaveLength(0);
    expect(p.missing).toEqual(['Retirement']);
    expect(p.wouldImprove).toEqual(['I could compare the plans against your actual contribution room']);
  });

  it('no bridge, no emit, no declaration — still null', () => {
    expect(extractProvenance([])).toBeNull();
    expect(extractProvenance([
      { name: 'declare_missing_data', result: { recorded: true, domains: [] } },
    ])).toBeNull();
  });

  it('emit-only: declaration fills missing/wouldImprove when the emit lacks them', () => {
    const p = extractProvenance([
      { name: 'emit_provenance', result: { domainsConsulted: [], dataFreshMinutes: 0 } },
      declResult,
    ]) as any;
    expect(p.missing).toEqual(['Retirement']);
    expect(p.wouldImprove).toEqual(['I could compare the plans against your actual contribution room']);
  });

  it("emit-only: the emit's own fields win when both exist", () => {
    const p = extractProvenance([
      { name: 'emit_provenance', result: { domainsConsulted: [], missingDomains: ['Taxes'], wouldImprove: ['tax view'] } },
      declResult,
    ]) as any;
    expect(p.missing).toEqual(['Taxes']);
    expect(p.wouldImprove).toEqual(['tax view']);
  });

  it('full path: a declaration rides along even when domains were consulted', () => {
    const p = extractProvenance([
      bridgeResult('Checking & Savings', 'capability:plaid.getBalances', balanceProvenance(100)),
      declResult,
    ]) as any;
    expect(p.domains).toHaveLength(1);
    expect(p.missing).toEqual(['Retirement']);
    expect(p.wouldImprove).toEqual(['I could compare the plans against your actual contribution room']);
  });
});
