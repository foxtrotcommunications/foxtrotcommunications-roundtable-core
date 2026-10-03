// server/sockets/chat/mcp.ts — Per-turn MCP tool discovery (dedicated only;
// pooled refuses, loudly) and A2A agent config resolution. Bodies moved
// verbatim from chatHandler.ts (Phase 6.2 split).
import type { DataSources, WorkspaceConfig, AppConfig } from '../../types';

const config = require('../../config') as AppConfig;

export async function discoverMcpTools(dataSources: DataSources, wsId: string, tenantManifest: any, workspaceConfig: WorkspaceConfig): Promise<void> {
  if (!config.pooled) {
    // ── MCP Tool Discovery ──────────────────────────────────────
    // Sources: data_sources.mcp_servers (per-workspace settings) OR
    //          RT_MCP_SERVERS env var (injected by SaaS provisioner)
    // DISABLED in pooled mode: registerDynamicTools mutates the process-
    // global tool registry — one tenant's MCP tools would become callable
    // by every other tenant on this replica.
    let mcpServerList: Array<{ name: string; url: string; apiKey?: string }> | null = null;
    if (dataSources && (dataSources as Record<string, unknown>).mcp_servers) {
      const servers = (dataSources as Record<string, unknown>).mcp_servers;
      if (Array.isArray(servers) && servers.length > 0) mcpServerList = servers;
    }
    if (!mcpServerList) {
      const mData = await (require('../../utils/fetchManifest') as { fetchManifest: (wsId?: string) => Promise<any> }).fetchManifest(wsId);
      const parsed = mData.RT_MCP_SERVERS;
      if (Array.isArray(parsed) && parsed.length > 0) mcpServerList = parsed;
    }
    if (mcpServerList) {
      try {
        const { createMcpToolsForWorkspace } = require('../../mcp/client') as {
          createMcpToolsForWorkspace: (servers: Array<{ name: string; url: string; apiKey?: string }>) => Promise<Array<{ name: string; description: string; parameters: Record<string, unknown>; execute: Function }>>;
        };
        const { registerDynamicTools } = require('../../tools/index');
        const mcpTools = await createMcpToolsForWorkspace(mcpServerList);
        if (mcpTools.length > 0) {
          registerDynamicTools(mcpTools);
          console.log(`[MCP] Registered ${mcpTools.length} tools from ${mcpServerList.length} server(s)`);
        }
        workspaceConfig.mcpServers = mcpServerList;
      } catch (err) {
        console.warn('[MCP] Tool discovery failed:', (err as Error).message);
      }
    }
  } else {
    // Loud, greppable signal: a pooled tenant configured MCP servers that
    // this runtime deliberately will not register (cross-tenant leak).
    const mcpConfigured = (Array.isArray((dataSources as Record<string, unknown>)?.mcp_servers) && ((dataSources as Record<string, unknown>).mcp_servers as unknown[]).length > 0)
      || (Array.isArray(tenantManifest?.RT_MCP_SERVERS) && tenantManifest.RT_MCP_SERVERS.length > 0);
    if (mcpConfigured) {
      console.error(`[MCP] POOLED MODE: tenant ${wsId} lists MCP servers, but dynamic MCP tool registration is DISABLED in pooled services (process-global registry would leak tools across tenants). MCP servers ignored for this request.`);
    }
  }
}

export async function resolveA2aAgents(dataSources: DataSources, wsId: string, tenantManifest: any, workspaceConfig: WorkspaceConfig): Promise<void> {
  // ── A2A Agent Config ────────────────────────────────────────
  // Sources: data_sources.a2a_agents OR the tenant manifest
  let a2aAgentList: Array<{ name: string; url: string; apiKey?: string }> | null = null;
  if (dataSources && (dataSources as Record<string, unknown>).a2a_agents) {
    const agents = (dataSources as Record<string, unknown>).a2a_agents;
    if (Array.isArray(agents) && agents.length > 0) a2aAgentList = agents;
  }
  if (!a2aAgentList) {
    const mData = tenantManifest
      || await (require('../../utils/fetchManifest') as { fetchManifest: (wsId?: string) => Promise<any> }).fetchManifest(wsId);
    const parsed = mData.RT_A2A_AGENTS;
    if (Array.isArray(parsed) && parsed.length > 0) a2aAgentList = parsed;
  }
  if (a2aAgentList) {
    workspaceConfig.a2aAgents = a2aAgentList;
  }
}
