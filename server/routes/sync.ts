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
    // Try to use the @pendragon/tools-plaid package
    let registerFromEnv, pendragonPlaid;
    try {
      const plaidPlugin = require('@pendragon/tools-plaid');
      registerFromEnv = plaidPlugin.registerFromEnv;
      pendragonPlaid = plaidPlugin.pendragonPlaid;
    } catch {
      return res.status(501).json({ error: 'Plaid sync not available — @pendragon/tools-plaid not installed' });
    }

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

    // Build config from env vars (same logic as registerFromEnv)
    const prefix = plaidConn.envPrefix || 'PLAID';
    const config = {
      domainType: process.env[`${prefix}_DOMAIN_TYPE`] || plaidConn.domainType || 'checking',
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

    // Import the appropriate domain sync function
    let syncFn;
    const domainModule = config.domainType === 'debt' || config.domainType === 'realestate'
      ? require('@pendragon/tools-plaid/dist/domains/debt.js')
      : config.domainType === 'investments' || config.domainType === 'retirement'
        ? require('@pendragon/tools-plaid/dist/domains/investments.js')
        : require('@pendragon/tools-plaid/dist/domains/checking.js');

    // The sync function is the capability handler for plaid.syncData
    // We need to call the sync directly. Let's use the plugin's register approach.
    // Actually, let's use a simpler approach - directly call the domain's sync function.
    
    // The simplest approach: use the plaid_sync tool that was registered
    const { tools: registeredTools } = require('../tools/index');
    if (registeredTools.plaid_sync) {
      const result = await registeredTools.plaid_sync.execute({ syncType: 'all' });
      return res.json(result);
    }

    // Fallback: plaid_sync tool not registered (registerFromEnv didn't run)
    return res.status(501).json({ 
      error: 'plaid_sync tool not registered. Workspace may need restart with Plaid connection enabled.',
    });
  } catch (err: any) {
    console.error('[sync] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
