// server/sockets/chatHandler.ts — Message handling + AI streaming with tools (workspace-based)
import type { Server } from 'socket.io';
import type {
  RoundtableSocket,
  StreamEvent,
  Workspace,
  Message,
  WorkspaceConfig,
  DataSources,
  DatabaseAdapter,
  AppConfig,
} from '../types';

const workspaceService = require('../services/workspaceService') as {
  workspaceId: string;
  ensureWorkspace(): Promise<import('../types').Workspace>;
  getWorkspace(): Promise<import('../types').Workspace | null>;
  saveMessage(userId: number | null, role: string, content: string, toolName?: string | null, toolCallId?: string | null, sourceWorkspaceId?: string | null, guestUsername?: string | null, guestDisplayName?: string | null): Promise<import('../types').Message>;
  getConversationHistory(limit: number): Promise<import('../types').Message[]>;
  getMessages(options?: { limit?: number; before?: number }): Promise<{ messages: import('../types').Message[]; hasMore: boolean }>;
  getUserApiKey(userId: number, provider: string): Promise<string>;
  getUserById(userId: number): Promise<import('../types').User | null>;
};
const { streamCompletion } = require('../services/aiProvider') as {
  streamCompletion: (provider: string, model: string, messages: Record<string, unknown>[], apiKey: string, enableTools?: boolean, signal?: AbortSignal | null, enabledToolNames?: string[] | null, workspaceConfig?: WorkspaceConfig) => AsyncGenerator<StreamEvent>;
};
const config = require('../config') as AppConfig;
const { startSpan, endSpan, generateTraceId, preview } = require('../tracing') as typeof import('../tracing');
const { recordSpan } = require('../tracing/collector') as typeof import('../tracing/collector');

// ─── Workspace-level AI request queue ─────────────────────────────────
// Only one AI request runs at a time per workspace to prevent
// interleaved streaming. Additional requests are queued.
interface QueuedRequest {
  socket: RoundtableSocket;
  content: string;
  activeRepo?: string;
  isOverage: boolean;
}
const workspaceQueues = new Map<string, QueuedRequest[]>();
const workspaceProcessing = new Map<string, boolean>();

function getQueue(wsId: string): QueuedRequest[] {
  if (!workspaceQueues.has(wsId)) workspaceQueues.set(wsId, []);
  return workspaceQueues.get(wsId)!;
}

function isProcessing(wsId: string): boolean {
  return workspaceProcessing.get(wsId) || false;
}

interface BridgeEntry {
  targetName: string;
  targetUrl?: string;
  [key: string]: unknown;
}

interface BridgeToolResult {
  error?: string;
  taskId?: string;
  [key: string]: unknown;
}

// ─── Human-friendly step descriptions for tool calls ──────────────────
/** Human-friendly descriptions for tool calls — uses financial advisor language */
function describeActivity(toolName: string, args: Record<string, unknown>): { step: string; label: string } {
  // Bridge/intent tools — use the target workspace name
  if (toolName === 'intent_bridge') {
    const target = (args.targetWorkspace || args.target || 'workspace') as string;
    return { step: target, label: describeWorkspace(target) };
  }
  if (toolName === 'bridge_workspace') {
    const target = (args.target || 'workspace') as string;
    return { step: target, label: describeWorkspace(target) };
  }
  // Domain tools
  const descriptions: Record<string, { step: string; label: string }> = {
    describe_workspace: { step: 'planning', label: 'Planning analysis' },
    get_user_profile: { step: 'demographics', label: 'Reviewing your profile' },
    get_household: { step: 'demographics', label: 'Reviewing household details' },
    get_investment_preferences: { step: 'demographics', label: 'Reviewing investment preferences' },
    list_accounts: { step: 'accounts', label: 'Listing accounts' },
    get_balance: { step: 'balances', label: 'Checking balances' },
    get_transactions: { step: 'transactions', label: 'Reviewing transactions' },
    get_financial_snapshot: { step: 'snapshot', label: 'Building financial snapshot' },
    get_debt_summary: { step: 'debt', label: 'Evaluating debt obligations' },
    get_credit_utilization: { step: 'credit', label: 'Checking credit utilization' },
    get_cashflow: { step: 'cashflow', label: 'Checking cash flow' },
    get_income_summary: { step: 'income', label: 'Analyzing income' },
    get_spending_by_category: { step: 'spending', label: 'Analyzing spending patterns' },
    get_spending_by_merchant: { step: 'spending', label: 'Reviewing merchant spending' },
    get_recurring_charges: { step: 'recurring', label: 'Identifying recurring charges' },
    get_balance_history: { step: 'history', label: 'Reviewing balance history' },
    get_payoff_projection: { step: 'payoff', label: 'Projecting payoff timeline' },
    get_liabilities: { step: 'liabilities', label: 'Reviewing liabilities' },
    render_chart: { step: 'chart', label: 'Generating chart' },
    discover: { step: 'discover', label: 'Discovering available data' },
    calculator: { step: 'calculating', label: 'Running calculations' },
    emit_provenance: { step: 'provenance', label: 'Verifying sources' },
    query_bigquery: { step: 'querying', label: 'Querying data warehouse' },
    query_snowflake: { step: 'querying', label: 'Querying data warehouse' },
    query_databricks: { step: 'querying', label: 'Querying data warehouse' },
    call_agent: { step: 'consulting', label: 'Consulting specialist' },
    run_code: { step: 'computing', label: 'Running analysis' },
    read_file: { step: 'reading', label: 'Reading documents' },
    read_url: { step: 'researching', label: 'Researching online' },
  };
  if (descriptions[toolName]) return descriptions[toolName];
  // Fallback: humanize the tool name
  const humanized = toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return { step: toolName, label: humanized };
}

function describeWorkspace(name: string): string {
  const wsDescriptions: Record<string, string> = {
    'Retirement': 'Analyzing retirement accounts',
    'Investments': 'Reviewing investments',
    'Checking & Savings': 'Checking cash flow',
    'Debt Management': 'Evaluating debt obligations',
    'Real Estate': 'Reviewing real estate holdings',
    'Taxes': 'Considering tax implications',
    'Demographics': 'Reviewing your profile',
  };
  return wsDescriptions[name] || `Consulting ${name}`;
}

// ─── Per-socket rate limiting ─────────────────────────────────────────
const RATE_LIMIT_WINDOW: number = 60_000; // 1 minute
const RATE_LIMIT_MAX: number = parseInt(process.env.AI_RATE_LIMIT || '5', 10);

