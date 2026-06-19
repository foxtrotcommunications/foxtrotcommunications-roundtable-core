// @ts-nocheck
import type { Tool } from '../types';
// server/tools/index.js — Central tool registry
import webSearch from './webSearch';
import urlReader from './urlReader';
import calculator from './calculator';
import codeRunner from './codeRunner';
import gitClone from './gitClone';
import gitCommit from './gitCommit';
import gitPull from './gitPull';
import readFile from './readFile';
import writeFile from './writeFile';
import listFiles from './listFiles';
import findFile from './findFile';
import shellExec from './shellExec';
import renderChart from './renderChart';
import emitProvenance from './emitProvenance';

// Data warehouse tools (loaded conditionally based on config)
import queryBigQuery from './queryBigQuery';
import querySnowflake from './querySnowflake';
import queryDatabricks from './queryDatabricks';

import downloadQueryResults from './downloadQueryResults';



// Meta-tools — always available regardless of workspace config
import describeWorkspace from './describeWorkspace';
import verifyWorkspace from './verifyWorkspace';
import bridgeWorkspace from './bridgeWorkspace';
import intentBridge from './intentBridge';

// Protocol integration tools
import callAgent from './callAgent';

// Domain financial tools — direct Cloud SQL queries for checking & savings
import getFinancialSnapshot from './getFinancialSnapshot';
import listAccounts from './listAccounts';
import getBalance from './getBalance';
import getBalanceHistory from './getBalanceHistory';
import getTransactions from './getTransactions';
import getSpendingByCategory from './getSpendingByCategory';
import getSpendingByMerchant from './getSpendingByMerchant';
import getRecurringCharges from './getRecurringCharges';
import getIncomeSummary from './getIncomeSummary';
import getCashflow from './getCashflow';
import getLiabilities from './getLiabilities';
import getDebtSummary from './getDebtSummary';
import getCreditUtilization from './getCreditUtilization';
import getPayoffProjection from './getPayoffProjection';

const tools = {
  // Meta-tools — always available, cannot be disabled
  describe_workspace: describeWorkspace,
  verify_workspace: verifyWorkspace,

  // Standard tools — can be enabled/disabled per workspace
  web_search: webSearch,
  read_url: urlReader,
  calculator: calculator,
  run_code: codeRunner,
  git_clone: gitClone,
  git_commit: gitCommit,
  git_pull: gitPull,
  read_file: readFile,
  write_file: writeFile,
  list_files: listFiles,
  find_file: findFile,
  shell_exec: shellExec,
  render_chart: renderChart,
  emit_provenance: emitProvenance,
  // Data warehouse tools — always registered, return config error if not set up
  query_bigquery: queryBigQuery,
  query_snowflake: querySnowflake,
  query_databricks: queryDatabricks,

  download_query_results: downloadQueryResults,
  // Workspace bridge tools — communicate with other workspaces
  bridge_workspace: bridgeWorkspace,
  intent_bridge: intentBridge,
  // Protocol integration tools
  call_agent: callAgent,
};

// ─── Domain Financial Tools ─────────────────────────────────────────
// Always registered. Each tool uses domainDb which requires DATABASE_URL.
// If no DB is configured, tools return a clear error rather than being invisible.
// The workspace's toolsEnabled array controls which tools the LLM can actually call.
Object.assign(tools, {
  get_financial_snapshot: getFinancialSnapshot,
  list_accounts: listAccounts,
  get_balance: getBalance,
  get_balance_history: getBalanceHistory,
  get_transactions: getTransactions,
  get_spending_by_category: getSpendingByCategory,
  get_spending_by_merchant: getSpendingByMerchant,
  get_recurring_charges: getRecurringCharges,
  get_income_summary: getIncomeSummary,
  get_cashflow: getCashflow,
  get_liabilities: getLiabilities,
  get_debt_summary: getDebtSummary,
  get_credit_utilization: getCreditUtilization,
  get_payoff_projection: getPayoffProjection,
});

// ─── Plaid Plugin (sync + capabilities) ─────────────────────────────
// If @pendragon/tools-plaid is installed and RT_CONNECTIONS has a plaid
// connection, register domain-scoped sync tools + capabilities.
try {
  const { registerFromEnv } = require('@pendragon/tools-plaid');
  const { capabilityRegistry } = require('../protocols/capabilityRegistry');
  registerFromEnv({
    register(name: string, tool: any) {
      tools[name] = tool;
    },
  }, capabilityRegistry);
} catch (err: any) {
  // Package not installed or no plaid connection — skip silently
  if (err.code !== 'MODULE_NOT_FOUND') {
    console.warn('[tools] Plaid plugin error:', err.message);
  }
}

