// server/tools/describeWorkspace.js — Meta-tool: AI self-discovery of workspace capabilities
// This tool is ALWAYS available regardless of workspace tool configuration.
// It enables the AI to dynamically discover what tools, data sources, and
// integrations exist in the current workspace at runtime.
//
// Future: This is the integration point for the federation service.
// A2A agents, MCP servers, and workspace bridge availability will be
// reported here as they are registered with the cluster controller.

const config = require('../config');
const fs = require('fs');

module.exports = {
  name: 'describe_workspace',
  description: 'Discover the current workspace environment: what tools are available, what data warehouses are connected, deployment mode, and platform capabilities. Call this FIRST when a user asks what you can do or when you need to understand your environment.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  // Meta flag — tool registry uses this to ensure it's always included
  alwaysEnabled: true,

  async execute(_args, workspaceConfig = {}) {
    const { getAdapter } = require('../db/adapter');
    const { resolveTools } = require('./index');

    // ── Workspace Identity ──────────────────────────────────
    const workspace = await getAdapter().getWorkspace(config.workspaceId);

    // ── Deployment Mode ─────────────────────────────────────
    const isKubernetes = !!process.env.KUBERNETES_SERVICE_HOST;
    const isCloudRun = !!process.env.K_SERVICE;
    const isDocker = !!process.env.DOCKER_CONTAINER || fs.existsSync('/.dockerenv');
    let deployment = 'local';
    if (isKubernetes) deployment = 'gke';
    else if (isCloudRun) deployment = 'cloud-run';
    else if (isDocker) deployment = 'docker';

    // ── Enabled Tools ───────────────────────────────────────
    let enabledToolNames = null;
    if (workspace?.enabled_tools) {
      try {
        const parsed = JSON.parse(workspace.enabled_tools);
        if (Array.isArray(parsed) && parsed.length > 0) enabledToolNames = parsed;
      } catch (_) {}
    }

    const activeTools = resolveTools(enabledToolNames);
    const tools = Object.values(activeTools)
      .filter(t => t.name !== 'describe_workspace') // don't list self
      .map(t => ({
        name: t.name,
        description: t.description,
      }));

    // ── Data Warehouses ─────────────────────────────────────
    const dataWarehouses = [];

    const gcpProject = config.vertexai?.project || process.env.GCP_PROJECT || '';
    if (gcpProject) {
      const bqEntry = { type: 'bigquery', project: gcpProject };
      // Include dataset info if configured
      const dataSources = workspaceConfig.dataSources || {};
      if (dataSources.bigquery?.datasets) {
        bqEntry.datasets = dataSources.bigquery.datasets;
        bqEntry.dataProject = dataSources.bigquery.dataProject || gcpProject;
      }
      dataWarehouses.push(bqEntry);
    }

    if (config.snowflake?.account) {
      dataWarehouses.push({
        type: 'snowflake',
        account: config.snowflake.account,
        warehouse: config.snowflake.warehouse || undefined,
        database: config.snowflake.database || undefined,
      });
    }

    if (config.databricks?.host) {
      dataWarehouses.push({
        type: 'databricks',
        host: config.databricks.host,
        catalog: config.databricks.catalog || undefined,
      });
    }

    // ── AI Configuration ────────────────────────────────────
    const aiConfig = {
      provider: (workspace?.ai_provider) || 'vertexai',
      model: (workspace?.ai_model) || 'gemini-2.5-flash',
    };

    // ── Schema Files ────────────────────────────────────────
    const schemaFiles = [];
    try {
      const uploadsDir = require('path').resolve(__dirname, '..', '..', 'workspace', 'uploads');
      if (fs.existsSync(uploadsDir)) {
        const files = fs.readdirSync(uploadsDir)
          .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        schemaFiles.push(...files);
      }
    } catch (_) {}

    // ── A2A Agents (configured in workspace data_sources or env) ──
    const agents = [];
    if (workspaceConfig.a2aAgents && Array.isArray(workspaceConfig.a2aAgents)) {
      for (const agent of workspaceConfig.a2aAgents) {
        agents.push({ name: agent.name, url: agent.url, status: 'configured' });
      }
    }

    // ── MCP Servers (configured in workspace data_sources or env) ──
    const mcpServers = [];
    if (workspaceConfig.mcpServers && Array.isArray(workspaceConfig.mcpServers)) {
      for (const server of workspaceConfig.mcpServers) {
        mcpServers.push({ name: server.name, url: server.url, status: 'configured' });
      }
    }

    // ── Workspace Bridges (from RT_BRIDGES env) ──────────────────
    const bridges = [];
    try {
      const manifest = process.env.RT_BRIDGES;
      if (manifest) {
        const parsed = JSON.parse(manifest);
        for (const b of parsed) {
          bridges.push({ targetName: b.targetName, targetWsId: b.targetWsId, permissions: b.permissions });
        }
      }
    } catch (_) {}

    // ── Usage Stats (current period) ─────────────────────────
    let usage = null;
    try {
      const db = getAdapter();
      usage = await db.getUsageSummary(config.workspaceId, 30);
    } catch (_) {}

    return {
      platform: 'Roundtable',
      version: '1.0.0',
      organization: config.platformOrg || undefined,

      workspace: {
        id: config.workspaceId,
        name: config.workspaceName,
        deployment,
        environment: process.env.NODE_ENV || 'development',
      },

      ai: aiConfig,

      tools,
      toolCount: tools.length,

      dataWarehouses,
      schemaFiles,

      // Usage stats for the last 30 days
      usage: usage ? {
        periodDays: 30,
        totalRequests: parseInt(usage.total_requests) || 0,
        totalPromptTokens: parseInt(usage.total_prompt_tokens) || 0,
        totalCompletionTokens: parseInt(usage.total_completion_tokens) || 0,
        totalTokens: parseInt(usage.total_tokens) || 0,
        totalToolCalls: parseInt(usage.total_tool_calls) || 0,
      } : null,

      // Future capabilities — empty arrays until implemented
      agents,
      mcpServers,
      bridges,

      capabilities: {
        multiplayer: true,
        streaming: true,
        toolCalling: true,
        usageTracking: true,
        fileSystem: tools.some(t => t.name === 'write_file'),
        shellExecution: tools.some(t => t.name === 'shell_exec'),
        gitOperations: tools.some(t => t.name === 'git_clone'),
        dataWarehouseQuery: dataWarehouses.length > 0,
        webAccess: tools.some(t => t.name === 'web_search'),
        codeExecution: tools.some(t => t.name === 'run_code'),
      },
    };
  },
};
