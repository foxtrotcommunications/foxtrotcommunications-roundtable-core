// @ts-nocheck
// server/routes/sync.ts — Plaid data sync endpoint
// Called by Pendragon during domain provisioning and periodically for refresh.

import { Router } from 'express';

const router = Router();

/**
 * POST /api/sync
 * Trigger a Plaid data sync for this workspace.
 * Creates tables if not exist, then syncs accounts, transactions, and liabilities.
 */
router.post('/', async (req, res) => {
  try {
    // Read connection config from RT_CONNECTIONS env
    const connectionsJson = process.env.RT_CONNECTIONS;
    if (!connectionsJson) {
      return res.status(400).json({ error: 'No connections configured (RT_CONNECTIONS is empty)' });
    }

    let connections;
    try {
      connections = JSON.parse(connectionsJson);
    } catch {
      return res.status(400).json({ error: 'Invalid RT_CONNECTIONS JSON' });
    }

    const plaidConns = connections.filter((c: any) => c.type === 'plaid');
    if (!plaidConns.length) {
      return res.status(400).json({ error: 'No Plaid connection found in RT_CONNECTIONS' });
    }

    const databaseUrl = process.env.DATABASE_URL || '';
    if (!databaseUrl) {
      return res.status(400).json({ error: 'Missing DATABASE_URL' });
    }

    // Import the capability registry which has the syncData handler
    const { capabilityRegistry } = require('../protocols/capabilityRegistry');

    // Try the plaid.syncData capability once (it handles all connections internally)
    const syncHandler = capabilityRegistry.getHandler?.('plaid.syncData');
    if (syncHandler) {
      console.log('[sync] Invoking plaid.syncData capability...');
      const result = await syncHandler({ syncType: 'all' });
      console.log('[sync] Sync complete:', JSON.stringify(result).substring(0, 200));
      return res.json(result);
    }

    // Fallback: iterate every Plaid connection individually
    console.log(`[sync] Capability not found, syncing ${plaidConns.length} Plaid connection(s) directly...`);

    /**
     * Helper: resolve an env var with legacy fallback.
     * Tries `{prefix}_{field}` first (e.g. CONN_PLAID_0_ACCESS_TOKEN),
     * then falls back to `CONN_PLAID_{field}` (legacy, no index).
     */
    const envWithFallback = (prefix: string, field: string, globalFallback?: string): string => {
      return process.env[`${prefix}_${field}`]
        || process.env[`CONN_PLAID_${field}`]
        || globalFallback
        || '';
    };

    const results: any[] = [];

    // Use the shared domain database pool instead of creating an ad-hoc one
    const { getPool: getDomainPool } = require('../tools/utils/domainDb');
    const pool = getDomainPool();
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS plaid_accounts (
          account_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT, mask TEXT, type TEXT, subtype TEXT,
          balance_available NUMERIC, balance_current NUMERIC, balance_limit NUMERIC,
          currency TEXT DEFAULT 'USD', synced_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_plaid_accounts_ws ON plaid_accounts(workspace_id);
        CREATE TABLE IF NOT EXISTS plaid_transactions (
          transaction_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          account_id TEXT REFERENCES plaid_accounts(account_id),
          amount NUMERIC, name TEXT, merchant_name TEXT,
          category TEXT[], date DATE, pending BOOLEAN DEFAULT false,
          payment_channel TEXT, synced_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_plaid_transactions_ws ON plaid_transactions(workspace_id);
      `);

      // --- Loop over each Plaid connection ---
      for (const plaidConn of plaidConns) {
        const connLabel = plaidConn.envPrefix || plaidConn.id || 'unknown';
        try {
          const prefix = plaidConn.envPrefix || 'PLAID';
          const domainType = process.env[`${prefix}_DOMAIN_TYPE`] || plaidConn.domainType || 'checking';
          const workspaceId = process.env.WS_ID || process.env.WORKSPACE_ID || 'default';
          const config = {
            domainType,
            accessToken: envWithFallback(prefix, 'ACCESS_TOKEN'),
            clientId: envWithFallback(prefix, 'CLIENT_ID', process.env.PLAID_CLIENT_ID),
            secret: envWithFallback(prefix, 'PLAID_SECRET', process.env.PLAID_SECRET),
            env: envWithFallback(prefix, 'PLAID_ENV', process.env.PLAID_ENV) || 'sandbox',
            itemId: process.env[`${prefix}_ITEM_ID`] || process.env['CONN_PLAID_ITEM_ID'],
            databaseUrl,
            workspaceId,
          };

          if (!config.accessToken) {
            console.warn(`[sync] Skipping connection "${connLabel}": missing access token`);
            results.push({ connection: connLabel, success: false, error: 'Missing Plaid access token' });
            continue;
          }

          // Try domain-specific sync module. Extensionless specifiers on
          // purpose: tsx (dev) resolves the .ts source, plain node (image)
          // resolves the .js sibling precompiled at Docker build time.
          let syncModule;
          try {
            if (domainType === 'debt' || domainType === 'realestate') {
              syncModule = require('@pendragon/tools-plaid/src/domains/debt');
            } else if (domainType === 'investments' || domainType === 'retirement') {
              syncModule = require('@pendragon/tools-plaid/src/domains/investments');
            } else if (domainType === 'demographics') {
              syncModule = require('@pendragon/tools-plaid/src/domains/demographics');
            } else {
              syncModule = require('@pendragon/tools-plaid/src/domains/checking');
            }
          } catch (importErr: any) {
            console.warn(`[sync] Domain module import failed for "${connLabel}" (will use direct Plaid API): ${importErr.message}`);
          }

          const syncFnName = syncModule ? Object.keys(syncModule).find(k => k.startsWith('sync') && k.endsWith('Data')) : null;
          const syncFn = syncFnName ? syncModule[syncFnName] : null;

          if (syncFn) {
            // Use the domain's sync function
            console.log(`[sync] Calling ${syncFnName} for connection "${connLabel}"...`);
            const result = await syncFn(config);
            console.log(`[sync] Connection "${connLabel}" sync complete:`, JSON.stringify(result).substring(0, 200));
            results.push({ connection: connLabel, success: true, ...result });
            continue;
          }

          // Last resort: use ScopedPlaidClient directly for basic account + transaction sync
          console.log(`[sync] No domain sync function found for "${connLabel}", using direct Plaid API...`);
          const { ScopedPlaidClient } = require('@pendragon/tools-plaid');
          const plaid = new ScopedPlaidClient(config.clientId, config.secret, config.env, config.domainType);

          // Sync accounts
          const accountsRes = await plaid.accountsGet(config.accessToken);
          const accounts = accountsRes.data.accounts;
          for (const acct of accounts) {
            // Dedup: skip if same (name, mask, type, subtype) already exists from another connection
            const existing = await pool.query(
              `SELECT account_id FROM plaid_accounts
               WHERE workspace_id = $1 AND name = $2 AND mask = $3 AND type = $4 AND subtype = $5
               AND account_id != $6 LIMIT 1`,
              [workspaceId, acct.name, acct.mask, acct.type, acct.subtype, acct.account_id]
            );
            if (existing.rows.length > 0) {
              console.log(`[sync] Dedup: account "${acct.name}" (${acct.mask}) already exists, updating balances`);
              await pool.query(
                `UPDATE plaid_accounts SET balance_available=$1, balance_current=$2, balance_limit=$3, currency=$4, synced_at=NOW() WHERE account_id=$5`,
                [acct.balances.available, acct.balances.current, acct.balances.limit, acct.balances.iso_currency_code || 'USD', existing.rows[0].account_id]
              );
              continue;
            }

            await pool.query(
              `INSERT INTO plaid_accounts (account_id, workspace_id, name, mask, type, subtype, balance_available, balance_current, balance_limit, currency, synced_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
               ON CONFLICT (account_id) DO UPDATE SET
                 name=EXCLUDED.name, mask=EXCLUDED.mask, balance_available=EXCLUDED.balance_available,
                 balance_current=EXCLUDED.balance_current, balance_limit=EXCLUDED.balance_limit, synced_at=NOW()`,
              [acct.account_id, workspaceId, acct.name, acct.mask, acct.type, acct.subtype,
               acct.balances.available, acct.balances.current, acct.balances.limit, acct.balances.iso_currency_code || 'USD']
            );
          }

          // Sync transactions
          let cursor = undefined;
          let added = 0;
          let hasMore = true;
          while (hasMore) {
            const txRes = await plaid.transactionsSync(config.accessToken, cursor);
            const txData = txRes.data;
            for (const tx of txData.added || []) {
              await pool.query(
                `INSERT INTO plaid_transactions (transaction_id, workspace_id, account_id, amount, name, merchant_name, category, date, pending, payment_channel, synced_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
                 ON CONFLICT (transaction_id) DO UPDATE SET
                   amount=EXCLUDED.amount, name=EXCLUDED.name, pending=EXCLUDED.pending, synced_at=NOW()`,
                [tx.transaction_id, workspaceId, tx.account_id, -(tx.amount), tx.name, tx.merchant_name,
                 tx.category, tx.date, tx.pending, tx.payment_channel]
              );
              added++;
            }
            cursor = txData.next_cursor;
            hasMore = txData.has_more;
          }

          console.log(`[sync] Connection "${connLabel}" direct sync complete: ${accounts.length} accounts, ${added} transactions`);
          results.push({ connection: connLabel, success: true, accountsCount: accounts.length, transactionsAdded: added });
        } catch (connErr: any) {
          console.error(`[sync] Error syncing connection "${connLabel}":`, connErr.message);
          results.push({ connection: connLabel, success: false, error: connErr.message });
        }
      }
    } finally {
      // Don't close the pool — it's the shared domainDb singleton
    }

    console.log(`[sync] All connections processed: ${results.filter(r => r.success).length}/${results.length} succeeded`);
    return res.json({ success: true, synced: results });
  } catch (err: any) {
    console.error('[sync] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
