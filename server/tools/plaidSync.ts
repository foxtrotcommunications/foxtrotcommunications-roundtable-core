// DEPRECATED: This file has been replaced by @pendragon/tools-plaid
// It will be removed in a future release.
// @ts-nocheck
// server/tools/plaidSync.ts — Sync financial data from Plaid into workspace database
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import pg from 'pg';

const { Pool } = pg;

import type { Tool } from '../types.js';

// ─── SQL for table creation ───────────────────────────────────────
const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS plaid_accounts (
  account_id TEXT PRIMARY KEY,
  name TEXT,
  mask TEXT,
  type TEXT,
  subtype TEXT,
  balance_available NUMERIC,
  balance_current NUMERIC,
  balance_limit NUMERIC,
  currency TEXT,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS plaid_transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT,
  amount NUMERIC,
  date DATE,
  name TEXT,
  merchant_name TEXT,
  category TEXT,
  payment_channel TEXT,
  pending BOOLEAN,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS plaid_holdings (
  holding_id SERIAL PRIMARY KEY,
  account_id TEXT,
  security_id TEXT,
  quantity NUMERIC,
  institution_price NUMERIC,
  institution_value NUMERIC,
  cost_basis NUMERIC,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS plaid_securities (
  security_id TEXT PRIMARY KEY,
  ticker_symbol TEXT,
  name TEXT,
  type TEXT,
  close_price NUMERIC,
  currency TEXT,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS plaid_sync_state (
  id SERIAL PRIMARY KEY,
  item_id TEXT UNIQUE,
  cursor TEXT,
  last_sync_at TIMESTAMPTZ DEFAULT NOW()
);
`;

// ─── Helper: resolve Plaid connection from RT_CONNECTIONS ─────────
function getPlaidCredentials(): {
  accessToken: string;
  clientId: string;
  secret: string;
  plaidEnv: string;
  domainType: string;
  itemId: string;
} | null {
  const connectionsRaw = process.env.RT_CONNECTIONS;
  if (!connectionsRaw) return null;

  try {
    const connections = JSON.parse(connectionsRaw);
    const plaidConn = Array.isArray(connections)
      ? connections.find((c: any) => c.type === 'plaid')
      : null;

    if (!plaidConn) return null;

    const prefix = plaidConn.envPrefix;
    const accessToken = process.env[`${prefix}_ACCESS_TOKEN`];
    const clientId = process.env[`${prefix}_CLIENT_ID`];
    const secret = process.env[`${prefix}_PLAID_SECRET`];
    const plaidEnv = process.env[`${prefix}_PLAID_ENV`] || 'sandbox';
    const domainType = process.env[`${prefix}_DOMAIN_TYPE`] || '';
    const itemId = process.env[`${prefix}_ITEM_ID`] || '';

    if (!accessToken || !clientId || !secret) return null;

    return { accessToken, clientId, secret, plaidEnv, domainType, itemId };
  } catch {
    return null;
  }
}

// ─── Tool definition ──────────────────────────────────────────────
const tool: Tool = {
  name: 'plaid_sync',
  description:
    'Sync financial data from Plaid into this workspace\'s database. Fetches accounts, transactions, and/or investment holdings based on the connected Plaid account and stores them in local PostgreSQL tables. Call this tool when you need to refresh or initially load financial data.',
  parameters: {
    type: 'object',
    properties: {
      syncType: {
        type: 'string',
        description: 'What to sync.',
        enum: ['all', 'accounts', 'transactions', 'investments'],
      },
      force: {
        type: 'boolean',
        description: 'If true, re-sync all data instead of incremental. Default false.',
      },
    },
    required: ['syncType'],
  },

  async execute(args: any, _workspaceConfig: any = {}) {
    const { syncType, force = false } = args;

    // ── 1. Read Plaid credentials ──────────────────────────────
    const creds = getPlaidCredentials();
    if (!creds) {
      return {
        error:
          'No Plaid connection configured on this workspace. Ask an admin to add a Plaid connection.',
      };
    }

    // ── 2. Initialize Plaid client ─────────────────────────────
    const plaidConfig = new Configuration({
      basePath: PlaidEnvironments[creds.plaidEnv] || PlaidEnvironments.sandbox,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': creds.clientId,
          'PLAID-SECRET': creds.secret,
        },
      },
    });
    const plaidClient = new PlaidApi(plaidConfig);

    // ── 3. Connect to workspace database ───────────────────────
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      return { error: 'DATABASE_URL is not set. Cannot connect to workspace database.' };
    }

    const pool = new Pool({ connectionString: databaseUrl });

    try {
      // ── 4. Create tables if not exist ──────────────────────────
      await pool.query(CREATE_TABLES_SQL);

      const summary: Record<string, unknown> = {
        success: true,
        synced: syncType,
      };

      // ── 5. Sync accounts ───────────────────────────────────────
      if (syncType === 'all' || syncType === 'accounts') {
        const accountsRes = await plaidClient.accountsGet({
          access_token: creds.accessToken,
        });
        const accounts = accountsRes.data.accounts;

        for (const acct of accounts) {
          await pool.query(
            `INSERT INTO plaid_accounts
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
               synced_at = NOW()`,
            [
              acct.account_id,
              acct.name,
              acct.mask,
              acct.type,
              acct.subtype,
              acct.balances?.available ?? null,
              acct.balances?.current ?? null,
              acct.balances?.limit ?? null,
              acct.balances?.iso_currency_code ?? acct.balances?.unofficial_currency_code ?? null,
            ],
          );
        }

        summary.accountsCount = accounts.length;
      }

      // ── 6. Sync transactions ───────────────────────────────────
      if (syncType === 'all' || syncType === 'transactions') {
        // Read existing cursor (unless force=true)
        let cursor: string | undefined;
        if (!force && creds.itemId) {
          const cursorRes = await pool.query(
            `SELECT cursor FROM plaid_sync_state WHERE item_id = $1`,
            [creds.itemId],
          );
          if (cursorRes.rows.length > 0 && cursorRes.rows[0].cursor) {
            cursor = cursorRes.rows[0].cursor;
          }
        }

        let addedCount = 0;
        let modifiedCount = 0;
        let removedCount = 0;
        let hasMore = true;

        while (hasMore) {
          const syncRes = await plaidClient.transactionsSync({
            access_token: creds.accessToken,
            ...(cursor ? { cursor } : {}),
          });
          const data = syncRes.data;

          // Insert/update added transactions
          for (const txn of data.added) {
            await pool.query(
              `INSERT INTO plaid_transactions
                 (transaction_id, account_id, amount, date, name,
                  merchant_name, category, payment_channel, pending, synced_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
               ON CONFLICT (transaction_id) DO UPDATE SET
                 account_id = EXCLUDED.account_id,
                 amount = EXCLUDED.amount,
                 date = EXCLUDED.date,
                 name = EXCLUDED.name,
                 merchant_name = EXCLUDED.merchant_name,
                 category = EXCLUDED.category,
                 payment_channel = EXCLUDED.payment_channel,
                 pending = EXCLUDED.pending,
                 synced_at = NOW()`,
              [
                txn.transaction_id,
                txn.account_id,
                txn.amount,
                txn.date,
                txn.name,
                txn.merchant_name ?? null,
                txn.category ? txn.category.join(', ') : null,
                txn.payment_channel,
                txn.pending,
              ],
            );
            addedCount++;
          }

          // Update modified transactions
          for (const txn of data.modified) {
            await pool.query(
              `INSERT INTO plaid_transactions
                 (transaction_id, account_id, amount, date, name,
                  merchant_name, category, payment_channel, pending, synced_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
               ON CONFLICT (transaction_id) DO UPDATE SET
                 account_id = EXCLUDED.account_id,
                 amount = EXCLUDED.amount,
                 date = EXCLUDED.date,
                 name = EXCLUDED.name,
                 merchant_name = EXCLUDED.merchant_name,
                 category = EXCLUDED.category,
                 payment_channel = EXCLUDED.payment_channel,
                 pending = EXCLUDED.pending,
                 synced_at = NOW()`,
              [
                txn.transaction_id,
                txn.account_id,
                txn.amount,
                txn.date,
                txn.name,
                txn.merchant_name ?? null,
                txn.category ? txn.category.join(', ') : null,
                txn.payment_channel,
                txn.pending,
              ],
            );
            modifiedCount++;
          }

          // Delete removed transactions
          for (const txn of data.removed) {
            await pool.query(
              `DELETE FROM plaid_transactions WHERE transaction_id = $1`,
              [txn.transaction_id],
            );
            removedCount++;
          }

          cursor = data.next_cursor;
          hasMore = data.has_more;
        }

        // Persist cursor for incremental sync
        if (creds.itemId && cursor) {
          await pool.query(
            `INSERT INTO plaid_sync_state (item_id, cursor, last_sync_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (item_id) DO UPDATE SET
               cursor = EXCLUDED.cursor,
               last_sync_at = NOW()`,
            [creds.itemId, cursor],
          );
        }

        summary.transactionsCount = addedCount + modifiedCount;
        summary.transactionsRemoved = removedCount;
      }

      // ── 7. Sync investments ────────────────────────────────────
      if (syncType === 'all' || syncType === 'investments') {
        try {
          const holdingsRes = await plaidClient.investmentsHoldingsGet({
            access_token: creds.accessToken,
          });
          const { holdings, securities } = holdingsRes.data;

          // Upsert securities
          for (const sec of securities) {
            await pool.query(
              `INSERT INTO plaid_securities
                 (security_id, ticker_symbol, name, type, close_price, currency, synced_at)
               VALUES ($1,$2,$3,$4,$5,$6, NOW())
               ON CONFLICT (security_id) DO UPDATE SET
                 ticker_symbol = EXCLUDED.ticker_symbol,
                 name = EXCLUDED.name,
                 type = EXCLUDED.type,
                 close_price = EXCLUDED.close_price,
                 currency = EXCLUDED.currency,
                 synced_at = NOW()`,
              [
                sec.security_id,
                sec.ticker_symbol ?? null,
                sec.name ?? null,
                sec.type ?? null,
                sec.close_price ?? null,
                sec.iso_currency_code ?? sec.unofficial_currency_code ?? null,
              ],
            );
          }

          // Clear and re-insert holdings
          await pool.query(`DELETE FROM plaid_holdings`);
          for (const h of holdings) {
            await pool.query(
              `INSERT INTO plaid_holdings
                 (account_id, security_id, quantity, institution_price,
                  institution_value, cost_basis, synced_at)
               VALUES ($1,$2,$3,$4,$5,$6, NOW())`,
              [
                h.account_id,
                h.security_id,
                h.quantity,
                h.institution_price,
                h.institution_value,
                h.cost_basis ?? null,
              ],
            );
          }

          summary.holdingsCount = holdings.length;
          summary.securitiesCount = securities.length;
        } catch (investErr: any) {
          // Not all Plaid items support investments — treat as non-fatal
          summary.investmentsError =
            investErr?.response?.data?.error_message ||
            investErr.message ||
            'Investment data not available for this account';
        }
      }

      return summary;
    } catch (err: any) {
      const plaidError = err?.response?.data;
      return {
        error: plaidError?.error_message || err.message || 'Plaid sync failed',
        code: plaidError?.error_code || err.code || null,
      };
    } finally {
      await pool.end();
    }
  },
};

export default tool;
