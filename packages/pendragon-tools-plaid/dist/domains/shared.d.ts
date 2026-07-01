import { ScopedPlaidClient } from '../plaid/client.js';
import type { PlaidPluginConfig, CapabilityHandler } from '../types.js';
type Pool = InstanceType<typeof import('pg').Pool>;
export declare function normalizeAmount(amount: number): number;
/**
 * Sync accounts from Plaid into plaid_accounts table.
 * Used by checking, debt, and any domain that connects Plaid accounts.
 */
export declare function syncAccounts(plaid: ScopedPlaidClient, pool: Pool, accessToken: string): Promise<number>;
/**
 * Sync transactions from Plaid using cursor-based incremental sync.
 * Used by checking, debt, taxes, realestate — any domain with transactionsSync.
 */
export declare function syncTransactions(plaid: ScopedPlaidClient, pool: Pool, accessToken: string, itemId?: string): Promise<{
    added: number;
    modified: number;
    removed: number;
}>;
/**
 * Generic balance query — works on any domain with plaid_accounts table.
 */
export declare function createGetBalancesHandler(config: PlaidPluginConfig): CapabilityHandler;
/**
 * Generic transaction query with optional filters — works on any domain
 * with plaid_transactions table.
 */
export declare function createGetTransactionsHandler(config: PlaidPluginConfig): CapabilityHandler;
export {};
//# sourceMappingURL=shared.d.ts.map