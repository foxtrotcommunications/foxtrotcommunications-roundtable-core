// @ts-nocheck
// server/tools/describeWorkspace.js — Meta-tool: AI self-discovery of workspace capabilities
// This tool is ALWAYS available regardless of workspace tool configuration.
// It enables the AI to dynamically discover what tools, data sources, and
// integrations exist in the current workspace at runtime.
//
// Future: This is the integration point for the federation service.
// A2A agents, MCP servers, and workspace bridge availability will be
// reported here as they are registered with the cluster controller.

const config = require('../config');
import fs from 'fs';
import {  fetchManifest  } from '../utils/fetchManifest';

import type { Tool } from '../types';
// @ts-ignore


const tool: Tool = {
  name: 'describe_workspace',
  description: 'Discover the current workspace environment: what tools are available, what data warehouses are connected, deployment mode, and platform capabilities. Call this FIRST when a user asks what you can do or when you need to understand your environment.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  // Meta flag — tool registry uses this to ensure it's always included
  alwaysEnabled: true,

  async execute(_args: any, workspaceConfig: any = {}, _context?: any) {
    const { getAdapter   } = require('../db/adapter');
    const { resolveTools   } = require('./index');

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
      } catch { /* intentionally empty */ }
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
      const path = require('path');
      const uploadsDir = path.resolve(__dirname, '..', '..', 'workspace', 'uploads');
      if (fs.existsSync(uploadsDir)) {
        const files = fs.readdirSync(uploadsDir)
          .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        schemaFiles.push(...files);
      }
    } catch { /* intentionally empty */ }

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

    // ── Fetch Dynamic Manifest ───────────────────────────────
    const manifest = await fetchManifest();

    // ── Workspace Bridges (from dynamic manifest) ──────────────────
    const bridges = [];
    try {
      if (manifest.RT_BRIDGES && Array.isArray(manifest.RT_BRIDGES)) {
        for (const b of manifest.RT_BRIDGES) {
          const permList = (b.permissions || []).join(', ');
          bridges.push({
            targetName: b.targetName,
            targetWsId: b.targetWsId,
            permissions: b.permissions,
            summary: `${(b.permissions || []).includes('delegate') ? 'Full' : 'Message-only'} bridge to ${b.targetName}. Permitted actions: ${permList}.`,
          });
        }
      }
    } catch { /* intentionally empty */ }

    // ── Governance Contracts (from dynamic manifest) ─────────
    const contracts = [];
    try {
      if (manifest.RT_CONTRACTS && Array.isArray(manifest.RT_CONTRACTS)) {
        for (const c of manifest.RT_CONTRACTS) {
          const counterpartyName = c.counterparty?.name || 'Unknown';
          const actionList = (c.allowedActions || []).join(', ');
          const dirLabel = c.direction === 'outbound'
            ? `You → ${counterpartyName}`
            : `${counterpartyName} → You`;

          // Extract tool_call actions to highlight them
          const toolActions = (c.allowedActions || [])
            .filter((a: string) => a.startsWith('tool:'))
            .map((a: string) => a.replace('tool:', ''));

          const discoverHint = c.direction === 'outbound' && toolActions.length > 0
            ? ` To see all available tools, call intent_bridge({ target: '${counterpartyName}', op: 'discover', scope: 'tools' }). Prefer op:'tool_call' over op:'capability' for better performance.`
            : '';

          contracts.push({
            contractId: c.contractId,
            type: c.type,
            direction: c.direction,  // 'inbound' or 'outbound'
            counterparty: counterpartyName,
            counterpartyWsId: c.counterparty?.wsId,
            allowedActions: c.allowedActions || [],
            availableTools: toolActions.length > 0 ? toolActions : undefined,
            escalationTarget: c.escalationTarget || null,
            summary: `${c.type} contract (${dirLabel}). Allowed actions: [${actionList}].${discoverHint}`,
          });
        }
      }
    } catch { /* intentionally empty */ }

    // ── Usage Stats (current period) ─────────────────────────
    let usage = null;
    try {
      const db = getAdapter();
      usage = await db.getUsageSummary(config.workspaceId, 30);
    } catch { /* intentionally empty */ }

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
      contracts,
      contractCount: contracts.length,

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
        governanceContracts: contracts.length > 0,
        intentCompilation: tools.some(t => t.name === 'intent_bridge'),
      },

      // Intent Compilation Engine stats (if available)
      ...(tools.some(t => t.name === 'intent_bridge') ? (() => {
        try {
          const { intentMetrics } = require('../protocols/intentMetrics');
          const { intentCache } = require('../protocols/intentCache');
          return {
            ice: {
              metrics: intentMetrics.getStats(),
              cache: intentCache.stats(),
            },
          };
        } catch { return {}; }
      })() : {}),
    };
  },
};

export default tool;
