// server/sockets/chat/consult.ts — `@ai-{workspace}` bridge delegation: the
// user addresses another workspace's AI directly and the turn is handed to
// bridge_workspace under the active outbound contract. Body moved verbatim
// from chatHandler.ts (Phase 6.2 split); every path inside returned from the
// send-message handler, so the caller awaits this and returns.
import type { Server } from 'socket.io';
import type { RoundtableSocket, WorkspaceConfig, AppConfig } from '../../types';
import { ACTION } from '../../vocab/actions';

const config = require('../../config') as AppConfig;
const { describeActivity } = require('../../a2a/appHooks') as typeof import('../../a2a/appHooks');

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

export async function handleBridgeDelegation(
  io: Server,
  socket: RoundtableSocket,
  svc: { saveMessage(userId: number | null, role: string, content: string): Promise<unknown> },
  wsId: string,
  wsName: string,
  wsChannel: string,
  content: string,
  bridgeMention: RegExpMatchArray,
): Promise<void> {
  const targetName: string = bridgeMention[1];
  // Strip the @ai-workspace from the content to get the actual message
  const bridgeContent: string = content.replace(/@ai-[\w-]+\s*/i, '').trim();

  if (!bridgeContent) {
    socket.emit('error-message', { error: `What would you like to ask ${targetName}? e.g. @ai-${targetName} review this query` });
    return;
  }

  // Check if a bridge exists for this workspace (tenant-keyed manifest)
  const manifestData = await (require('../../utils/fetchManifest') as { fetchManifest: (wsId?: string) => Promise<any> }).fetchManifest(wsId);
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
  const bridgeAction: string = allowedActions.includes(ACTION.delegate) ? ACTION.delegate : allowedActions.includes(ACTION.message) ? ACTION.message : allowedActions[0] || ACTION.message;

  io.to(wsChannel).emit('ai-start', { userId: socket.userId, username: socket.username });
  io.to(wsChannel).emit('tool-call', {
    name: 'bridge_workspace',
    args: { target: bridge.targetName, action: bridgeAction, content: bridgeContent },
    callId: `bridge-${Date.now()}`,
  });
  const bridgeActivity = describeActivity('bridge_workspace', { target: bridge.targetName });
  io.to(wsChannel).emit('ai-status', { step: bridgeActivity.step, label: bridgeActivity.label, state: 'active' });

  try {
    const bridgeMod = require('../../tools/bridgeWorkspace');
    const bridgeTool = (bridgeMod.default || bridgeMod) as {
      execute: (args: Record<string, unknown>, workspaceConfig?: WorkspaceConfig) => Promise<BridgeToolResult>;
    };
    // Sender contract: the tool must know WHICH tenant is bridging —
    // its manifest, its name, and (pooled) its org's master secret.
    const bridgeWorkspaceConfig: WorkspaceConfig = {
      workspaceId: wsId,
      workspaceName: wsName,
      ...(config.pooled ? { tenant: { workspaceId: wsId, orgId: manifestData.orgId ?? null } } : {}),
    };
    const result: BridgeToolResult = await bridgeTool.execute({
      target: bridge.targetName,
      action: bridgeAction,
      content: bridgeContent,
    }, bridgeWorkspaceConfig);

    const callId: string = `bridge-${Date.now()}`;
    io.to(wsChannel).emit('tool-result', {
      name: 'bridge_workspace',
      callId,
      result,
    });
    io.to(wsChannel).emit('ai-status', { step: bridgeActivity.step, label: bridgeActivity.label, state: 'completed' });

    const responseText: string = result.error
      ? `❌ Bridge to ${bridge.targetName} failed: ${result.error}`
      : `🔗 Task delegated to **${bridge.targetName}**. Task ID: \`${result.taskId}\`\n\nThe ${bridge.targetName} workspace's AI is processing your request. Results will appear here when complete.`;

    await svc.saveMessage(null, 'assistant', responseText);
    io.to(wsChannel).emit('ai-chunk', { content: responseText, userId: socket.userId });
    io.to(wsChannel).emit('ai-complete', { fullText: responseText, userId: socket.userId });
  } catch (err: unknown) {
    const error = err as Error;
    io.to(wsChannel).emit('ai-error', { error: `Bridge delegation failed: ${error.message}` });
  } finally {
    socket.isGenerating = false;
    socket.abortController = null;
  }
}