function setupChatHandlers(io: Server, socket: RoundtableSocket): void {
  const wsChannel: string = `ws:${config.workspaceId}`;
  const aiMessageTimestamps: number[] = []; // per-socket rate tracker

  // Derive workspace alias(es) for @-mention triggering
  // e.g., "ICU — Critical Care" → "icu", "Pharmacy" → "pharmacy"
  const wsAlias: string = (config.workspaceName || '').split(/[\s—–-]/)[0].trim().toLowerCase();
  const wsId: string = config.workspaceId.toLowerCase();
  const aliasParts: string[] = [wsAlias, wsId]
    .filter(a => a.length >= 2 && a !== 'roundtable')
    .map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const aiTriggerPattern: RegExp = new RegExp(
    `@(?:ai${aliasParts.map(a => '|' + a).join('')})\\b`, 'i'
  );

const { touchActivity } = require('./workspaceHandler') as { touchActivity: () => void };

  socket.on('send-message', async ({ content, activeRepo, _fromQueue }: { content: string; activeRepo?: string; _fromQueue?: boolean }) => {
    // Mark activity on every user message so the dashboard idle checker
    // knows this workspace is actively in use (not just a stale tab)
    touchActivity();
    try {
      // ── Input validation: reject oversized messages ──────────────
      const MAX_MESSAGE_LENGTH = 50_000; // 50KB — generous for any chat message
      if (!content || typeof content !== 'string') {
        socket.emit('error-message', { error: 'Message content is required' });
        return;
      }
      if (content.length > MAX_MESSAGE_LENGTH) {
        socket.emit('error-message', { error: `Message too long (${content.length.toLocaleString()} chars). Maximum is ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.` });
        return;
      }

      // ── Distributed tracing: root span for this chat message ──
      const traceId = generateTraceId();
      const rootSpan = startSpan({
        traceId,
        workspaceId: config.workspaceId || '',
        workspaceName: config.workspaceName || '',
        operation: 'chat.message',
        inputPreview: preview(content),
      });

      // Save and broadcast every message (skip for queued re-processing)
      if (!_fromQueue) {
        // For embed guests (null userId), persist socket username as guest fields
        const guestName = !socket.userId && socket.username ? socket.username : null;
        const userMessage: Message = await workspaceService.saveMessage(
          socket.userId, 'user', content, null, null, null, guestName, guestName
        );
        io.to(wsChannel).emit('new-message', userMessage);
      }

      // Also detect @ai-{workspace} for bridge delegation
      const mentionsAI: boolean = aiTriggerPattern.test(content);
      const bridgeMention: RegExpMatchArray | null = content.match(/@ai-([\w-]+)/i);
      if (!mentionsAI && !bridgeMention) return;

      // ── Rate limiting for AI-triggering messages ──────────────────
      const now: number = Date.now();
      while (aiMessageTimestamps.length > 0 && now - aiMessageTimestamps[0] > RATE_LIMIT_WINDOW) {
        aiMessageTimestamps.shift();
      }
      if (aiMessageTimestamps.length >= RATE_LIMIT_MAX) {
        socket.emit('error-message', { error: `Rate limit: max ${RATE_LIMIT_MAX} AI messages per minute. Please wait a moment.` });
        return;
      }
      aiMessageTimestamps.push(now);

      // ── Bridge delegation via @ai-{workspace} ─────────────────
      if (bridgeMention) {
        const targetName: string = bridgeMention[1];
        // Strip the @ai-workspace from the content to get the actual message
        const bridgeContent: string = content.replace(/@ai-[\w-]+\s*/i, '').trim();

        if (!bridgeContent) {
          socket.emit('error-message', { error: `What would you like to ask ${targetName}? e.g. @ai-${targetName} review this query` });
          return;
        }

        // Check if a bridge exists for this workspace
        const manifestData = await (require('../utils/fetchManifest') as { fetchManifest: () => Promise<any> }).fetchManifest();
        const bridges: BridgeEntry[] = manifestData.RT_BRIDGES || [];
        if (!bridges.length) {
          socket.emit('error-message', { error: `No bridges configured. Cannot reach "${targetName}".` });
          return;
        }

        // Slugify helper: "Executive — C-Suite" → "executive-c-suite"
        const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const targetSlug: string = slugify(targetName);

        const bridge: BridgeEntry | undefined = bridges.find(
          (b: BridgeEntry) => slugify(b.targetName) === targetSlug
        );

        if (!bridge) {
          // Fuzzy match — suggest close names
          const suggestions: string[] = bridges
            .filter((b: BridgeEntry) => {
              const t: string = slugify(b.targetName);
              return t.startsWith(targetSlug) || targetSlug.startsWith(t) || t.includes(targetSlug) || targetSlug.includes(t);
            })
            .map((b: BridgeEntry) => `@ai-${slugify(b.targetName)}`);

          if (suggestions.length > 0) {
            socket.emit('error-message', {
              error: `No bridge to "${targetName}". Did you mean ${suggestions.join(' or ')}?`,
            });
          } else {
            const available: string = bridges.map((b: BridgeEntry) => `@ai-${slugify(b.targetName)}`).join(', ');
            socket.emit('error-message', {
              error: `No bridge to "${targetName}". Available: ${available || 'none'}`,
            });
          }
          return;
        }

        // Guard against double-submission
        if (socket.isGenerating) {
          socket.emit('error-message', { error: 'A request is still processing.' });
          return;
        }

        socket.isGenerating = true;

        // Determine action from contracts (not bridge.permissions — bridges are connectivity only)
        let contractManifest: any[];
        contractManifest = manifestData.RT_CONTRACTS || [];
        const outboundContract = contractManifest.find(
          (c: any) => c.direction === 'outbound' && c.counterparty?.wsId === bridge.targetWsId && c.status === 'active'
        );

        if (!outboundContract) {
          socket.isGenerating = false;
          socket.emit('error-message', {
            error: `No active governance contract with "${bridge.targetName}". A contract must be approved before any cross-workspace activity.`,
          });
          return;
        }

        const allowedActions: string[] = outboundContract.allowedActions || [];
        const bridgeAction: string = allowedActions.includes('delegate') ? 'delegate' : allowedActions.includes('message') ? 'message' : allowedActions[0] || 'message';

        io.to(wsChannel).emit('ai-start', { userId: socket.userId, username: socket.username });
        io.to(wsChannel).emit('tool-call', {
          name: 'bridge_workspace',
          args: { target: bridge.targetName, action: bridgeAction, content: bridgeContent },
          callId: `bridge-${Date.now()}`,
        });

        try {
          const bridgeMod = require('../tools/bridgeWorkspace');
          const bridgeTool = (bridgeMod.default || bridgeMod) as {
            execute: (args: Record<string, unknown>) => Promise<BridgeToolResult>;
          };
          const result: BridgeToolResult = await bridgeTool.execute({
            target: bridge.targetName,
            action: bridgeAction,
            content: bridgeContent,
          });

          const callId: string = `bridge-${Date.now()}`;
          io.to(wsChannel).emit('tool-result', {
            name: 'bridge_workspace',
            callId,
            result,
          });

          const responseText: string = result.error
            ? `❌ Bridge to ${bridge.targetName} failed: ${result.error}`
            : `🔗 Task delegated to **${bridge.targetName}**. Task ID: \`${result.taskId}\`\n\nThe ${bridge.targetName} workspace's AI is processing your request. Results will appear here when complete.`;

          await workspaceService.saveMessage(null, 'assistant', responseText);
          io.to(wsChannel).emit('ai-chunk', { content: responseText, userId: socket.userId });
          io.to(wsChannel).emit('ai-complete', { fullText: responseText, userId: socket.userId });
        } catch (err: unknown) {
          const error = err as Error;
          io.to(wsChannel).emit('ai-error', { error: `Bridge delegation failed: ${error.message}` });
        } finally {
          socket.isGenerating = false;
          socket.abortController = null;
        }
        return;
      }

      // Per-socket guard — only one active request per user (in queue or processing)
      if (socket.isGenerating) {
        socket.emit('error-message', { error: 'Your AI request is still processing. Please wait or stop it first.' });
        return;
      }

      // ── Workspace-level queue: only one AI request at a time ──
      if (isProcessing(config.workspaceId)) {
        const queue = getQueue(config.workspaceId);
        queue.push({ socket, content, activeRepo, isOverage: false });
        socket.isGenerating = true; // prevent double-queuing from same user
        const position = queue.length;
        socket.emit('ai-queued', { position, message: `Your request is queued (position ${position}). The AI will respond when the current request finishes.` });
        io.to(wsChannel).emit('ai-queue-update', { queueLength: position });
        console.log(`[Queue] Request from ${socket.username} queued at position ${position} for workspace ${config.workspaceId}`);
        return;
      }

      // ── Monthly token credit pool ──────────────────────────────────────
      // Each workspace gets a monthly token credit (default 1M tokens).
      // TOKEN_CAP_MODE controls behavior when credits are exhausted:
      //   'hard' — block the request (free tier / beta)
      //   'soft' — warn but allow (paid tier with Stripe metered billing)
      const MONTHLY_TOKEN_CREDIT: number = parseInt(process.env.MONTHLY_TOKEN_CREDIT || '1000000', 10);
      const TOKEN_CAP_MODE: string = process.env.TOKEN_CAP_MODE || 'hard';
      let isOverage: boolean = false;
      if (MONTHLY_TOKEN_CREDIT > 0) {
        try {
          const { getAdapter } = require('../db/adapter') as { getAdapter: () => DatabaseAdapter };
          const monthlyTokens: number = await getAdapter().getMonthlyTokens(config.workspaceId);
          if (monthlyTokens >= MONTHLY_TOKEN_CREDIT) {
            isOverage = true;
            const pct: number = Math.round((monthlyTokens / MONTHLY_TOKEN_CREDIT) * 100);
            console.log(`[Credits] Workspace ${config.workspaceId} is over monthly credit: ${monthlyTokens.toLocaleString()} / ${MONTHLY_TOKEN_CREDIT.toLocaleString()} (${pct}%)`);

            if (TOKEN_CAP_MODE === 'hard') {
              // HARD CAP — block the request (free tier / beta)
              socket.emit('error-message', {
                error: `Monthly token limit reached (${monthlyTokens.toLocaleString()} / ${MONTHLY_TOKEN_CREDIT.toLocaleString()} tokens). Your free trial includes ${MONTHLY_TOKEN_CREDIT.toLocaleString()} tokens per month. Contact support to upgrade.`,
              });
              return;
            }

            // SOFT CAP — notify the user but allow (paid tier, overages auto-charged)
            socket.emit('credit-warning', {
              message: `Monthly AI credit pool used (${monthlyTokens.toLocaleString()} / ${MONTHLY_TOKEN_CREDIT.toLocaleString()} tokens — ${pct}%). Additional usage is billed automatically.`,
              monthlyTokens,
              monthlyCredit: MONTHLY_TOKEN_CREDIT,
              percentage: pct,
            });
          }
        } catch (capErr: unknown) {
          const capError = capErr as Error;
          console.warn('[Credits] Could not check usage — allowing request:', capError.message);
        }
      }


      const workspace: Workspace | null = await workspaceService.getWorkspace();

      // AI provider config from workspace or defaults
      const aiProvider: string = (workspace && workspace.ai_provider) || 'vertexai';
      const aiModel: string = (workspace && workspace.ai_model) || 'gemini-2.5-flash';
      const toolsEnabled: boolean = workspace ? (workspace.tools_enabled ?? true) : true;

      // Enforce provider restriction if set
      if (workspace?.allowed_providers) {
        try {
          const allowed: unknown = JSON.parse(workspace.allowed_providers);
          if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(aiProvider)) {
            io.to(wsChannel).emit('ai-error', {
              error: `Provider "${aiProvider}" is not allowed for this workspace. Allowed: ${(allowed as string[]).join(', ')}. Change in Settings.`
            });
            return;
          }
        } catch { /* intentionally empty */ }
      }

      // Audit: AI request
      { const { getAdapter: _ga } = require('../db/adapter') as { getAdapter: () => DatabaseAdapter };
        _ga().audit(config.workspaceId, socket.userId, socket.username, 'ai_request', aiProvider, {
          model: aiModel, contentLength: content.length,
        }, socket.handshake?.address).catch(() => {}); }

      // Parse per-workspace data source config
      let dataSources: DataSources = {};
      if (workspace?.data_sources) {
        try {
          dataSources = typeof workspace.data_sources === 'string'
            ? JSON.parse(workspace.data_sources)
            : workspace.data_sources;
        } catch { /* intentionally empty */ }
      }
      const workspaceConfig: WorkspaceConfig = { dataSources, workspaceId: config.workspaceId, workspaceName: config.workspaceName };

      // Resolve enabled tool names from workspace config (null = all tools)
      let enabledToolNames: string[] | null = null;
      if (workspace && workspace.enabled_tools) {
        try {
          const parsed: unknown = JSON.parse(workspace.enabled_tools);
          if (Array.isArray(parsed) && parsed.length > 0) enabledToolNames = parsed as string[];
        } catch { /* intentionally empty */ }
      }

      // ── MCP Tool Discovery ──────────────────────────────────────
      // Sources: data_sources.mcp_servers (per-workspace settings) OR
      //          RT_MCP_SERVERS env var (injected by SaaS provisioner)
      let mcpServerList: Array<{ name: string; url: string; apiKey?: string }> | null = null;
      if (dataSources && (dataSources as Record<string, unknown>).mcp_servers) {
        const servers = (dataSources as Record<string, unknown>).mcp_servers;
        if (Array.isArray(servers) && servers.length > 0) mcpServerList = servers;
      }
      if (!mcpServerList) {
        const mData = await (require('../utils/fetchManifest') as { fetchManifest: () => Promise<any> }).fetchManifest();
        const parsed = mData.RT_MCP_SERVERS;
        if (Array.isArray(parsed) && parsed.length > 0) mcpServerList = parsed;
      }
      if (mcpServerList) {
        try {
          const { createMcpToolsForWorkspace } = require('../mcp/client') as {
            createMcpToolsForWorkspace: (servers: Array<{ name: string; url: string; apiKey?: string }>) => Promise<Array<{ name: string; description: string; parameters: Record<string, unknown>; execute: Function }>>;
          };
          const { registerDynamicTools } = require('../tools/index');
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

      // ── A2A Agent Config ────────────────────────────────────────
      // Sources: data_sources.a2a_agents OR RT_A2A_AGENTS env var
      let a2aAgentList: Array<{ name: string; url: string; apiKey?: string }> | null = null;
      if (dataSources && (dataSources as Record<string, unknown>).a2a_agents) {
        const agents = (dataSources as Record<string, unknown>).a2a_agents;
        if (Array.isArray(agents) && agents.length > 0) a2aAgentList = agents;
      }
      if (!a2aAgentList) {
        const mData = await (require('../utils/fetchManifest') as { fetchManifest: () => Promise<any> }).fetchManifest();
        const parsed = mData.RT_A2A_AGENTS;
        if (Array.isArray(parsed) && parsed.length > 0) a2aAgentList = parsed;
      }
      if (a2aAgentList) {
        workspaceConfig.a2aAgents = a2aAgentList;
      }

      // Vertex AI uses ADC, Ollama uses no auth — skip API key for both
      let apiKey: string = '';
      if (aiProvider === 'vertexai') {
        if (!config.vertexai.project) {
          io.to(wsChannel).emit('ai-error', { error: 'GCP_PROJECT not set. Required for Vertex AI.' });
          return;
        }
      } else if (aiProvider === 'ollama') {
        // No API key needed — pass per-workspace host into workspaceConfig
        workspaceConfig.ollamaHost = workspace?.ollama_host || config.ollama?.host || 'http://localhost:11434';
      } else {
        const userKey: string = await workspaceService.getUserApiKey(socket.userId, aiProvider);
        const serverKey: string = config.ai[aiProvider as keyof typeof config.ai] || '';
        apiKey = userKey || serverKey;

        if (!apiKey) {
          io.to(wsChannel).emit('ai-error', { error: `No API key for ${aiProvider}. Add one in Settings.` });
          return;
        }
      }

      // In embed mode, use smaller history window (ephemeral guest sessions)
      const historyLimit: number = config.embedMode ? 10 : 50;
      const history: Message[] = await workspaceService.getConversationHistory(historyLimit);
      const messages: Record<string, unknown>[] = [];

      // Build system prompt with workspace context
      let systemPrompt: string = (workspace && workspace.system_prompt) || '';
      try {
        const workspaceDir: string = require('path').resolve(__dirname, '..', '..', 'workspace');
        const fs = require('fs') as typeof import('fs');
        if (fs.existsSync(workspaceDir)) {
          const repos = fs.readdirSync(workspaceDir, { withFileTypes: true })
            .filter((e: import('fs').Dirent) => e.isDirectory() && fs.existsSync(require('path').join(workspaceDir, e.name, '.git')));
          if (repos.length > 0) {
            let ctx: string = '\n\n--- WORKSPACE CONTEXT ---\nYou have DIRECT ACCESS to these cloned repositories via your tools. ALWAYS use your tools to find and read code. NEVER say a file does not exist without first using find_file to search for it.\n\nTOOL USAGE:\n- find_file: Search for any file by name across repos. USE THIS FIRST when a user mentions a file.\n- list_files: List directory contents. Use directory="reponame/path" for subdirectories.\n- read_file: Read file contents. Use filepath="reponame/path/to/file"\n- write_file: Edit files. Use filepath="reponame/path/to/file"\n- git_commit: Commit, push, and create PRs. Use directory="reponame"\n\nWhen a user mentions a filename, ALWAYS use find_file first to locate it, then read_file to read it. Do NOT guess paths or say a file does not exist.\n';

            // Inject the active repo context
            if (activeRepo) {
              ctx += '\n** ACTIVE REPOSITORY: ' + activeRepo + ' **\nThe user is currently viewing this repo in the code panel. When they mention files, assume they mean files in "' + activeRepo + '/" unless they specify otherwise. For file operations, prefix paths with "' + activeRepo + '/".\n';
            }

            ctx += '\nAvailable repos:\n';
            for (const repo of repos) {
              const repoPath: string = require('path').join(workspaceDir, repo.name);
              const entries: string = fs.readdirSync(repoPath, { withFileTypes: true })
                .filter((e: import('fs').Dirent) => !e.name.startsWith('.') && e.name !== 'node_modules')
                .slice(0, 20)
                .map((e: import('fs').Dirent) => '  ' + (e.isDirectory() ? '[dir]' : '[file]') + ' ' + e.name)
                .join('\n');
              ctx += '[repo] ' + repo.name + '/\n' + entries + '\n\n';
            }
            systemPrompt += ctx;
          }
        }
      } catch { /* ignore workspace scan errors */ }

      // ── Platform Context ────────────────────────────────────
      // Lean system prompt with behavioral rules + data context.
      // The AI discovers its own capabilities via describe_workspace tool.

      const gcpProject: string = config.vertexai?.project || process.env.GCP_PROJECT || '';
      const gcpRegion: string  = process.env.GCP_LOCATION || 'us-central1';
      const bqProject: string  = dataSources?.bigquery?.project || gcpProject;

      // Build BigQuery dataset context dynamically from workspace data sources
      let bqDatasetCtx: string = '';
      if (bqProject) {
        const bqDataProject: string = dataSources?.bigquery?.dataProject || bqProject;
        const bqDatasets: Record<string, string> | undefined = dataSources?.bigquery?.datasets;
        if (bqDatasets && typeof bqDatasets === 'object' && Object.keys(bqDatasets).length > 0) {
          bqDatasetCtx += `\n- Authorized BigQuery datasets in \`${bqDataProject}\`:`;
          for (const [dsName, dsDesc] of Object.entries(bqDatasets)) {
            bqDatasetCtx += `\n  * \`${dsName}\`${dsDesc ? ' — ' + dsDesc : ''}`;
          }
          bqDatasetCtx += `\n- Use fully-qualified table names: \`${bqDataProject}.<dataset>.<table>\``;
        } else {
          bqDatasetCtx += `\n- BigQuery is available. Use fully-qualified table names: \`${bqDataProject}.<dataset>.<table>\``;
        }

        // Inject column-level schema from dataSources.bigquery.schema if present
        const bqSchema: Record<string, string> | undefined = dataSources?.bigquery?.schema;
        if (bqSchema && typeof bqSchema === 'object' && Object.keys(bqSchema).length > 0) {
          bqDatasetCtx += `\n\n- Authorized BigQuery tables (you may ONLY query these — do NOT use INFORMATION_SCHEMA):`;
          // Group tables by dataset for clean presentation
          const tablesByDataset = new Map<string, Array<{ fullName: string; columns: string }>>();
          for (const [fullTable, columns] of Object.entries(bqSchema)) {
            // fullTable is like "pc_execution.positions" or "project.dataset.table"
            const parts: string[] = fullTable.split('.');
            const dataset: string = parts.length >= 2 ? parts[parts.length - 2] : 'unknown';
            if (!tablesByDataset.has(dataset)) tablesByDataset.set(dataset, []);
            const qualifiedName: string = parts.length >= 3
              ? `${parts.join('.')}`
              : `${bqDataProject}.${fullTable}`;
            tablesByDataset.get(dataset)!.push({ fullName: qualifiedName, columns });
          }
          for (const [dataset, tables] of tablesByDataset) {
            bqDatasetCtx += `\n  Dataset: ${dataset}`;
            for (const t of tables) {
              bqDatasetCtx += `\n    Table: \`${t.fullName}\``;
              bqDatasetCtx += `\n      Columns: ${t.columns}`;
            }
          }
          bqDatasetCtx += `\n\n- Do NOT use INFORMATION_SCHEMA. Do NOT query any tables not listed above.`;
        }
      }

      const orgLabel: string = config.platformOrg ? ` by ${config.platformOrg}` : '';
      const envCtx: string = `You are the AI assistant for the "${config.workspaceName}" workspace on the Roundtable platform${orgLabel}. This is a real-time multiplayer workspace — multiple users may be present simultaneously.

--- SELF-DISCOVERY ---
You have a describe_workspace tool. Call it when:
- A user asks what you can do or what tools are available
- You need to understand your deployment environment
- You want to know which data warehouses or agents are connected
- You need to know your current bridges or governance contracts
Do NOT guess your capabilities. Call describe_workspace to get the live inventory.

--- WORKSPACE SELF-KNOWLEDGE ---
Your workspace has a .roundtable/README.md file containing authoritative documentation about platform concepts (bridges, contracts, governance). ALWAYS read this file when asked about bridges, contracts, governance, or how the Roundtable platform works. NEVER fabricate definitions, claim files exist that you haven't verified, or invent concepts like "data schema contracts". Contracts govern cross-workspace authorization, NOT database schemas.

For LIVE data about your current bridges, contracts, tools, and data sources, call describe_workspace. This returns real-time data from the control plane.

--- DATA ENVIRONMENT ---
- GCP Project: ${gcpProject || '(not configured)'}
- GCP Region: ${gcpRegion}
- BigQuery billing project: ${bqProject || '(not configured)'}${bqProject ? ' (use this as the default project when running queries)' : ''}${bqDatasetCtx}

--- BEHAVIORAL RULES ---
- When presenting SQL/BigQuery query results: Format the data as a markdown table (| col | col |\\n|---|---|\\n| val | val |). IMPORTANT: Show at most 50 rows in your markdown table. If there are more, show the first 50 and note the total count. Never dump raw JSON arrays. If there are no rows, say "No results returned."
- When writing SQL queries: ALWAYS include a LIMIT clause (default LIMIT 100) unless the user specifically asks for all rows or an aggregate (COUNT, SUM, etc.).
- ALWAYS call tools directly when asked. Never ask the user for config values the environment already provides (project ID, region, etc.).
- If a tool call fails with a transient error, try again with the same or corrected inputs. Do NOT tell the user you cannot do something without first attempting it with a tool.
- CRITICAL: If a BigQuery query fails with "Access Denied" or "Table not found", do NOT guess alternative table names. Instead, STOP and tell the user the exact error. You may ONLY use table names from the schema definitions provided below or that you have confirmed exist via a successful query.
- If you fail a query 3 times, STOP retrying and summarize what you tried and what went wrong.

--- RESPONSE ATTRIBUTION ---
- ALWAYS begin your response by @-mentioning the person you are replying to BY NAME. For example: "@Brady, here's what I found..." or "@Analytics, the query returned 42 rows."
- In a multiplayer workspace, this makes it clear who each response is directed at.
- If the message is from a bridge (starts with "[Bridge from X]"), @-mention the source workspace name.
- NEVER say "@User". Always use the person's actual name.
- The current message is from: **${socket.username || 'a user'}**

--- PROVENANCE ---
NEVER compute or display coverage, confidence, or provenance numbers in your response text.
NEVER use words like "comprehensive", "thorough", or "complete analysis" unless you have queried ALL relevant domains.
The platform computes provenance automatically from structured data. You consume it, never produce it.
Call emit_provenance ONCE at the end of every financial response with your raw domain results.
The frontend renders the provenance footer — do NOT render a 📍 Data Provenance footer yourself.
Do NOT echo provenance metrics in your response. The UI handles this.

--- CLAIM DISCIPLINE ---
Every material claim in your response must be one of:
  • Observation: directly read from data. Use precise language. Never hedge observations.
  • Calculation: derived via math. Show the formula.
  • Inference: a conclusion you drew. Always cite the observations it's based on.
  • Hypothesis: a possible explanation. MUST use "may", "could", "might", "possibly".
  • Recommendation: an action to consider. Always separate from factual claims.
  • Unknown: information cannot be determined from available evidence.

Only include claims that materially affect the user's understanding, decision-making, or conclusions.
Do not classify every sentence.

NEVER present a hypothesis as an observation.
When multiple plausible explanations exist and evidence is insufficient, prefer Unknown over Hypothesis.
Historical trends below 60% historical coverage must be described as tentative, estimated, inferred, or directional. Do not describe them as definitive.
When calling emit_provenance, include a \`claims\` array classifying your key statements and a \`responseText\` field with your full response.

--- RECOMMENDATION DISCIPLINE ---
Recommendations must be proportional to evidence.

Allowed:
• "Consider reviewing..."
• "You may want to investigate..."
• "One option is..."

Not allowed unless directly supported by evidence:
• "You should dispute..."
• "You must cancel..."
• "Immediately contact..."
• "This is unauthorized..."

Recommendations may not assume motive, fraud, error, or intent.
Transaction data alone rarely establishes these facts.

--- EVIDENCE BOUNDARIES ---
Transaction data can establish:
• Amounts, Dates, Merchants, Frequencies, Transfers, Balances

Transaction data CANNOT reliably establish:
• Fraud, Authorization status, Business necessity, Subscription status, User intent, Merchant relationships

CRITICAL: Do not claim fraud, dispute charges, or recommend card freezes based on transaction patterns alone. These are actionable legal conclusions that require evidence beyond what transaction data provides.

WORKED EXAMPLE — Recurring same-amount charges from different merchants:
❌ WRONG: "This is a red flag for fraud. Freeze the card and dispute these charges immediately."
❌ WRONG: "This pattern strongly suggests an exploited card or unauthorized subscription."
✅ CORRECT: "Three identical $500 charges from unrelated merchants appear monthly. The purpose and authorization of these charges cannot be determined from transaction data alone. These should be reviewed with the cardholder to confirm they are intentional."

The correct response uses Observation (pattern exists) + Unknown (purpose cannot be determined) + Recommendation (review with cardholder). It does NOT assume fraud, demand disputes, or recommend freezing accounts.

--- FINANCIAL PRIORITIZATION ---
When evaluating finances or making recommendations, apply this priority hierarchy:
1. Liquidity — can they cover near-term obligations and emergencies?
2. High-interest debt — credit cards and high-APR loans destroy wealth fastest
3. Emergency reserves — 3-6 months of expenses in accessible accounts
4. Tax efficiency — are they leaving money on the table (retirement contributions, tax-loss harvesting, deduction gaps)?
5. Retirement trajectory — are they on track for their age and goals?
6. Portfolio allocation — is their risk exposure appropriate and diversified?
7. Real estate leverage — is their equity concentration healthy or overexposed?

When recommending actions, prefer the highest expected risk-adjusted value. A dollar of credit card debt at 21% APR matters more than a dollar of student loan at 5%. Surface the most impactful move, not the most obvious one.

--- GOAL-AWARE REASONING ---
Every financial domain has goals. Goals live INSIDE domains — you synthesize ACROSS them.
You are the ONLY interface for goal management. There is no goals page or form — users set, review, and manage goals entirely through conversation with you.

Goal capabilities available via intent_bridge (op: capability):
- goals.list — list all active goals for a domain (with latest progress snapshot)
- goals.get — get a specific goal with full evaluation and trend history
- goals.create — create a new goal for a domain
- goals.update — update goal parameters (target, date, contribution, status)
- goals.delete — remove a goal
- goals.evaluateProgress — evaluate current progress using live data, records a snapshot
- goals.snapshot — batch-evaluate ALL active goals for a domain (daily use)

GOAL-SETTING WORKFLOW (MANDATORY):
When a user expresses intent to set, change, or add a financial goal:
1. GATHER — Clarify the goal if vague: what domain, what target, what timeline, what monthly contribution?
2. FETCH ALL — Call goals.list on EVERY connected domain to get all active goals
3. CONFLICT CHECK — Analyze the new goal against existing goals:
   - Does the total of all monthly contributions exceed disposable income?
   - Does this goal compete with a higher-priority goal (per FINANCIAL PRIORITIZATION)?
   - Does it extend the timeline on an existing goal?
   - Are there redundant goals (e.g., two savings goals on the same account)?
4. PRESENT — Show the user:
   - The proposed goal parameters (domain, target, date, contribution)
   - Any conflicts or trade-offs with existing goals, with concrete numbers
   - Your recommendation (create as-is, adjust parameters, defer, or replace another goal)
   - Impact on other goals if applicable
5. WAIT — Ask for explicit confirmation. Do NOT create the goal until the user confirms.
6. EXECUTE — Only after confirmation, call goals.create (or goals.update) on the appropriate domain
7. CONFIRM — Report back what was created/changed

NEVER skip steps 2-5. Even if the goal seems straightforward, always check against existing goals. Users deserve to see the full picture before committing.

CROSS-DOMAIN TRADE-OFF ANALYSIS:
When a user's question involves competing priorities (e.g., "should I pay off my car or invest more?"):
1. Fetch goals from ALL involved domains (debt, investments, etc.)
2. Evaluate current progress on each
3. Model the impact: what happens to each goal if they redirect $X/month?
4. Present the trade-off with concrete numbers, not abstract advice
5. Recommend based on the FINANCIAL PRIORITIZATION hierarchy above

GOAL-GROUNDED RESPONSES:
When presenting financial data, anchor it to the user's goals whenever possible.
- Instead of "Your balance is $15,000" → "Your emergency fund is at $15,000 — 75% of your $20,000 target"
- Instead of "Debt is $12,000" → "You've paid off 40% of your debt payoff goal. At current pace, you'll hit $0 by March 2027"

--- SIGNIFICANCE ---
Users are asking for significance, not data. Do not stop at reporting balances.

After presenting facts, always identify:
- Largest risks — what could hurt them most?
- Largest opportunities — where is the biggest upside?
- Largest concentrations — where are they overexposed?
- Biggest changes — what shifted recently?
- Most impactful next action — what single move matters most right now?

The difference between "net worth is $1.9M" and "64% of your wealth is in real estate" is the difference between data and insight. Always deliver insight.

--- QUESTION TYPES ---
Not all questions require the same depth. Match your approach to the question type:

Type 1 — Retrieval:
  Examples: "What is my balance?", "Show my transactions", "What holdings do I own?"
  Answer directly. Do not force broader analysis.

Type 2 — Analysis:
  Examples: "Show me payoff options", "Calculate my net worth", "Compare these scenarios"
  Answer directly. Then provide relevant context if another domain materially affects the result.

Type 3 — Decision:
  Examples: "Should I...", "Can I afford...", "Is it worth...", "Which is better...", "What's the best use of..."
  Always perform cross-domain analysis. Never answer from a single domain if other connected domains materially affect the decision.

--- DECISION SUPPORT ---
Arthur is not a calculator. Arthur is a financial decision-support system.

When a user asks how to do something, determine whether they should do it before determining how.

Example:
  User: "Show me three ways to pay off my student loan."
  WRONG: Present three amortization schedules.
  RIGHT: "Before we get into payoff schedules, paying off the student loan may not currently be your highest-return move because you have credit-card debt at 21.49%. Eliminating $6,538 in credit-card debt first would save more in interest than accelerating the student loan at 5.5%."
  Then answer the original question.

--- CHALLENGE THE PREMISE ---
When a user's question implies a course of action, evaluate whether the underlying assumption is optimal. If a better alternative is visible from connected data, surface it — then answer the original question.

Example:
  User: "How can I pay off my student loan in 12 months?"
  Do not assume the student loan should be paid off first. Evaluate:
  - Whether the loan is high priority relative to other debts
  - Whether investing the cash may be superior at current rates
  - Whether liquidity should be preserved given their emergency reserves
  - How it compares to other debts in the priority hierarchy
  Then answer the original question with the full context.


--- DIAGRAM STYLING ---
When generating Mermaid diagrams (flowcharts, sequence diagrams, etc.):
- Do NOT use inline \`style\` directives (e.g. \`style A fill:#cce5ff\`). The rendering engine applies a curated dark-mode theme automatically.
- Do NOT use \`classDef\` or \`class\` statements for coloring. Keep diagrams clean and structural.
- Do NOT use HTML tags (\`<b>\`, \`<br>\`, \`<i>\`, etc.) in node or edge labels — they render as literal text, not formatted HTML. Use plain text only.
- Focus on clear node labels, meaningful edge labels, and logical flow.
- The workspace uses a dark theme with these accent colors: indigo (#6366f1), soft purple (#c7d2fe), amber (#fde68a), green (#bbf7d0). The rendering engine maps these automatically.
- Use subgraphs to group related nodes when the diagram has 8+ nodes.

--- PLATFORM IDENTITY ---
You are an AI agent running inside Roundtable — an agentic workspace platform built by Foxtrot Communications.

How this system works:
1. DOMAIN SEPARATION: Data lives in isolated, purpose-built workspaces. Each workspace has its own data, tools, and governance. They don't share databases.
2. GOVERNED COORDINATION: Workspaces communicate through governance contracts — explicit, auditable permissions that define what actions are allowed across each bridge.
3. AGENTIC EXECUTION: You reason about what the user needs, then orchestrate tool calls and cross-workspace queries to assemble the answer. Answers are synthesized dynamically, not rendered from pre-built views.
4. PROVENANCE: Every number you present is traced back to its source workspace, with confidence scoring and verification status.
5. EXTENSIBILITY: New domains are added by deploying new workspaces with their own specialized tools and data.

Match the depth and technicality of your response to the question being asked. If someone asks a simple question, answer like a person would — don't enumerate capabilities or recite architecture.
--- FORMATTING ---
- LaTeX math IS supported! Use \`$...$\` for inline math and \`$$...$$\` for display equations.
- IMPORTANT: When writing currency amounts inside LaTeX math blocks, escape the dollar sign: use \`\\$257,040\` not \`$257,040\` (bare \`$\` will break the math delimiter).
- For non-math text, prefer Unicode symbols: → (arrow), ≥ (gte), ≤ (lte), ≠ (neq), × (multiply), ÷ (divide), α β γ (Greek letters).
- Use standard Markdown for formatting: **bold**, *italic*, \`code\`, tables, lists.

--- RESPONSE STRUCTURE ---
For any response longer than ~3 sentences, use visual structure:
- Lead with a clear headline or summary (1-2 sentences max)
- Use headers (##, ###) to separate major sections
- Use tables for comparative or multi-column data
- Use bullet points for lists of items or factors
- Use bold for key numbers and conclusions
- Keep paragraphs short — 2-4 sentences max
- End with a clear bottom line or recommended next action

NEVER write a wall of text. If your response has more than one idea, it needs structure.`;

      // ── Governance Contract Context ──────────────────────────
      // Inject active contract info so the AI knows its governance relationships
      let contractCtx: string = '';
      try {
        const contractData = await (require('../utils/fetchManifest') as { fetchManifest: () => Promise<any> }).fetchManifest();
        interface ContractEntry {
          contractId: string;
          type: string;
          direction: 'inbound' | 'outbound';
          counterparty?: { name: string; wsId: string };
          allowedActions?: string[];
          escalationTarget?: string;
        }
        const contracts: ContractEntry[] = contractData.RT_CONTRACTS || [];
        if (contracts.length > 0) {
          contractCtx = '\n\n--- GOVERNANCE CONTRACTS ---\n';
          contractCtx += `You have ${contracts.length} active governance contract(s) governing your communication with other workspaces:\n`;
          for (const c of contracts) {
            const dir = c.direction === 'outbound'
              ? `You → ${c.counterparty?.name || 'Unknown'}`
              : `${c.counterparty?.name || 'Unknown'} → You`;
            contractCtx += `\n• **${c.type}** contract (${dir})`;
            if (c.allowedActions && c.allowedActions.length > 0) {
              contractCtx += `\n  Allowed actions: ${c.allowedActions.join(', ')}`;
            }
            if (c.escalationTarget) {
              contractCtx += `\n  Escalation target: ${c.escalationTarget}`;
            }
          }
          contractCtx += `\n\n--- CROSS-WORKSPACE EXECUTION MODEL ---\nYou are the reasoning layer. ICE is the execution layer.\n\nWhen a user asks something that involves another workspace:\n1. YOU reason about what the user needs — they should NOT direct traffic\n2. YOU decide the best approach:\n   a. Capability call (intent_bridge op:capability) — if a typed capability exists. PREFER THIS.\n   b. Data query (intent_bridge op:query) — if you need raw data from the other workspace.\n   c. Tool invocation (intent_bridge op:tool_call) — if you need a specific tool on the other side.\n   d. Delegation (bridge_workspace op:delegate) — ONLY when you genuinely need the other AI to reason.\n3. YOU execute it, interpret the results, and respond to the user.\n\nCRITICAL: The user should NEVER need to say "ask pharmacy" or "send this to risk".\nThey just ask their question. YOU know the topology, the bridges, the contracts.\nYOU decide where to get the answer and how.\n\nExample:\n  User: "What's the formulary status for Ozempic?"\n  WRONG: Relay the question to Pharmacy AI as a message\n  RIGHT: Call pharmacy.formularyCheck({drug:"Ozempic"}) via ICE, get structured result, present it\n\n  User: "Draft a P&T committee recommendation for switching to a biosimilar"\n  RIGHT: Delegate to Pharmacy AI — this requires their specialized reasoning\n\nintent_bridge — Your execution tool for cross-workspace operations:\n- Capability calls: op capability with name and typed input (PREFERRED)\n- Data queries: op query with SQL or structured params\n- Tool invocations: op tool_call with tool name and args\n- Discovery: op discover to see what a workspace can do\n\nbridge_workspace — Only when you need the OTHER AI to reason (rare):\n- Subjective analysis requiring judgment on the other side\n- Creative synthesis that no capability covers\n- NEVER use this to relay a user's message verbatim\n\nDefault to intent_bridge. Use bridge_workspace delegate only as a last resort.\nIf unsure what a workspace has, discover first.\n`;
        }
      } catch { /* ignore contract fetch errors */ }

      systemPrompt = envCtx + contractCtx + (systemPrompt ? '\n\n' + systemPrompt : '');

      // Auto-inject schema YAML files from workspace/uploads/ into the system prompt
      // SKIP if dataSources.bigquery.schema is set — workspace config schema takes precedence
      if (!dataSources?.bigquery?.schema || Object.keys(dataSources.bigquery.schema).length === 0) {
        try {
          const uploadsDir: string = require('path').resolve(__dirname, '..', '..', 'workspace', 'uploads');
          const fs = require('fs') as typeof import('fs');
          if (fs.existsSync(uploadsDir)) {
            const schemaFiles: string[] = fs.readdirSync(uploadsDir)
              .filter((f: string) => f.endsWith('.yaml') || f.endsWith('.yml'));
            if (schemaFiles.length > 0) {
              let schemaCtx: string = '\n\n--- DATA SCHEMA DEFINITIONS ---\nThe following schemas define ALL available tables and columns. Use ONLY these table names in queries. Do NOT guess or invent table names.\n';
              for (const sf of schemaFiles) {
                const content: string = fs.readFileSync(require('path').join(uploadsDir, sf), 'utf8');
                schemaCtx += `\n### ${sf}\n\`\`\`yaml\n${content}\n\`\`\`\n`;
              }
              systemPrompt += schemaCtx;
            }
          }
        } catch { /* ignore schema scan errors */ }
      }

      // Auto-inject markdown docs from workspace/docs/ into the system prompt
      try {
        const docsDir: string = require('path').resolve(__dirname, '..', '..', 'workspace', 'docs');
        const fs = require('fs') as typeof import('fs');
        if (fs.existsSync(docsDir)) {
          const docFiles: string[] = fs.readdirSync(docsDir)
            .filter((f: string) => f.endsWith('.md'));
          if (docFiles.length > 0) {
            let docsCtx: string = '\n\n--- WORKSPACE DOCUMENTATION ---\nThe following documents provide context about this workspace and its data. Use them to answer user questions.\n';
            for (const df of docFiles) {
              const content: string = fs.readFileSync(require('path').join(docsDir, df), 'utf8');
              docsCtx += `\n### ${df}\n${content}\n`;
            }
            systemPrompt += docsCtx;
          }
        }
      } catch { /* ignore docs scan errors */ }

      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

      for (const msg of history) {
        if (msg.role === 'tool') continue;
        const histMsg = msg as Message & { username?: string; display_name?: string };
        if (msg.role === 'user' && (histMsg.display_name || histMsg.username)) {
          const name = histMsg.display_name || histMsg.username;
          // In embed mode with guest users, only attribute messages to the current user
          // to prevent the AI from addressing a previous guest's name
          if (!socket.userId && name !== socket.username) {
            messages.push({ role: msg.role, content: msg.content });
          } else {
            messages.push({ role: msg.role, content: `[${name}]: ${msg.content}` });
          }
        } else {
          messages.push({ role: msg.role, content: msg.content });
        }
      }

      // Mark workspace as processing
      workspaceProcessing.set(config.workspaceId, true);

      // Set up per-socket AbortController
      const abortController: AbortController = new AbortController();
      socket.abortController = abortController;
      socket.isGenerating = true;

      // Broadcast to the workspace that this user's AI is active
      io.to(wsChannel).emit('ai-start', { userId: socket.userId, username: socket.username });

      let fullText: string = '';
      let usageData: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
      let toolCallCount: number = 0;
      const toolNamesUsed: string[] = [];

      try {
        const tracedConfig = { ...workspaceConfig, traceContext: { traceId: rootSpan.traceId, spanId: rootSpan.spanId, sampled: rootSpan._sampled } };
        for await (const event of streamCompletion(
          aiProvider, aiModel, messages, apiKey, toolsEnabled,
          abortController.signal, enabledToolNames, tracedConfig
        )) {
          if (abortController.signal.aborted) break;

          switch (event.type) {
            case 'text-delta':
              fullText += event.content;
              if (fullText.length === event.content.length) {
                // First text chunk — AI is now composing
                io.to(wsChannel).emit('ai-status', { step: 'composing', label: 'Composing response', state: 'active' });
              }
              io.to(wsChannel).emit('ai-chunk', { content: event.content, userId: socket.userId });
              break;
            case 'tool-call':
              console.log(`[Tool] Calling: ${event.name}`, JSON.stringify(event.args));
              io.to(wsChannel).emit('tool-call', { name: event.name, args: event.args, callId: event.callId });
              // Emit human-readable step status
              const activity = describeActivity(event.name, event.args as Record<string, unknown>);
              io.to(wsChannel).emit('ai-status', { step: activity.step, label: activity.label, state: 'active' });
              toolCallCount++;
              if (!toolNamesUsed.includes(event.name)) toolNamesUsed.push(event.name);
              // Audit: tool call
              { const { getAdapter: _ga } = require('../db/adapter') as { getAdapter: () => DatabaseAdapter };
                _ga().audit(config.workspaceId, socket.userId, socket.username, 'tool_call', event.name, {
                  args: JSON.stringify(event.args).substring(0, 500),
                }, socket.handshake?.address).catch(() => {}); }
              // Chart telemetry: always-sampled span capturing what type the model chose
              if (event.name === 'render_chart' && event.args) {
                const chartArgs = event.args as Record<string, unknown>;
                const datasets = Array.isArray(chartArgs.datasets) ? chartArgs.datasets as any[] : [];
                const chartSpan = startSpan({
                  traceId: rootSpan.traceId,
                  parentSpanId: rootSpan.spanId,
                  workspaceId: config.workspaceId,
                  workspaceName: workspace?.name || config.workspaceId,
                  operation: 'render_chart',
                  toolName: 'render_chart',
                  inputPreview: JSON.stringify(chartArgs).substring(0, 500),
                  sampled: true,
                });
                endSpan(chartSpan, 'completed', {
                  metadata: {
                    chartType: chartArgs.type,
                    title: chartArgs.title,
                    datasetCount: datasets.length,
                    datasetLabels: datasets.map((d: any) => d.label).filter(Boolean),
                    labelCount: Array.isArray(chartArgs.labels) ? (chartArgs.labels as any[]).length : 0,
                    stacked: chartArgs.stacked || false,
                    horizontal: chartArgs.horizontal || false,
                    currency: chartArgs.currency || null,
                  },
                });
                recordSpan(chartSpan);
              }
              break;
            case 'tool-result':
              console.log(`[Tool] Result from ${event.name}:`, JSON.stringify(event.result).substring(0, 200));
              await workspaceService.saveMessage(null, 'tool', JSON.stringify(event.result), event.name, event.callId);
              io.to(wsChannel).emit('tool-result', { name: event.name, callId: event.callId, result: event.result });
              // Mark the step as completed
              const completedActivity = describeActivity(event.name, event.result as Record<string, unknown> || {});
              io.to(wsChannel).emit('ai-status', { step: completedActivity.step, label: completedActivity.label, state: 'completed' });
              // Audit: tool result (data_query for warehouse tools, tool_result for others)
              {
                const auditType = ['query_bigquery', 'query_snowflake', 'query_databricks'].includes(event.name) ? 'data_query' : 'tool_result';
                const { getAdapter: _ga } = require('../db/adapter') as { getAdapter: () => DatabaseAdapter };
                _ga().audit(config.workspaceId, socket.userId, socket.username, auditType, event.name, {
                  resultPreview: JSON.stringify(event.result).substring(0, 200),
                }, socket.handshake?.address).catch(() => {});
              }
              // Notify code panel when workspace files change
              if (['write_file', 'git_clone', 'git_commit', 'shell_exec'].includes(event.name)) {
                io.to(wsChannel).emit('workspace-changed', { tool: event.name });
              }
              break;
            case 'usage':
              usageData = event;
              console.log(`[Usage] tokens: ${event.promptTokens}/${event.completionTokens}/${event.totalTokens}`);
              io.to(wsChannel).emit('ai-usage', {
                promptTokens: event.promptTokens,
                completionTokens: event.completionTokens,
                totalTokens: event.totalTokens,
                userId: socket.userId,
              });
              break;
            case 'error':
              io.to(wsChannel).emit('ai-error', { error: event.error });
              break;
            case 'done':
              if (event.fullText) await workspaceService.saveMessage(null, 'assistant', event.fullText);
              break;
          }
        }
      } catch (err: unknown) {
        const error = err as Error & { name: string };
        if (error.name !== 'AbortError') {
          console.error(`[Chat] AI stream error in workspace ${config.workspaceId}:`, error);
          endSpan(rootSpan, 'error', { outputPreview: preview(error.message) });
          recordSpan(rootSpan);
          io.to(wsChannel).emit('ai-error', { error: `AI generation failed: ${error.message}` });
        }
      } finally {
        socket.isGenerating = false;
        socket.abortController = null;
        if (rootSpan.status === 'started') {
          endSpan(rootSpan, 'completed', { metadata: { toolCallCount, provider: aiProvider, model: aiModel } });
          recordSpan(rootSpan);
        }
        io.to(wsChannel).emit('ai-complete', { fullText, userId: socket.userId, traceId: rootSpan.traceId });

        // ── Process next queued request ──────────────────────────
        workspaceProcessing.set(config.workspaceId, false);
        const queue = getQueue(config.workspaceId);
        if (queue.length > 0) {
          const next = queue.shift()!;
          io.to(wsChannel).emit('ai-queue-update', { queueLength: queue.length });
          console.log(`[Queue] Processing next request from ${next.socket.username} for workspace ${config.workspaceId} (${queue.length} remaining)`);
          // Reset the queued user's isGenerating so the handler accepts it
          next.socket.isGenerating = false;
          // Re-invoke — message was already saved, so pass _fromQueue to skip re-save
          setImmediate(() => {
            next.socket.emit('send-message', { content: next.content, activeRepo: next.activeRepo, _fromQueue: true });
          });
        } else {
          io.to(wsChannel).emit('ai-queue-update', { queueLength: 0 });
        }

        // Record usage to database (fire-and-forget)
        try {
          const { getAdapter } = require('../db/adapter') as { getAdapter: () => DatabaseAdapter };
          await getAdapter().recordUsage(
            config.workspaceId,
            socket.userId,
            aiProvider,
            aiModel,
            usageData?.promptTokens || 0,
            usageData?.completionTokens || 0,
            usageData?.totalTokens || 0,
            toolCallCount,
            toolNamesUsed,
          );
        } catch (usageErr: unknown) {
          const usageError = usageErr as Error;
          console.error('[Usage] Failed to record usage:', usageError.message);
        }

        // Report usage to dashboard for billing (fire-and-forget)
        try {
          const dashboardUrl: string | undefined = process.env.RT_DASHBOARD_URL;
          if (dashboardUrl && usageData?.totalTokens) {
            const crypto = require('crypto') as typeof import('crypto');
            const ts: string = Date.now().toString();
            const sig: string = crypto.createHmac('sha256', config.sessionSecret)
              .update(`${config.workspaceId}:${ts}`)
              .digest('hex');
            fetch(`${dashboardUrl}/api/usage-report/report`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                workspaceId: config.workspaceId,
                workspaceName: config.workspaceName || config.workspaceId,
                userId: socket.userId?.toString() || 'unknown',
                userName: socket.username || 'unknown',
                model: aiModel,
                tokens: usageData.totalTokens,
                isOverage,
                timestamp: ts,
                signature: sig,
              }),
            }).catch((err: Error) => console.warn('[Usage] Dashboard report failed:', err.message));
          }
        } catch { /* intentionally empty */ }
      }
    } catch (err: unknown) {
      const error = err as Error;
      console.error('[Chat] Error:', error);
      socket.emit('error-message', { error: 'Failed to send message' });
    }
  });

  socket.on('stop-generation', () => {
    if (socket.abortController) {
      socket.abortController.abort();
      console.log(`[Chat] Generation stopped by ${socket.username}`);
    }
  });

  // Clean up on disconnect
  socket.on('disconnect', () => {
    if (socket.abortController) {
      socket.abortController.abort();
    }
    // Remove any queued requests from this socket
    const queue = getQueue(config.workspaceId);
    const before = queue.length;
    const filtered = queue.filter(r => r.socket.id !== socket.id);
    if (filtered.length !== before) {
      workspaceQueues.set(config.workspaceId, filtered);
      console.log(`[Queue] Removed ${before - filtered.length} queued request(s) from disconnected user ${socket.username}`);
    }
  });
}

module.exports = { setupChatHandlers };
