// server/sockets/chat/index.ts — Message handling + AI streaming with tools
// (workspace-based). Split out of chatHandler.ts in Phase 6.2 (pure move):
// queue/rate-limit state in ./session, @ai-{workspace} delegation in
// ./consult, MCP + A2A discovery in ./mcp, system prompt in ./prompt.
// server/sockets/chatHandler.ts re-exports from here.
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
} from '../../types';

import { workspaceProcessing, workspaceQueues, getQueue, isProcessing, RATE_LIMIT_WINDOW, RATE_LIMIT_MAX, buildAiTriggerPattern } from './session';
import { handleBridgeDelegation } from './consult';
import { discoverMcpTools, resolveA2aAgents } from './mcp';
import { buildSystemPrompt } from './prompt';

const workspaceService = require('../../services/workspaceService') as {
  workspaceId: string;
  ensureWorkspace(): Promise<import('../../types').Workspace>;
  getWorkspace(): Promise<import('../../types').Workspace | null>;
  saveMessage(userId: number | null, role: string, content: string, toolName?: string | null, toolCallId?: string | null, sourceWorkspaceId?: string | null, guestUsername?: string | null, guestDisplayName?: string | null): Promise<import('../../types').Message>;
  getConversationHistory(limit: number): Promise<import('../../types').Message[]>;
  getMessages(options?: { limit?: number; before?: number }): Promise<{ messages: import('../../types').Message[]; hasMore: boolean }>;
  getUserApiKey(userId: number, provider: string): Promise<string>;
  getUserById(userId: number): Promise<import('../../types').User | null>;
  scoped(wsId: string): {
    workspaceId: string;
    getWorkspace(): Promise<import('../../types').Workspace | null>;
    saveMessage(userId: number | null, role: string, content: string, toolName?: string | null, toolCallId?: string | null, sourceWorkspaceId?: string | null, guestUsername?: string | null, guestDisplayName?: string | null): Promise<import('../../types').Message>;
    getConversationHistory(limit: number): Promise<import('../../types').Message[]>;
    getMessages(options?: { limit?: number; before?: number }): Promise<{ messages: import('../../types').Message[]; hasMore: boolean }>;
    getUserApiKey(userId: number, provider: string): Promise<string>;
  };
};
const { streamCompletion } = require('../../services/aiProvider') as {
  streamCompletion: (provider: string, model: string, messages: Record<string, unknown>[], apiKey: string, enableTools?: boolean, signal?: AbortSignal | null, enabledToolNames?: string[] | null, workspaceConfig?: WorkspaceConfig) => AsyncGenerator<StreamEvent>;
};
const config = require('../../config') as AppConfig;
const { startSpan, endSpan, generateTraceId, preview } = require('../../tracing') as typeof import('../../tracing');
const { recordSpan } = require('../../tracing/collector') as typeof import('../../tracing/collector');

// ─── Human-friendly step descriptions for tool calls ──────────────────
// Shared with a2a/server.ts via the app-hook boundary: application plugins
// (e.g. @pendragon/tools-plaid) register their own labels; core falls back
// to generic ones. The two hand-mirrored copies that used to live here and
// in a2a/server.ts are gone. (getSystemPromptSections / describeDomainRouting
// are consumed by ./prompt.ts.)
const { describeActivity } =
  require('../../a2a/appHooks') as typeof import('../../a2a/appHooks');

