// @ts-nocheck
// server/tools/listAccounts.ts — List all linked financial accounts with balances
import { query } from './utils/domainDb.js';
import { buildProvenance } from './utils/buildProvenance.js';
const tool = {
    name: 'list_accounts',
    description: 'List all linked financial accounts. Returns account name, type, subtype, mask, balances (available, current, limit), currency, and last sync time. No parameters required.',
    parameters: {
        type: 'object',
        properties: {},
        required: [],
    },
    async execute(_args, _workspaceConfig = {}) {
        const start = Date.now();
        try {
            const sql = `
        SELECT
          account_id,
          name,
          mask,
          type,
          subtype,
          balance_available,
          balance_current,
          balance_limit,
          currency,
          synced_at
        FROM plaid_accounts
        ORDER BY type, name
      `;
            const result = await query(sql);
            const accounts = result.rows.map((row) => ({
                account_id: row.account_id,
                name: row.name,
                mask: row.mask,
                type: row.type,
                subtype: row.subtype,
                balance_available: row.balance_available != null ? parseFloat(row.balance_available) : null,
                balance_current: row.balance_current != null ? parseFloat(row.balance_current) : null,
                balance_limit: row.balance_limit != null ? parseFloat(row.balance_limit) : null,
                currency: row.currency,
                synced_at: row.synced_at ? new Date(row.synced_at).toISOString() : null,
            }));
            const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
            const coverageGaps = [];
            if (connections.length <= 1)
                coverageGaps.push('Only 1 institution connected — results may be incomplete');
            const provenance = await buildProvenance(false, false);
            return {
                provenance,
                accounts,
                total_accounts: accounts.length,
                metadata: {
                    accounts_analyzed: accounts.length,
                },
                coverage: {
                    institutions_connected: connections.length,
                    gaps: coverageGaps,
                },
                executionMs: Date.now() - start,
            };
        }
        catch (err) {
            return { error: `Failed to list accounts: ${err.message}`, executionMs: Date.now() - start };
        }
    },
};
export default tool;
//# sourceMappingURL=listAccounts.js.map