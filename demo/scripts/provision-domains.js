#!/usr/bin/env node
/**
 * Provision new Pendragon demo domain workspaces via the Roundtable API.
 * 
 * Usage: ROUNDTABLE_API_KEY=rtk_... node provision-domains.js
 */

const API_URL = 'https://roundtable.foxtrotcommunications.net';
const API_KEY = process.env.ROUNDTABLE_API_KEY;
const ARTHUR_WS_ID = 'FY6M0lU0katTXza3Yo1r';

if (!API_KEY) {
  console.error('❌ ROUNDTABLE_API_KEY env var required');
  process.exit(1);
}

async function rtFetch(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      ...options.headers,
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${path}: ${body}`);
  }
  return body ? JSON.parse(body) : null;
}

// Domain workspace definitions
const DOMAINS = [
  {
    name: 'Investments',
    template: 'financial-domain',
    provider: 'gemini-enterprise',
    model: 'gemini-3.5-flash',
    contractActions: [
      'delegate', 'discover', 'query:plaid_sync',
      'capability:plaid.getHoldings', 'capability:plaid.getSecurities',
      'capability:plaid.getPortfolioSummary', 'capability:plaid.syncData',
    ],
  },
  {
    name: 'Retirement',
    template: 'financial-domain',
    provider: 'gemini-enterprise',
    model: 'gemini-3.5-flash',
    contractActions: [
      'delegate', 'discover', 'query:plaid_sync',
      'capability:plaid.getHoldings', 'capability:plaid.getSecurities',
      'capability:plaid.getPortfolioSummary', 'capability:plaid.syncData',
    ],
  },
  {
    name: 'Taxes',
    template: 'financial-domain',
    provider: 'gemini-enterprise',
    model: 'gemini-3.5-flash',
    contractActions: [
      'delegate', 'discover', 'query:plaid_sync',
      'capability:plaid.getBalances', 'capability:plaid.getTransactions',
      'capability:plaid.syncData',
    ],
  },
];

async function main() {
  console.log('🏗️  Provisioning Pendragon demo domains via Roundtable API\n');

  // Step 1: List existing workspaces
  console.log('📋 Fetching existing workspaces...');
  const existingWorkspaces = await rtFetch('/api/workspaces');
  console.log(`   Found ${existingWorkspaces.length} existing workspaces:`);
  for (const ws of existingWorkspaces) {
    console.log(`   - ${ws.name} (${ws.id})`);
  }

  const createdIds = [];

  for (const domain of DOMAINS) {
    console.log(`\n── ${domain.name} ──`);

    // Check if already exists
    const existing = existingWorkspaces.find(w => w.name === domain.name);
    if (existing) {
      console.log(`   ⏭️  Already exists (${existing.id}), skipping creation`);
      createdIds.push({ id: existing.id, name: domain.name, actions: domain.contractActions });
      continue;
    }

    // Step 2: Create workspace
    console.log(`   📦 Creating workspace "${domain.name}"...`);
    const ws = await rtFetch('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        name: domain.name,
        template: domain.template,
        provider: domain.provider,
        model: domain.model,
      }),
    });
    console.log(`   ✅ Created: ${ws.id}`);
    createdIds.push({ id: ws.id, name: domain.name, actions: domain.contractActions });

    // Step 3: Start (deploy) the workspace
    console.log(`   🚀 Starting workspace...`);
    try {
      await rtFetch(`/api/workspaces/${ws.id}/start`, { method: 'POST' });
      console.log(`   ✅ Start request sent`);
    } catch (err) {
      console.log(`   ⚠️  Start failed (may need manual deploy): ${err.message}`);
    }
  }

  // Step 4: Create bridges (Arthur ↔ each new domain)
  console.log('\n\n🌉 Creating bridges...');
  const existingBridges = await rtFetch('/api/bridges');
  console.log(`   Found ${existingBridges.length} existing bridges`);

  for (const { id, name } of createdIds) {
    const bridgeExists = existingBridges.some(b =>
      (b.endpointA?.wsId === ARTHUR_WS_ID && b.endpointB?.wsId === id) ||
      (b.endpointA?.wsId === id && b.endpointB?.wsId === ARTHUR_WS_ID)
    );

    if (bridgeExists) {
      console.log(`   ⏭️  Bridge Arthur ↔ ${name} already exists`);
      continue;
    }

    console.log(`   🔗 Creating bridge: Arthur ↔ ${name}...`);
    try {
      const bridge = await rtFetch('/api/bridges', {
        method: 'POST',
        body: JSON.stringify({
          workspaceA: ARTHUR_WS_ID,
          workspaceB: id,
          name: `Arthur ↔ ${name}`,
        }),
      });
      console.log(`   ✅ Bridge created: ${bridge.id}`);
    } catch (err) {
      console.log(`   ⚠️  Bridge failed: ${err.message}`);
    }
  }

  // Step 5: Create governance contracts (Arthur → each new domain)
  console.log('\n\n📜 Creating governance contracts...');
  const existingContracts = await rtFetch('/api/contracts');
  console.log(`   Found ${existingContracts.length} existing contracts`);

  for (const { id, name, actions } of createdIds) {
    const contractExists = existingContracts.some(c =>
      c.source?.wsId === ARTHUR_WS_ID && c.target?.wsId === id
    );

    if (contractExists) {
      console.log(`   ⏭️  Contract Arthur → ${name} already exists`);
      continue;
    }

    console.log(`   📋 Creating contract: Arthur → ${name}...`);
    try {
      const contract = await rtFetch('/api/contracts', {
        method: 'POST',
        body: JSON.stringify({
          name: `Arthur → ${name}: DataQuery`,
          type: 'DataQuery',
          sourceWsId: ARTHUR_WS_ID,
          targetWsId: id,
          allowedActions: actions,
          requires: [],
        }),
      });
      console.log(`   ✅ Contract created: ${contract.id}`);

      // Auto-approve the contract
      console.log(`   🔓 Approving contract...`);
      try {
        await rtFetch(`/api/contracts/${contract.id}/approve`, { method: 'POST' });
        console.log(`   ✅ Contract approved`);
      } catch (approveErr) {
        console.log(`   ⚠️  Auto-approve failed: ${approveErr.message}`);
      }
    } catch (err) {
      console.log(`   ⚠️  Contract failed: ${err.message}`);
    }
  }

  // Summary
  console.log('\n\n═══════════════════════════════════════');
  console.log('✅ Provisioning complete!');
  console.log('═══════════════════════════════════════');
  console.log('\nNew workspaces:');
  for (const { id, name } of createdIds) {
    console.log(`  ${name}: ${id}`);
  }
  console.log('\nNext steps:');
  console.log('  1. Wait for workspace pods to start (~30s each)');
  console.log('  2. Run seed-db.sh to populate domain data');
  console.log('  3. Verify via the Pendragon demo chat');
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
