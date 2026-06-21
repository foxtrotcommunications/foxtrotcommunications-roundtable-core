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
export declare function buildProvenance(isHistorical?: boolean, hasTransactionData?: boolean): Promise<ToolProvenance>;
//# sourceMappingURL=buildProvenance.d.ts.map