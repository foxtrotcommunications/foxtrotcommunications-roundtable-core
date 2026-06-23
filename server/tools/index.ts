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

// Domain financial tools have been moved to the pendragon-tools-plaid plugin.

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

// Financial tools are now injected via the Plaid Plugin

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

// Domain logic (Real Estate, Checking/Savings, Debt) has been removed from core
// and is now managed entirely by the Plaid plugin.

// ─── Demographics Domain Tools ──────────────────────────────────────
// Demographics tools (get_user_profile, get_household, get_financial_goals,
// get_investment_preferences) are now registered via the @pendragon/tools-plaid
// plugin in packages/pendragon-tools-plaid/src/domains/demographics.ts.
// Auto-detected via workspace name containing 'demographics'.

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
