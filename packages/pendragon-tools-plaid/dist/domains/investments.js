// src/domains/investments.ts — Investments/retirement domain module
// Contains sync logic, tools, and capabilities for investment-based domains.
// Creates its own ScopedPlaidClient to enforce domain isolation.
import { ScopedPlaidClient } from '../plaid/client.js';
import { withPool } from '../db/pool.js';
import { getSchemaForDomain } from '../db/schemas.js';
import { aggregateProvenance } from '../provenance.js';
// ─── Sync Logic ─────────────────────────────────────────────────────────────
async function syncInvestmentData(config) {
    const plaid = new ScopedPlaidClient(config.clientId, config.secret, config.env, config.domainType);
    return withPool(config.databaseUrl, async (pool) => {
        // 1. Create domain-scoped tables
        await pool.query(getSchemaForDomain(config.domainType));
        const summary = { success: true, domain: config.domainType };
        // 2. Sync accounts
        const accountsRes = await plaid.accountsGet(config.accessToken);
        const accounts = accountsRes.data.accounts;
        for (const acct of accounts) {
            await pool.query(`INSERT INTO plaid_accounts
           (account_id, name, mask, type, subtype,
            balance_available, balance_current, balance_limit, currency, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
         ON CONFLICT (account_id) DO UPDATE SET
           name = EXCLUDED.name,
           mask = EXCLUDED.mask,
           type = EXCLUDED.type,
           subtype = EXCLUDED.subtype,
           balance_available = EXCLUDED.balance_available,
           balance_current = EXCLUDED.balance_current,
           balance_limit = EXCLUDED.balance_limit,
           currency = EXCLUDED.currency,
           synced_at = NOW()`, [
                acct.account_id,
                acct.name,
                acct.mask,
                acct.type,
                acct.subtype,
                acct.balances?.available ?? null,
                acct.balances?.current ?? null,
                acct.balances?.limit ?? null,
                acct.balances?.iso_currency_code ?? acct.balances?.unofficial_currency_code ?? null,
            ]);
        }
        summary.accountsCount = accounts.length;
        // 3. Sync investment holdings + securities
        const holdingsRes = await plaid.investmentsHoldingsGet(config.accessToken);
        const { holdings, securities } = holdingsRes.data;
        // Upsert securities
        for (const sec of securities) {
            await pool.query(`INSERT INTO plaid_securities
           (security_id, ticker_symbol, name, type, close_price, currency, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6, NOW())
         ON CONFLICT (security_id) DO UPDATE SET
           ticker_symbol = EXCLUDED.ticker_symbol,
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           close_price = EXCLUDED.close_price,
           currency = EXCLUDED.currency,
           synced_at = NOW()`, [
                sec.security_id,
                sec.ticker_symbol ?? null,
                sec.name ?? null,
                sec.type ?? null,
                sec.close_price ?? null,
                sec.iso_currency_code ?? sec.unofficial_currency_code ?? null,
            ]);
        }
        // Clear and re-insert holdings (no natural PK from Plaid)
        await pool.query(`DELETE FROM plaid_holdings`);
        for (const h of holdings) {
            await pool.query(`INSERT INTO plaid_holdings
           (account_id, security_id, quantity, institution_price,
            institution_value, cost_basis, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6, NOW())`, [
                h.account_id,
                h.security_id,
                h.quantity,
                h.institution_price,
                h.institution_value,
                h.cost_basis ?? null,
            ]);
        }
        summary.holdingsCount = holdings.length;
        summary.securitiesCount = securities.length;
        return summary;
    });
}
// ─── Capability Handlers ────────────────────────────────────────────────────
function createGetHoldingsHandler(config) {
    return async (_input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            const { rows } = await pool.query(`SELECT h.holding_id, h.account_id, h.security_id,
                h.quantity, h.institution_price, h.institution_value,
                h.cost_basis, h.synced_at,
                s.ticker_symbol, s.name AS security_name,
                s.type AS security_type, s.close_price, s.currency
         FROM plaid_holdings h
         LEFT JOIN plaid_securities s ON s.security_id = h.security_id
         ORDER BY h.institution_value DESC`);
            // For holdings, all Plaid-synced data is both balance and historical verified
            const accountProvenance = rows.map((r) => ({
                account_id: r.account_id,
                current_balance: Math.abs(r.institution_value || 0),
                current_balance_verified: true,
                historical_series_verified: true, // Holdings are point-in-time snapshots from Plaid
            }));
            const provenance = aggregateProvenance(accountProvenance);
            return { holdings: rows, provenance };
        });
    };
}
function createGetSecuritiesHandler(config) {
    return async (input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            const ticker = input.ticker;
            let sql;
            let params;
            if (ticker) {
                sql = `SELECT security_id, ticker_symbol, name, type,
                      close_price, currency, synced_at
               FROM plaid_securities
               WHERE ticker_symbol = $1
               ORDER BY name`;
                params = [ticker.toUpperCase()];
            }
            else {
                sql = `SELECT security_id, ticker_symbol, name, type,
                      close_price, currency, synced_at
               FROM plaid_securities
               ORDER BY name`;
                params = [];
            }
            const { rows } = await pool.query(sql, params);
            // Securities provenance: each security is verified by Plaid
            const accountProvenance = rows.map((r) => ({
                account_id: r.security_id,
                current_balance: Math.abs(r.close_price || 0),
                current_balance_verified: true,
                historical_series_verified: true, // Securities data from Plaid is verified
            }));
            const provenance = aggregateProvenance(accountProvenance);
            return { securities: rows, provenance };
        });
    };
}
function createGetPortfolioSummaryHandler(config) {
    return async (_input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            // Total value and holdings count
            const totalsResult = await pool.query(`SELECT COALESCE(SUM(institution_value), 0) AS total_value,
                COUNT(*) AS holdings_count
         FROM plaid_holdings`);
            const { total_value, holdings_count } = totalsResult.rows[0];
            // Breakdown by security type
            const breakdownResult = await pool.query(`SELECT s.type,
                COALESCE(SUM(h.institution_value), 0) AS value,
                COUNT(*) AS count
         FROM plaid_holdings h
         LEFT JOIN plaid_securities s ON s.security_id = h.security_id
         GROUP BY s.type
         ORDER BY value DESC`);
            // Build provenance from investment accounts
            const acctResult = await pool.query(`SELECT account_id, balance_current, synced_at FROM plaid_accounts WHERE type = 'investment'`);
            const accountProvenance = acctResult.rows.map((r) => ({
                account_id: r.account_id,
                current_balance: Math.abs(r.balance_current || 0),
                current_balance_verified: true,
                historical_series_verified: true, // Investment data from Plaid is verified
            }));
            const lastSynced = acctResult.rows.length > 0 ? acctResult.rows[0].synced_at : null;
            const provenance = aggregateProvenance(accountProvenance, lastSynced);
            return {
                totalValue: parseFloat(total_value) || 0,
                holdingsCount: parseInt(holdings_count, 10) || 0,
                byType: breakdownResult.rows.map((row) => ({
                    type: row.type || 'unknown',
                    value: parseFloat(row.value) || 0,
                    count: parseInt(row.count, 10) || 0,
                })),
                provenance,
            };
        });
    };
}
function createSyncDataHandler(config) {
    return async (_input, _ctx) => {
        return syncInvestmentData(config);
    };
}
// ─── Tool Registration ──────────────────────────────────────────────────────
export function registerInvestmentTools(registry, config) {
    registry.register('plaid_sync', {
        name: 'plaid_sync',
        description: 'Sync investment data from Plaid into this workspace\'s database. ' +
            'Fetches accounts, holdings, and securities from the connected Plaid account and stores them in local PostgreSQL tables. ' +
            'Call this tool when you need to refresh or initially load investment data.',
        parameters: {
            type: 'object',
            properties: {
                syncType: {
                    type: 'string',
                    description: 'What to sync.',
                    enum: ['all', 'accounts', 'investments'],
                },
            },
            required: ['syncType'],
        },
        async execute(_args, _workspaceConfig) {
            return syncInvestmentData(config);
        },
    });
}
// ─── Capability Registration ────────────────────────────────────────────────
export function registerInvestmentCapabilities(registry, config) {
    // 1. Get holdings
    registry.register({
        name: 'plaid.getHoldings',
        description: 'Get investment holdings with current values',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
            type: 'object',
            properties: {
                holdings: {
                    type: 'array',
                    description: 'Holdings enriched with security details',
                },
            },
        },
        handler: createGetHoldingsHandler(config),
    });
    // 2. Get securities
    registry.register({
        name: 'plaid.getSecurities',
        description: 'Get security details for all held investments',
        inputSchema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'Filter by ticker symbol' },
            },
        },
        outputSchema: {
            type: 'object',
            properties: {
                securities: { type: 'array' },
            },
        },
        handler: createGetSecuritiesHandler(config),
    });
    // 3. Portfolio summary
    registry.register({
        name: 'plaid.getPortfolioSummary',
        description: 'Get aggregate portfolio summary with total value and allocation breakdown',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
            type: 'object',
            properties: {
                totalValue: { type: 'number' },
                holdingsCount: { type: 'number' },
                byType: {
                    type: 'array',
                    description: 'Breakdown by security type with value and count',
                },
            },
        },
        handler: createGetPortfolioSummaryHandler(config),
    });
    // 4. Sync data
    registry.register({
        name: 'plaid.syncData',
        description: 'Trigger a Plaid data sync to refresh investment holdings and securities',
        inputSchema: {
            type: 'object',
            properties: {
                syncType: {
                    type: 'string',
                    enum: ['all', 'accounts', 'investments'],
                },
            },
            required: ['syncType'],
        },
        outputSchema: {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                domain: { type: 'string' },
                accountsCount: { type: 'number' },
                holdingsCount: { type: 'number' },
                securitiesCount: { type: 'number' },
            },
        },
        handler: createSyncDataHandler(config),
    });
}
//# sourceMappingURL=investments.js.map