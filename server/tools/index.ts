// @ts-nocheck
import type { Tool, ToolProfile } from '../types';
// server/tools/index.js — Central tool registry
const config = require('../config');
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
import callAgent from './callAgent';

// Domain financial tools have been moved to the pendragon-tools-plaid plugin.

// ─── Tool Profiles (upgrade plan 0.1) ───────────────────────────────────────
//
// Tools that can execute arbitrary code or mutate the pod's filesystem/repo.
// A finance advisor's workspace never needs them (doctrine §10), so they are
// OFF unless a workspace names one explicitly in enabled_tools. In pooled
// mode they are not registered at all (0.2) — see the registry below.
const DANGEROUS_TOOLS: readonly string[] = Object.freeze([
  'run_code', 'shell_exec', 'write_file', 'git_clone', 'git_commit', 'git_pull',
]);


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

// ─── Pooled hard-exclusion (upgrade plan 0.2) ───────────────────────────────
// One pooled replica serves many tenants on a shared filesystem and a shared
// process. Code execution and file/repo mutation there are not a per-tenant
// opt-in question — they are not offered at all. Removing them from the
// registry (rather than filtering at resolve time) means no enabled_tools
// row, plugin registration, or dynamic MCP discovery can bring them back:
// executeTool sees 'Unknown tool'.
if (config.pooled) {
  for (const name of DANGEROUS_TOOLS) delete tools[name];
}

/** Refuse a registry write under a dangerous name on a pooled service. */
function rejectDangerousInPooled(name: string, source: string): boolean {
  if (config.pooled && DANGEROUS_TOOLS.includes(name)) {
    console.warn(`[tools] Refused to register dangerous tool '${name}' from ${source} on a pooled service`);
    return true;
  }
  return false;
}

// Financial tools are now injected via the Plaid Plugin

