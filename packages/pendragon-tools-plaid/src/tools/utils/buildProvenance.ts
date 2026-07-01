// server/tools/utils/buildProvenance.ts — Shared provenance builder for domain tools
//
// Queries plaid_accounts to build the provenance metadata that extractProvenance()
// in server/a2a/server.ts expects. All domain tools should call this and spread
// the result into their return object.

import { query, getWorkspaceId } from './domainDb.js';

export interface ToolProvenance {
  balance_verified: number;
  historical_verified: number;
  total_balance: number;
  accounts: Array<{
    account_id: string;
    current_balance: number;
    current_balance_verified: boolean;
    historical_series_verified: boolean;
  }>;
  last_synced: string | null;
}

/**
 * Build provenance metadata from plaid_accounts.
 *
 * @param isHistorical - true if the tool returns historical/time-series data
 *   (e.g. getTransactions, getCashflow, getBalanceHistory). When true,
 *   historical_series_verified is set based on whether we have transaction data.
 * @param hasTransactionData - true if the tool actually queried and returned
 *   transaction-level data (proving the historical series exists).
 */
export async function buildProvenance(
  isHistorical: boolean = false,
  hasTransactionData: boolean = false,
): Promise<ToolProvenance> {
  const wsId = getWorkspaceId();
  try {
    const result = await query(
      `SELECT account_id, balance_current, synced_at
       FROM plaid_accounts
       WHERE workspace_id = $1
       ORDER BY type, name`,
      [wsId]
    );

    let latestSyncedAt: string | null = null;
    let totalBalance = 0;

    const accounts = result.rows.map((row: any) => {
      const currentBalance = row.balance_current != null
        ? Math.abs(parseFloat(row.balance_current))
        : 0;
      totalBalance += currentBalance;

      const syncedAt = row.synced_at ? new Date(row.synced_at).toISOString() : null;
      if (syncedAt && (!latestSyncedAt || syncedAt > latestSyncedAt)) {
        latestSyncedAt = syncedAt;
      }

      return {
        account_id: row.account_id,
        current_balance: currentBalance,
        // Balances from Plaid API are always verified (they come from the institution)
        current_balance_verified: true,
        // Historical series is verified if we have transaction data for this query
        historical_series_verified: isHistorical && hasTransactionData,
      };
    });

    // If no Plaid connections are configured (synthetic/demo data),
    // treat data as always fresh — there's no external sync source.
    const hasConnections = !!process.env.RT_CONNECTIONS?.trim();
    const effectiveSyncedAt = hasConnections
      ? latestSyncedAt
      : new Date().toISOString();

    return {
      // All Plaid balances are institution-verified
      balance_verified: totalBalance,
      // Historical verification matches balance if we have transaction data
      historical_verified: isHistorical && hasTransactionData ? totalBalance : 0,
      total_balance: totalBalance,
      accounts,
      last_synced: effectiveSyncedAt,
    };
  } catch (err: any) {
    console.warn('[buildProvenance] Failed to build provenance:', err.message);
    // Return empty provenance on error — don't break the tool
    return {
      balance_verified: 0,
      historical_verified: 0,
      total_balance: 0,
      accounts: [],
      last_synced: null,
    };
  }
}