// ─── Real Estate Domain (property capabilities — no Plaid needed) ────
// If this workspace's domain is "realestate", register property capabilities
// directly from Cloud SQL. Does not require Plaid credentials.
try {
  const wsName = (process.env.WS_NAME || '').toLowerCase().replace(/[\s&]+/g, '');
  if (wsName.includes('realestate') || wsName.includes('property')) {
    const { registerRealEstateCapabilities } = require('@pendragon/tools-plaid/dist/domains/realEstate.js');
    const { capabilityRegistry } = require('../protocols/capabilityRegistry');
    registerRealEstateCapabilities(capabilityRegistry, {
      domainType: 'realestate',
      databaseUrl: process.env.DATABASE_URL || '',
      accessToken: '',
      clientId: '',
      secret: '',
      env: 'sandbox',
    });
  }
} catch (err: any) {
  if (err.code !== 'MODULE_NOT_FOUND') {
    console.warn('[tools] Real estate plugin error:', err.message);
  }
}

// ─── Checking/Savings Domain (capabilities from Cloud SQL — no Plaid) ────
// If this workspace is named "checking", "savings", or similar, register
// plaid.getBalances / plaid.getTransactions / plaid.syncData capabilities
// that delegate to the existing domain financial tools (Cloud SQL queries).
try {
  const wsName = (process.env.WS_NAME || '').toLowerCase().replace(/[\s&]+/g, '');
  if (wsName.includes('checking') || wsName.includes('savings')) {
    const { capabilityRegistry } = require('../protocols/capabilityRegistry');
    const { query: domainQuery } = require('./utils/domainDb');

    capabilityRegistry.register({
      name: 'plaid.getBalances',
      description: 'Get current account balances from Cloud SQL',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { accounts: { type: 'array' } } },
      handler: async () => {
        try {
          const rows = await domainQuery('SELECT * FROM plaid_accounts ORDER BY name');
          return { accounts: rows, count: rows.length };
        } catch (e: any) { return { error: e.message, accounts: [] }; }
      },
    });

    capabilityRegistry.register({
      name: 'plaid.getTransactions',
      description: 'Get recent transactions with optional filters',
      inputSchema: {
        type: 'object',
        properties: {
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          limit: { type: 'number', default: 50 },
        },
      },
      outputSchema: { type: 'object', properties: { transactions: { type: 'array' }, count: { type: 'number' } } },
      handler: async (args: any) => {
        try {
          const limit = args?.limit || 50;
          const parts = ['SELECT * FROM plaid_transactions'];
          const params: any[] = [];
          const where: string[] = [];
          if (args?.startDate) { where.push(`date >= $${params.length + 1}`); params.push(args.startDate); }
          if (args?.endDate) { where.push(`date <= $${params.length + 1}`); params.push(args.endDate); }
          if (where.length) parts.push('WHERE ' + where.join(' AND '));
          parts.push('ORDER BY date DESC');
          parts.push(`LIMIT $${params.length + 1}`); params.push(limit);
          const rows = await domainQuery(parts.join(' '), params);
          return { transactions: rows, count: rows.length };
        } catch (e: any) { return { error: e.message, transactions: [] }; }
      },
    });

    capabilityRegistry.register({
      name: 'plaid.syncData',
      description: 'Sync data (no-op for demo — data is pre-seeded)',
      inputSchema: { type: 'object', properties: { syncType: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { success: { type: 'boolean' } } },
      handler: async () => ({ success: true, message: 'Demo data is pre-seeded. No sync needed.' }),
    });

    console.log('[checking] Registered 3 checking/savings capabilities');
  }
} catch (err: any) {
  if (err.code !== 'MODULE_NOT_FOUND') {
    console.warn('[tools] Checking domain plugin error:', err.message);
  }
}

