// src/domains/shared.ts — Shared handlers and sync logic for Plaid-backed domains
// Contains reusable functions used by multiple domain modules (checking, debt, etc.)
// Domain files import these and register them as domain-specific capabilities.

import { ScopedPlaidClient } from '../plaid/client.js';
import { withPool } from '../db/pool.js';
import type { PlaidPluginConfig, CapabilityHandler } from '../types.js';

type Pool = InstanceType<typeof import('pg').Pool>;

// ─── Amount Normalization ───────────────────────────────────────────────────
// Plaid convention: positive = money leaving account (debit/expense),
//                   negative = money entering account (credit/income).
// Standard accounting: positive = money in, negative = money out.
// We negate ALL amounts at sync time so the rest of the system uses
// conventional accounting signs.

export function normalizeAmount(amount: number): number {
  return -amount;
}

// ─── Shared Sync Logic ──────────────────────────────────────────────────────

/**
 * Sync accounts from Plaid into plaid_accounts table.
 * Used by checking, debt, and any domain that connects Plaid accounts.
 */
export async function syncAccounts(
  plaid: ScopedPlaidClient,
  pool: Pool,
  accessToken: string,
  workspaceId: string,
): Promise<number> {
  const accountsRes = await plaid.accountsGet(accessToken);
  const accounts = accountsRes.data.accounts;

  for (const acct of accounts) {
    await pool.query(
      `INSERT INTO plaid_accounts
         (account_id, name, mask, type, subtype,
          balance_available, balance_current, balance_limit, currency, workspace_id, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
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
        workspaceId,
      ],
    );
  }

  return accounts.length;
}

/**
 * Sync transactions from Plaid using cursor-based incremental sync.
 * Used by checking, debt, taxes, realestate — any domain with transactionsSync.
 */
export async function syncTransactions(
  plaid: ScopedPlaidClient,
  pool: Pool,
  accessToken: string,
  workspaceId: string,
  itemId?: string,
): Promise<{ added: number; modified: number; removed: number }> {
  // Load cursor for incremental sync
  let cursor: string | undefined;
  if (itemId) {
    const cursorRes = await pool.query(
      `SELECT cursor FROM plaid_sync_state WHERE item_id = $1 AND workspace_id = $2`,
      [itemId, workspaceId],
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
    const syncRes = await plaid.transactionsSync(accessToken, cursor);
    const data = syncRes.data;

    for (const txn of data.added) {
      await pool.query(
        `INSERT INTO plaid_transactions
           (transaction_id, account_id, amount, date, name,
            merchant_name, category, payment_channel, pending, workspace_id, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
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
          normalizeAmount(txn.amount),
          txn.date,
          txn.name,
          txn.merchant_name ?? null,
          txn.category ? txn.category.join(', ') : null,
          txn.payment_channel,
          txn.pending,
          workspaceId,
        ],
      );
      addedCount++;
    }

    for (const txn of data.modified) {
      await pool.query(
        `INSERT INTO plaid_transactions
           (transaction_id, account_id, amount, date, name,
            merchant_name, category, payment_channel, pending, workspace_id, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
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
          normalizeAmount(txn.amount),
          txn.date,
          txn.name,
          txn.merchant_name ?? null,
          txn.category ? txn.category.join(', ') : null,
          txn.payment_channel,
          txn.pending,
          workspaceId,
        ],
      );
      modifiedCount++;
    }

    for (const txn of data.removed) {
      await pool.query(
        `DELETE FROM plaid_transactions WHERE transaction_id = $1 AND workspace_id = $2`,
        [txn.transaction_id, workspaceId],
      );
      removedCount++;
    }

    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  // Persist cursor for next incremental sync
  if (itemId && cursor) {
    await pool.query(
      `INSERT INTO plaid_sync_state (item_id, cursor, workspace_id, last_sync_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (item_id) DO UPDATE SET
         cursor = EXCLUDED.cursor,
         last_sync_at = NOW()`,
      [itemId, cursor, workspaceId],
    );
  }

  return { added: addedCount, modified: modifiedCount, removed: removedCount };
}

// ─── Shared Capability Handlers ─────────────────────────────────────────────

/**
 * Generic balance query — works on any domain with plaid_accounts table.
 */
export function createGetBalancesHandler(config: PlaidPluginConfig): CapabilityHandler {
  return async (_input, _ctx) => {
    return withPool(config.databaseUrl, async (pool) => {
      const { rows } = await pool.query(
        `SELECT account_id, name, type, subtype,
                balance_available, balance_current, balance_limit,
                currency, synced_at
         FROM plaid_accounts
         WHERE workspace_id = $1
         ORDER BY name`,
        [config.workspaceId],
      );
      return { accounts: rows };
    });
  };
}

/**
 * Generic transaction query with optional filters — works on any domain
 * with plaid_transactions table.
 */
export function createGetTransactionsHandler(config: PlaidPluginConfig): CapabilityHandler {
  return async (input, _ctx) => {
    return withPool(config.databaseUrl, async (pool) => {
      const conditions: string[] = ['workspace_id = $1'];
      const params: unknown[] = [config.workspaceId];
      let paramIdx = 2;

      if (input.startDate) {
        conditions.push(`date >= $${paramIdx++}`);
        params.push(input.startDate);
      }
      if (input.endDate) {
        conditions.push(`date <= $${paramIdx++}`);
        params.push(input.endDate);
      }
      if (input.category) {
        conditions.push(`category ILIKE $${paramIdx++}`);
        params.push(`%${input.category}%`);
      }
      if (input.merchant) {
        conditions.push(`merchant_name ILIKE $${paramIdx++}`);
        params.push(`%${input.merchant}%`);
      }

      const limit = typeof input.limit === 'number' && input.limit > 0
        ? Math.min(input.limit as number, 500)
        : 50;

      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

      const sql = `SELECT transaction_id, account_id, amount, date, name,
                          merchant_name, category, payment_channel, pending, synced_at
                   FROM plaid_transactions
                   ${whereClause}
                   ORDER BY date DESC
                   LIMIT $${paramIdx}`;
      params.push(limit);

      const { rows } = await pool.query(sql, params);
      return { transactions: rows, count: rows.length };
    });
  };
}
