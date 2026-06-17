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

// ─── Domain Financial Tools (conditional on Plaid connection) ────────
// These tools only register on workspaces with a Plaid data connection.
// Arthur (the orchestrator) should NOT have these — it calls them via
// intent_bridge on the domain workspace that has the Plaid data.
try {
  const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
  const hasPlaid = connections.some((c: any) => c.type === 'plaid');
  if (hasPlaid) {
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
  }
} catch { /* RT_CONNECTIONS not set or invalid JSON — skip domain tools */ }

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