// ─── Debt Domain (capabilities from Cloud SQL — no Plaid) ────────────
// Same pattern for debt/liabilities workspaces.
try {
  const wsName = (process.env.WS_NAME || '').toLowerCase().replace(/[\s&]+/g, '');
  if (wsName.includes('debt')) {
    const { capabilityRegistry } = require('../protocols/capabilityRegistry');
    const { query: domainQuery } = require('./utils/domainDb');

    capabilityRegistry.register({
      name: 'plaid.getLiabilities',
      description: 'Get all liabilities (credit cards, loans) from Cloud SQL',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { liabilities: { type: 'array' } } },
      handler: async () => {
        try {
          const rows = await domainQuery('SELECT * FROM plaid_liabilities ORDER BY name');
          return { liabilities: rows, count: rows.length };
        } catch (e: any) { return { error: e.message, liabilities: [] }; }
      },
    });

    capabilityRegistry.register({
      name: 'plaid.getDebtSummary',
      description: 'Get summary of all debts with total balances and payments',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { debts: { type: 'array' }, totalBalance: { type: 'number' } } },
      handler: async () => {
        try {
          const rows = await domainQuery('SELECT * FROM plaid_liabilities ORDER BY balance_current DESC');
          const total = rows.reduce((s: number, r: any) => s + (parseFloat(r.balance_current) || 0), 0);
          return { debts: rows, totalBalance: total, count: rows.length };
        } catch (e: any) { return { error: e.message, debts: [], totalBalance: 0 }; }
      },
    });

    capabilityRegistry.register({
      name: 'plaid.getCreditUtilization',
      description: 'Calculate credit utilization ratio across all credit accounts',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { utilization: { type: 'number' } } },
      handler: async () => {
        try {
          const rows = await domainQuery("SELECT * FROM plaid_liabilities WHERE type = 'credit'");
          const totalBalance = rows.reduce((s: number, r: any) => s + (parseFloat(r.balance_current) || 0), 0);
          const totalLimit = rows.reduce((s: number, r: any) => s + (parseFloat(r.credit_limit) || 0), 0);
          const utilization = totalLimit > 0 ? Math.round((totalBalance / totalLimit) * 10000) / 100 : 0;
          return { utilization, totalBalance, totalLimit, accounts: rows };
        } catch (e: any) { return { error: e.message, utilization: 0 }; }
      },
    });

    capabilityRegistry.register({
      name: 'plaid.getBalances',
      description: 'Get balances for debt accounts',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { accounts: { type: 'array' } } },
      handler: async () => {
        try {
          const rows = await domainQuery('SELECT * FROM plaid_accounts ORDER BY name');
          return { accounts: rows, count: rows.length };
        } catch (e: any) { return { error: e.message, accounts: [] }; }
      },
    });

    capabilityRegistry.register({
      name: 'plaid.getTransactions',
      description: 'Get debt-related transactions',
      inputSchema: { type: 'object', properties: { limit: { type: 'number', default: 50 } } },
      outputSchema: { type: 'object', properties: { transactions: { type: 'array' } } },
      handler: async (args: any) => {
        try {
          const limit = args?.limit || 50;
          const rows = await domainQuery('SELECT * FROM plaid_transactions ORDER BY date DESC LIMIT $1', [limit]);
          return { transactions: rows, count: rows.length };
        } catch (e: any) { return { error: e.message, transactions: [] }; }
      },
    });

    capabilityRegistry.register({
      name: 'plaid.getDebtTransactions',
      description: 'Get transactions specific to debt payments',
      inputSchema: { type: 'object', properties: { limit: { type: 'number', default: 50 } } },
      outputSchema: { type: 'object', properties: { transactions: { type: 'array' } } },
      handler: async (args: any) => {
        try {
          const limit = args?.limit || 50;
          const rows = await domainQuery(
            "SELECT * FROM plaid_transactions WHERE category ILIKE '%payment%' OR category ILIKE '%credit%' ORDER BY date DESC LIMIT $1",
            [limit]
          );
          return { transactions: rows, count: rows.length };
        } catch (e: any) { return { error: e.message, transactions: [] }; }
      },
    });

    capabilityRegistry.register({
      name: 'plaid.syncData',
      description: 'Sync data (no-op for demo — data is pre-seeded)',
      inputSchema: { type: 'object', properties: { syncType: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { success: { type: 'boolean' } } },
      handler: async () => ({ success: true, message: 'Demo data is pre-seeded. No sync needed.' }),
    });

    console.log('[debt] Registered 7 debt management capabilities');
  }
} catch (err: any) {
  if (err.code !== 'MODULE_NOT_FOUND') {
    console.warn('[tools] Debt domain plugin error:', err.message);
  }
}

