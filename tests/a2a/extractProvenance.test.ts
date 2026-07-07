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
