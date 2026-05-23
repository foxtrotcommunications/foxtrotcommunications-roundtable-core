// server/tools/index.js — Central tool registry
const webSearch = require('./webSearch');
const urlReader = require('./urlReader');
const calculator = require('./calculator');
const codeRunner = require('./codeRunner');
const gitClone = require('./gitClone');
const gitCommit = require('./gitCommit');
const readFile = require('./readFile');
const writeFile = require('./writeFile');
const listFiles = require('./listFiles');
const findFile = require('./findFile');
const shellExec = require('./shellExec');
const renderChart = require('./renderChart');

// Data warehouse tools (loaded conditionally based on config)
const queryBigQuery = require('./queryBigQuery');
const querySnowflake = require('./querySnowflake');
const queryDatabricks = require('./queryDatabricks');

// Meta-tools — always available regardless of workspace config
const describeWorkspace = require('./describeWorkspace');
const verifyWorkspace = require('./verifyWorkspace');
const bridgeWorkspace = require('./bridgeWorkspace');

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
  // Workspace bridge tool — communicate with other workspaces
  bridge_workspace: bridgeWorkspace,
};

/**
 * Resolve the active tool set. If enabledNames is a non-empty array, only
 * those tools are included. Null/undefined/empty means all tools.
 */
function resolveTools(enabledNames) {
  if (!enabledNames || !Array.isArray(enabledNames) || enabledNames.length === 0) {
    return tools;
  }
  const filtered = {};

  // Always include meta-tools (alwaysEnabled flag)
  for (const [name, tool] of Object.entries(tools)) {
    if (tool.alwaysEnabled) filtered[name] = tool;
  }

  // Include workspace-enabled tools
  for (const name of enabledNames) {
    if (tools[name]) filtered[name] = tools[name];
  }
  return filtered;
}

/**
 * Get all available tool definitions in a provider-agnostic format.
 * Each tool: { name, description, parameters (JSON Schema), execute(args) }
 */
function getAvailableTools() {
  return Object.values(tools).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/**
 * Convert tool definitions to OpenAI format.
 * @param {string[]|null} enabledNames — optional allowlist; null/undefined = all tools
 */
function toOpenAITools(enabledNames) {
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
function toAnthropicTools(enabledNames) {
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
function toGoogleTools(enabledNames) {
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
 * Execute a tool by name
 * @param {string} name
 * @param {object} args — tool arguments from the AI
 * @param {object} [workspaceConfig] — per-workspace config (data_sources, etc.)
 */
async function executeTool(name, args, workspaceConfig = {}) {
  const tool = tools[name];
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.execute(args, workspaceConfig);
}

module.exports = {
  tools,
  resolveTools,
  getAvailableTools,
  toOpenAITools,
  toAnthropicTools,
  toGoogleTools,
  executeTool,
};