// ─── Dynamic Tool Registry (MCP servers inject tools here) ─────────
// Dynamic tools are stored separately and merged at resolve-time.
// Key: tool name (e.g. 'mcp_myserver_search'), Value: Tool object
const dynamicTools: Record<string, Tool> = {};

/**
 * Register dynamically discovered tools (e.g. from MCP servers).
 * @param {object[]} toolsArray — array of Tool objects with name, description, parameters, execute
 */
function registerDynamicTools(toolsArray: Tool[]) {
  for (const tool of toolsArray) {
    dynamicTools[tool.name] = tool;
  }
}

/**
 * Clear dynamic tools by prefix (e.g. 'mcp_myserver_' when a server disconnects).
 * @param {string} prefix
 */
function clearDynamicTools(prefix: string) {
  for (const name of Object.keys(dynamicTools)) {
    if (name.startsWith(prefix)) {
      delete dynamicTools[name];
    }
  }
}

/**
 * Get all dynamic tools.
 */
function getDynamicTools() {
  return { ...dynamicTools };
}

/**
 * Resolve the active tool set. If enabledNames is a non-empty array, only
 * those tools are included. Null/undefined/empty means all tools.
 * Dynamic tools (from MCP servers) are always included.
 */
function resolveTools(enabledNames?: string[] | null) {
  const allTools = { ...tools, ...dynamicTools };

  if (!enabledNames || !Array.isArray(enabledNames) || enabledNames.length === 0) {
    return allTools;
  }
  const filtered = {};

  // Always include meta-tools (alwaysEnabled flag)
  for (const [name, tool] of Object.entries(allTools)) {
    if (tool.alwaysEnabled) filtered[name] = tool;
  }

  // Include workspace-enabled tools
  for (const name of enabledNames) {
    if (allTools[name]) filtered[name] = allTools[name];
  }

  // Always include dynamic tools (MCP-sourced) — they have their own governance
  for (const [name, tool] of Object.entries(dynamicTools)) {
    filtered[name] = tool;
  }

  return filtered;
}

/**
 * Get all available tool definitions in a provider-agnostic format.
 * Each tool: { name, description, parameters (JSON Schema), execute(args) }
 */
function getAvailableTools() {
  const allTools = { ...tools, ...dynamicTools };
  return Object.values(allTools).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/**
 * Convert tool definitions to OpenAI format.
 * @param {string[]|null} enabledNames — optional allowlist; null/undefined = all tools
 */
function toOpenAITools(enabledNames?: string[] | null) {
  return Object.values(resolveTools(enabledNames)).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Convert tool definitions to Anthropic format.
 * @param {string[]|null} enabledNames — optional allowlist; null/undefined = all tools
 */
function toAnthropicTools(enabledNames?: string[] | null) {
  return Object.values(resolveTools(enabledNames)).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/**
 * Convert tool definitions to Google/Gemini format.
 * @param {string[]|null} enabledNames — optional allowlist; null/undefined = all tools
 */
function toGoogleTools(enabledNames?: string[] | null) {
  return [
    {
      functionDeclarations: Object.values(resolveTools(enabledNames)).map((t) => {
        // Clean parameters for Gemini: strip empty required arrays
        const params = JSON.parse(JSON.stringify(t.parameters));
        if (params.required && params.required.length === 0) {
          delete params.required;
        }
        return {
          name: t.name,
          description: t.description,
          parameters: params,
        };
      }),
    },
  ];
}

/**
 * Execute a tool by name (supports both static and dynamic tools)
 * @param {string} name
 * @param {object} args — tool arguments from the AI
 * @param {object} [workspaceConfig] — per-workspace config (data_sources, etc.)
 */
async function executeTool(name: string, args: any, workspaceConfig: any = {}) {
  const allTools = { ...tools, ...dynamicTools };
  const tool = allTools[name];
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.execute(args, workspaceConfig);
}

export { 
  tools,
  resolveTools,
  getAvailableTools,
  toOpenAITools,
  toAnthropicTools,
  toGoogleTools,
  executeTool,
  registerDynamicTools,
  clearDynamicTools,
  getDynamicTools,
 };
