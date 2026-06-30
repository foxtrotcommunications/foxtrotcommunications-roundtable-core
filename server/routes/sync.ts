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

    const plaidConn = connections.find((c: any) => c.type === 'plaid');
    if (!plaidConn) {
      return res.status(400).json({ error: 'No Plaid connection found in RT_CONNECTIONS' });
    }

    // Build config from env vars
    const prefix = plaidConn.envPrefix || 'PLAID';
    const domainType = process.env[`${prefix}_DOMAIN_TYPE`] || plaidConn.domainType || 'checking';
    const config = {
      domainType,
      accessToken: process.env[`${prefix}_ACCESS_TOKEN`] || '',
      clientId: process.env[`${prefix}_CLIENT_ID`] || process.env.PLAID_CLIENT_ID || '',
      secret: process.env[`${prefix}_PLAID_SECRET`] || process.env.PLAID_SECRET || '',
      env: process.env[`${prefix}_PLAID_ENV`] || process.env.PLAID_ENV || 'sandbox',
      itemId: process.env[`${prefix}_ITEM_ID`],
      databaseUrl: process.env.DATABASE_URL || '',
    };

    if (!config.accessToken) {
      return res.status(400).json({ error: 'Missing Plaid access token' });
    }
    if (!config.databaseUrl) {
      return res.status(400).json({ error: 'Missing DATABASE_URL' });
    }

    // Import the capability registry which has the syncData handler
    const { capabilityRegistry } = require('../protocols/capabilityRegistry');

    // Try to invoke the plaid.syncData capability (registered by @pendragon/tools-plaid)
    const syncHandler = capabilityRegistry.getHandler?.('plaid.syncData');
    if (syncHandler) {
      console.log('[sync] Invoking plaid.syncData capability...');
      const result = await syncHandler({ syncType: 'all' });
      console.log('[sync] Sync complete:', JSON.stringify(result).substring(0, 200));
      return res.json(result);
    }

    // Fallback: directly import and call the domain sync function
    console.log(`[sync] Capability not found, using direct domain sync for: ${domainType}`);
    let syncModule;
    try {
      if (domainType === 'debt' || domainType === 'realestate') {
        syncModule = require('@pendragon/tools-plaid/src/domains/debt.ts');
      } else if (domainType === 'investments' || domainType === 'retirement') {
        syncModule = require('@pendragon/tools-plaid/src/domains/investments.ts');
      } else if (domainType === 'demographics') {
        syncModule = require('@pendragon/tools-plaid/src/domains/demographics.ts');
      } else {
        syncModule = require('@pendragon/tools-plaid/src/domains/checking.ts');
      }
    } catch (importErr: any) {
      console.warn(`[sync] Domain module import failed (will use direct Plaid API): ${importErr.message}`);
    }

    // Domain modules export a syncXxxData function
    const syncFnName = syncModule ? Object.keys(syncModule).find(k => k.startsWith('sync') && k.endsWith('Data')) : null;
    const syncFn = syncFnName ? syncModule[syncFnName] : null;

    if (!syncFn) {
      // Last resort: use ScopedPlaidClient directly for basic account + transaction sync
      console.log('[sync] No domain sync function found, using direct Plaid API...');
      const { ScopedPlaidClient } = require('@pendragon/tools-plaid');
      const { Pool } = require('pg');
      const plaid = new ScopedPlaidClient(config.clientId, config.secret, config.env, config.domainType);
      const pool = new Pool({ connectionString: config.databaseUrl });

      try {
        // Ensure tables exist
        await pool.query(`
          CREATE TABLE IF NOT EXISTS plaid_accounts (
            account_id TEXT PRIMARY KEY,
            name TEXT, mask TEXT, type TEXT, subtype TEXT,
            balance_available NUMERIC, balance_current NUMERIC, balance_limit NUMERIC,
            currency TEXT DEFAULT 'USD', synced_at TIMESTAMPTZ
          );
          CREATE TABLE IF NOT EXISTS plaid_transactions (
            transaction_id TEXT PRIMARY KEY,
            account_id TEXT REFERENCES plaid_accounts(account_id),
            amount NUMERIC, name TEXT, merchant_name TEXT,
            category TEXT[], date DATE, pending BOOLEAN DEFAULT false,
            payment_channel TEXT, synced_at TIMESTAMPTZ
          );
        `);

        // Sync accounts
        const accountsRes = await plaid.accountsGet(config.accessToken);
        const accounts = accountsRes.data.accounts;
        for (const acct of accounts) {
          await pool.query(
            `INSERT INTO plaid_accounts (account_id, name, mask, type, subtype, balance_available, balance_current, balance_limit, currency, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
             ON CONFLICT (account_id) DO UPDATE SET
               name=EXCLUDED.name, mask=EXCLUDED.mask, balance_available=EXCLUDED.balance_available,
               balance_current=EXCLUDED.balance_current, balance_limit=EXCLUDED.balance_limit, synced_at=NOW()`,
            [acct.account_id, acct.name, acct.mask, acct.type, acct.subtype,
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
              `INSERT INTO plaid_transactions (transaction_id, account_id, amount, name, merchant_name, category, date, pending, payment_channel, synced_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
               ON CONFLICT (transaction_id) DO UPDATE SET
                 amount=EXCLUDED.amount, name=EXCLUDED.name, pending=EXCLUDED.pending, synced_at=NOW()`,
              [tx.transaction_id, tx.account_id, -(tx.amount), tx.name, tx.merchant_name,
               tx.category, tx.date, tx.pending, tx.payment_channel]
            );
            added++;
          }
          cursor = txData.next_cursor;
          hasMore = txData.has_more;
        }

        const result = { success: true, accountsCount: accounts.length, transactionsAdded: added };
        console.log('[sync] Direct sync complete:', JSON.stringify(result));
        return res.json(result);
      } finally {
        await pool.end();
      }
    }

    // Call the domain's sync function
    console.log(`[sync] Calling ${syncFnName}...`);
    const result = await syncFn(config);
    console.log('[sync] Sync complete:', JSON.stringify(result).substring(0, 200));
    return res.json(result);
  } catch (err: any) {
    console.error('[sync] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
