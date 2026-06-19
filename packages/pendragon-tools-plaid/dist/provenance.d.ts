import { Pool } from 'pg';
export interface AccountProvenance {
    account_id: string;
    current_balance: number;
    current_balance_verified: boolean;
    historical_series_verified: boolean;
}
export interface CapabilityProvenance {
    accounts: AccountProvenance[];
    total_balance: number;
    balance_verified: number;
    historical_verified: number;
    last_synced: string | null;
    data_source: 'plaid_api';
}
/**
 * Check which accounts have transaction history in the local DB.
 */
export declare function checkTransactionHistory(pool: Pool, accountIds: string[]): Promise<Record<string, boolean>>;
/**
 * Build per-account provenance from account rows and transaction history map.
 */
export declare function buildAccountProvenance(rows: Array<{
    account_id: string;
    balance_current?: number;
    current_balance?: number;
}>, historyMap: Record<string, boolean>): AccountProvenance[];
/**
 * Aggregate provenance from per-account data.
 */
export declare function aggregateProvenance(accounts: AccountProvenance[], lastSynced?: string | null): CapabilityProvenance;
//# sourceMappingURL=provenance.d.ts.map