// ─── Plaid Plugin (sync + capabilities) ─────────────────────────────
// If @pendragon/tools-plaid is installed and RT_CONNECTIONS has a plaid
// connection, register domain-scoped sync tools + capabilities. The third
// argument hands the plugin core's app hooks so it can register its
// provenance extractor and activity labels (see server/a2a/appHooks.ts);
// older plugin versions ignore the extra argument.
try {
  const { registerFromEnv } = require('@pendragon/tools-plaid');
  const { capabilityRegistry } = require('../protocols/capabilityRegistry');
  const {
    registerActivityDescriptor,
    registerProvenanceExtractor,
    registerSystemPromptSections,
    registerDomainRoutingDescriber,
    registerPreConsultDescriber,
  } = require('../a2a/appHooks');
  registerFromEnv({
    register(name: string, tool: any) {
      if (rejectDangerousInPooled(name, 'plugin')) return;
      tools[name] = tool;
    },
  }, capabilityRegistry, {
    registerActivityDescriptor,
    registerProvenanceExtractor,
    registerSystemPromptSections,
    registerDomainRoutingDescriber,
    registerPreConsultDescriber,
    // Lets the application replace a core-owned tool's description with its
    // own domain language (e.g. emit_provenance's financial examples).
    overrideToolDescription(name: string, description: string) {
      if (tools[name]) tools[name].description = description;
    },
  });
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
// plugin (maintained in the pendragon repo, installed from Artifact Registry —
// see packages/README.md). Auto-detected via workspace name containing
// 'demographics'.

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
    if (rejectDangerousInPooled(tool.name, 'dynamic registration')) continue;
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

/** Thrown by executeTool when the resolved allowlist does not contain the tool. */
class ToolNotEnabled extends Error {
  code = 'TOOL_NOT_ENABLED';
  status = 403;
  tool: string;
  constructor(name: string, profile: ToolProfile) {
    super(`Tool '${name}' is not enabled in this workspace (profile: ${profile})`);
    this.name = 'ToolNotEnabled';
    this.tool = name;
  }
}

/**
 * Enforcement mode for executeTool's allowlist check.
 *   RT_TOOL_PROFILE_ENFORCE=deny  → throw ToolNotEnabled
 *   RT_TOOL_PROFILE_ENFORCE=warn  → log and execute (dedicated default while
 *                                   fleets confirm no workspace relied on the
 *                                   old "NULL = everything" semantics)
 * Pooled services ALWAYS deny: one replica serves many tenants, and a warn
 * there would let one tenant's hallucinated tool call run with another
 * tenant's credentials in scope. Read per call so a flag flip needs no
 * restart in tests and no code change in prod.
 */
function enforcementMode(): 'warn' | 'deny' {
  if (config.pooled) return 'deny';
  const raw = String(process.env.RT_TOOL_PROFILE_ENFORCE || 'warn').toLowerCase();
  return raw === 'deny' ? 'deny' : 'warn';
}

/**
 * Resolve the active tool set.
 *
 *   enabledNames null/undefined/[]  → "default" profile: every registered
 *     tool EXCEPT the dangerous set. This is deliberately NOT "nothing": the
 *     2026-08-14 regression taught us that a NULL row must still expose
 *     intent_bridge and every ordinary tool, or every un-configured
 *     workspace loses cross-workspace consults overnight.
 *   enabledNames non-empty          → exactly those (dangerous ones included
 *     only when named — that is the opt-in), plus alwaysEnabled meta-tools.
 *   Dynamic tools (MCP-sourced) are always included — they have their own
 *     governance — except under the delegated profile.
 *
 *   profile 'delegated' further restricts the result to read-only tools +
 *     intent_bridge (+ meta-tools). It never widens: a tool the workspace did
 *     not enable stays out.
 */
function resolveTools(enabledNames?: string[] | null, profile: ToolProfile = 'default') {
  const allTools = { ...tools, ...dynamicTools };
  const filtered = {};

  if (!enabledNames || !Array.isArray(enabledNames) || enabledNames.length === 0) {
    for (const [name, tool] of Object.entries(allTools)) {
      if (!DANGEROUS_TOOLS.includes(name)) filtered[name] = tool;
    }
  } else {
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
  }

  if (profile === 'delegated') {
    for (const [name, tool] of Object.entries(filtered)) {
      const keep = tool.alwaysEnabled || tool.readOnly === true || name === 'intent_bridge';
      if (!keep) delete filtered[name];
    }
  }

  return filtered;
}

/**
 * Decide whether `name` may execute under the given allowlist/profile.
 * Returns the resolved profile and a boolean; the caller chooses warn/deny.
 */
function isToolEnabled(name: string, enabledNames?: string[] | null, profile: ToolProfile = 'default'): boolean {
  return name in resolveTools(enabledNames, profile);
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
 * Drop registry entries that lack a name — providers hard-reject a tools
 * array containing one (OpenAI 400 "tools[N].function.name"), which took the
 * whole chat down when a module-interop bug registered wrapper objects.
 */
function validToolDefs(enabledNames?: string[] | null, profile: ToolProfile = 'default') {
  const defs = Object.values(resolveTools(enabledNames, profile));
  const valid = defs.filter((t) => t && typeof t.name === 'string' && t.name.length > 0);
  if (valid.length !== defs.length) {
    console.warn(`[tools] Dropped ${defs.length - valid.length} malformed tool definition(s) without a name`);
  }
  return valid;
}

/**
 * Convert tool definitions to OpenAI format.
 * @param {string[]|null} enabledNames — optional allowlist; null/undefined = default profile
 * @param {ToolProfile} [profile] — 'delegated' narrows to read-only + intent_bridge
 */
function toOpenAITools(enabledNames?: string[] | null, profile: ToolProfile = 'default') {
  return validToolDefs(enabledNames, profile).map((t) => ({
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
 * @param {string[]|null} enabledNames — optional allowlist; null/undefined = default profile
 * @param {ToolProfile} [profile] — 'delegated' narrows to read-only + intent_bridge
 */
function toAnthropicTools(enabledNames?: string[] | null, profile: ToolProfile = 'default') {
  return validToolDefs(enabledNames, profile).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/**
 * Convert tool definitions to Google/Gemini format.
 * @param {string[]|null} enabledNames — optional allowlist; null/undefined = default profile
 * @param {ToolProfile} [profile] — 'delegated' narrows to read-only + intent_bridge
 */
/**
 * Vertex rejects the whole request (INVALID_ARGUMENT "...items: missing
 * field") if any array property omits an items schema — a shape tool authors
 * (plugins included) produce routinely and OpenAI/Anthropic accept. Patch in
 * place; the property description still carries the real element contract.
 */
function patchArrayItems(node: any): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(patchArrayItems); return; }
  if (node.type === 'array' && !node.items) {
    node.items = /object|record|entr|row/i.test(node.description || '')
      ? { type: 'object' }
      : { type: 'string' };
  }
  Object.values(node).forEach(patchArrayItems);
}

function toGoogleTools(enabledNames?: string[] | null, profile: ToolProfile = 'default') {
  return [
    {
      functionDeclarations: validToolDefs(enabledNames, profile).map((t) => {
        // Clean parameters for Gemini: strip empty required arrays
        const params = JSON.parse(JSON.stringify(t.parameters));
        if (params.required && params.required.length === 0) {
          delete params.required;
        }
        patchArrayItems(params);
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
 * Execute a tool by name (supports both static and dynamic tools).
 *
 * The allowlist is enforced HERE, at execution, not only at advertisement:
 * a model can name a tool it was never offered, and MCP/ICE/API callers
 * never saw the advertised list at all. Every caller passes the names it
 * resolved for the workspace; a caller that passes nothing gets the default
 * profile (registry minus dangerous), so a forgotten call site fails closed
 * on the dangerous set rather than open.
 *
 * @param {string} name
 * @param {object} args — tool arguments from the AI
 * @param {object} [workspaceConfig] — per-workspace config (data_sources, etc.)
 * @param {object} [options]
 * @param {string[]|null} [options.enabledToolNames] — the workspace's
 *   enabled_tools (null = default profile)
 * @param {ToolProfile} [options.profile] — defaults to
 *   workspaceConfig.toolProfile, then 'default'
 */
async function executeTool(
  name: string,
  args: any,
  workspaceConfig: any = {},
  options: { enabledToolNames?: string[] | null; profile?: ToolProfile } = {},
) {
  const allTools = { ...tools, ...dynamicTools };
  const tool = allTools[name];
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const profile: ToolProfile = options.profile || workspaceConfig?.toolProfile || 'default';
  const enabledNames = options.enabledToolNames === undefined ? null : options.enabledToolNames;
  if (!isToolEnabled(name, enabledNames, profile)) {
    const mode = enforcementMode();
    if (mode === 'deny') {
      console.warn(`[tools] DENIED '${name}' — not in the ${profile} profile for workspace ${workspaceConfig?.workspaceId || config.workspaceId}`);
      throw new ToolNotEnabled(name, profile);
    }
    console.warn(`[tools] WARN-ONLY: '${name}' is not in the ${profile} profile for workspace ${workspaceConfig?.workspaceId || config.workspaceId} — executing anyway (RT_TOOL_PROFILE_ENFORCE=warn)`);
  }

  const context = workspaceConfig._onProgress
    ? { onProgress: workspaceConfig._onProgress }
    : undefined;
  return tool.execute(args, workspaceConfig, context);
}

export { 
  tools,
  DANGEROUS_TOOLS,
  ToolNotEnabled,
  enforcementMode,
  isToolEnabled,
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