function setupChatHandlers(io: Server, socket: RoundtableSocket): void {
  // ── Tenant derivation (pooled: from the handshake binding; dedicated:
  // socket.rtWorkspaceId === config.workspaceId, so every substitution below
  // resolves to exactly the old values) ──────────────────────────────────
  const wsId: string = socket.rtWorkspaceId || config.workspaceId;
  const svc = workspaceService.scoped(wsId);
  const wsChannel: string = `ws:${wsId}`;
  const aiMessageTimestamps: number[] = []; // per-socket rate tracker

const { touchActivity } = require('../workspaceHandler') as { touchActivity: (wsId?: string) => void };

  socket.on('send-message', async ({ content, activeRepo, _fromQueue }: { content: string; activeRepo?: string; _fromQueue?: boolean }) => {
    // Mark activity on every user message so the dashboard idle checker
    // knows this workspace is actively in use (not just a stale tab)
    touchActivity(wsId);
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

      // ── Tenant workspace row + display name (derivation block) ──
      const workspace: Workspace | null = await svc.getWorkspace();
      const wsName: string = workspace?.name
        || (config.pooledArthur ? 'Arthur' : config.workspaceName)
        || 'Arthur';
      const aiTriggerPattern: RegExp = buildAiTriggerPattern(wsName, wsId);

      // ── Distributed tracing: root span for this chat message ──
      const traceId = generateTraceId();
      const rootSpan = startSpan({
        traceId,
        workspaceId: wsId || '',
        workspaceName: wsName || '',
        operation: 'chat.message',
        inputPreview: preview(content),
      });

      // Save and broadcast every message (skip for queued re-processing)
      if (!_fromQueue) {
        // For embed guests (null userId), persist socket username as guest fields
        const guestName = !socket.userId && socket.username ? socket.username : null;
        const userMessage: Message = await svc.saveMessage(
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
        await handleBridgeDelegation(io, socket, svc, wsId, wsName, wsChannel, content, bridgeMention);
        return;
      }

      // Per-socket guard — only one active request per user (in queue or processing)
      if (socket.isGenerating) {
        socket.emit('error-message', { error: 'Your AI request is still processing. Please wait or stop it first.' });
        return;
      }

      // ── Workspace-level queue: only one AI request at a time ──
      if (isProcessing(wsId)) {
        const queue = getQueue(wsId);
        queue.push({ socket, content, activeRepo, isOverage: false });
        socket.isGenerating = true; // prevent double-queuing from same user
        const position = queue.length;
        socket.emit('ai-queued', { position, message: `Your request is queued (position ${position}). The AI will respond when the current request finishes.` });
        io.to(wsChannel).emit('ai-queue-update', { queueLength: position });
        console.log(`[Queue] Request from ${socket.username} queued at position ${position} for workspace ${wsId}`);
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
          const { getAdapter } = require('../../db/adapter') as { getAdapter: () => DatabaseAdapter };
          const monthlyTokens: number = await getAdapter().getMonthlyTokens(wsId);
          if (monthlyTokens >= MONTHLY_TOKEN_CREDIT) {
            isOverage = true;
            const pct: number = Math.round((monthlyTokens / MONTHLY_TOKEN_CREDIT) * 100);
            console.log(`[Credits] Workspace ${wsId} is over monthly credit: ${monthlyTokens.toLocaleString()} / ${MONTHLY_TOKEN_CREDIT.toLocaleString()} (${pct}%)`);

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


      // (workspace row already fetched in the derivation block above)

      // AI provider config from workspace or defaults
      const aiProvider: string = (workspace && workspace.ai_provider) || 'vertexai';
      const aiModel: string = (workspace && workspace.ai_model) || 'gemini-3.5-flash';
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
      { const { getAdapter: _ga } = require('../../db/adapter') as { getAdapter: () => DatabaseAdapter };
        _ga().audit(wsId, socket.userId, socket.username, 'ai_request', aiProvider, {
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
      // Sender contract (pooled-arthur-plan Q3): tools resolve the tenant's
      // manifest and org master secret from workspaceConfig, never process env.
      const tenantManifest = config.pooled
        ? await (require('../../utils/fetchManifest') as { fetchManifest: (wsId?: string) => Promise<any> }).fetchManifest(wsId)
        : null;
      const workspaceConfig: WorkspaceConfig = {
        dataSources,
        workspaceId: wsId,
        workspaceName: wsName,
        ...(config.pooled ? { tenant: { workspaceId: wsId, orgId: tenantManifest?.orgId ?? null } } : {}),
      };

      // Resolve enabled tool names from workspace config (null = all tools)
      let enabledToolNames: string[] | null = null;
      if (workspace && workspace.enabled_tools) {
        try {
          const parsed: unknown = JSON.parse(workspace.enabled_tools);
          if (Array.isArray(parsed) && parsed.length > 0) enabledToolNames = parsed as string[];
        } catch { /* intentionally empty */ }
      }

      // ── MCP Tool Discovery + A2A Agent Config (see ./mcp.ts) ──
      await discoverMcpTools(dataSources, wsId, tenantManifest, workspaceConfig);
      await resolveA2aAgents(dataSources, wsId, tenantManifest, workspaceConfig);

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
        const userKey: string = await svc.getUserApiKey(socket.userId, aiProvider);
        const serverKey: string = config.ai[aiProvider as keyof typeof config.ai] || '';
        apiKey = userKey || serverKey;

        if (!apiKey) {
          io.to(wsChannel).emit('ai-error', { error: `No API key for ${aiProvider}. Add one in Settings.` });
          return;
        }
      }

      // In embed mode, use smaller history window (ephemeral guest sessions)
      const historyLimit: number = config.embedMode ? 10 : 50;
      const history: Message[] = await svc.getConversationHistory(historyLimit);
      const messages: Record<string, unknown>[] = [];

      // Build system prompt with workspace context (see ./prompt.ts)
      const systemPrompt: string = await buildSystemPrompt(socket, workspace, activeRepo, dataSources, wsId, wsName);
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
      workspaceProcessing.set(wsId, true);

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
              { const { getAdapter: _ga } = require('../../db/adapter') as { getAdapter: () => DatabaseAdapter };
                _ga().audit(wsId, socket.userId, socket.username, 'tool_call', event.name, {
                  args: JSON.stringify(event.args).substring(0, 500),
                }, socket.handshake?.address).catch(() => {}); }
              // Chart telemetry: always-sampled span capturing what type the model chose
              if (event.name === 'render_chart' && event.args) {
                const chartArgs = event.args as Record<string, unknown>;
                const datasets = Array.isArray(chartArgs.datasets) ? chartArgs.datasets as any[] : [];
                const chartSpan = startSpan({
                  traceId: rootSpan.traceId,
                  parentSpanId: rootSpan.spanId,
                  workspaceId: wsId,
                  workspaceName: workspace?.name || wsId,
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
              await svc.saveMessage(null, 'tool', JSON.stringify(event.result), event.name, event.callId);
              io.to(wsChannel).emit('tool-result', { name: event.name, callId: event.callId, result: event.result });
              // Mark the step as completed
              const completedActivity = describeActivity(event.name, event.result as Record<string, unknown> || {});
              io.to(wsChannel).emit('ai-status', { step: completedActivity.step, label: completedActivity.label, state: 'completed' });
              // Audit: tool result (data_query for warehouse tools, tool_result for others)
              {
                const auditType = ['query_bigquery', 'query_snowflake', 'query_databricks'].includes(event.name) ? 'data_query' : 'tool_result';
                const { getAdapter: _ga } = require('../../db/adapter') as { getAdapter: () => DatabaseAdapter };
                _ga().audit(wsId, socket.userId, socket.username, auditType, event.name, {
                  resultPreview: JSON.stringify(event.result).substring(0, 200),
                }, socket.handshake?.address).catch(() => {});
              }
              // render_chart: inject chartBlock directly into the stream so the
              // frontend receives it as part of the response text, regardless of
              // whether the model decides to echo it back.
              if (event.name === 'render_chart' && event.result) {
                const chartResult = event.result as Record<string, unknown>;
                const block = (chartResult.chartBlock as string) || '';
                if (block) {
                  const injected = '\n' + block + '\n';
                  fullText += injected;
                  io.to(wsChannel).emit('ai-chunk', { content: injected, userId: socket.userId });
                }
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
              if (event.fullText) await svc.saveMessage(null, 'assistant', event.fullText);
              break;
          }
        }
      } catch (err: unknown) {
        const error = err as Error & { name: string };
        if (error.name !== 'AbortError') {
          console.error(`[Chat] AI stream error in workspace ${wsId}:`, error);
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
        workspaceProcessing.set(wsId, false);
        const queue = getQueue(wsId);
        if (queue.length > 0) {
          const next = queue.shift()!;
          io.to(wsChannel).emit('ai-queue-update', { queueLength: queue.length });
          console.log(`[Queue] Processing next request from ${next.socket.username} for workspace ${wsId} (${queue.length} remaining)`);
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
          const { getAdapter } = require('../../db/adapter') as { getAdapter: () => DatabaseAdapter };
          await getAdapter().recordUsage(
            wsId,
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
            const sig: string = crypto.createHmac('sha256', config.bridgeHmacSecret)
              .update(`${wsId}:${ts}`)
              .digest('hex');
            // Body-level v1 fields stay for a v1-only control plane; v2
            // headers (routePath 'usage-report', tenant-bound to this
            // workspace, body hash + nonce) ride alongside. SIGNING_SPEC.md.
            const usageBody = JSON.stringify({
              workspaceId: wsId,
              workspaceName: wsName || wsId,
              userId: socket.userId?.toString() || 'unknown',
              userName: socket.username || 'unknown',
              model: aiModel,
              tokens: usageData.totalTokens,
              isOverage,
              timestamp: ts,
              signature: sig,
            });
            const { signPathV2, emitV2 } = require('../../utils/s2sSig') as typeof import('../../utils/s2sSig');
            fetch(`${dashboardUrl}/api/usage-report/report`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(emitV2() ? signPathV2({ secret: config.bridgeHmacSecret, routePath: 'usage-report', body: usageBody, tenantWsId: wsId, timestamp: ts }).headers : {}),
              },
              body: usageBody,
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
    const queue = getQueue(wsId);
    const before = queue.length;
    const filtered = queue.filter(r => r.socket.id !== socket.id);
    if (filtered.length !== before) {
      workspaceQueues.set(wsId, filtered);
      console.log(`[Queue] Removed ${before - filtered.length} queued request(s) from disconnected user ${socket.username}`);
    }
  });
}

export { setupChatHandlers, buildAiTriggerPattern };
