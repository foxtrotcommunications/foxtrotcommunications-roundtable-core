// server/tools/bridgeWorkspace.js — Bridge tool: communicate with connected workspaces
//
// Enables the AI to send messages or delegate tasks to other workspaces
// via the A2A (Agent-to-Agent) protocol. Direct workspace-to-workspace.
//
// Transport: A2A JSON-RPC (message/send) → target workspace's /a2a endpoint.
// The wake proxy handles sleeping workspaces automatically.

const config = require('../config');
const crypto = require('crypto');

const bridgeWorkspace = {
  name: 'bridge_workspace',
  description:
    'Send a message or delegate a task to a connected workspace via its bridge. ' +
    'Bridges are governed connections between workspaces — every request follows your organization\'s contracts. ' +
    'Use "message" to post a chat message to the other workspace. ' +
    'Use "delegate" to ask the other workspace\'s AI to perform a task and return the result.',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Name or ID of the target workspace to communicate with. Must be connected via a bridge.',
      },
      action: {
        type: 'string',
        enum: ['message', 'delegate'],
        description:
          'message: post a chat message to the target workspace. ' +
          'delegate: ask the target workspace\'s AI to perform a task and return the result.',
      },
      content: {
        type: 'string',
        description: 'The message text or task description to send to the target workspace.',
      },
    },
    required: ['target', 'action', 'content'],
  },

  async execute(args) {
    const { target, action, content } = args;

    if (!target || !action || !content) {
      return { error: 'target, action, and content are required' };
    }

    // Read bridge manifest from env (injected by dashboard on pod start)
    const manifest = process.env.RT_BRIDGES;
    if (!manifest) {
      return {
        error: 'No bridges configured for this workspace. Ask an admin to create a bridge in the dashboard.',
      };
    }

    let bridges;
    try {
      bridges = JSON.parse(manifest);
    } catch {
      return { error: 'Invalid bridge manifest' };
    }

    // Find the bridge for the target workspace
    const bridge = bridges.find(
      (b) =>
        b.targetName.toLowerCase() === target.toLowerCase() ||
        b.targetWsId === target ||
        b.bridgeId === target
    );

    if (!bridge) {
      const available = bridges.map((b) => b.targetName).join(', ');
      return {
        error: `No bridge found for "${target}". Available bridges: ${available || 'none'}`,
      };
    }

    // Check permission
    if (!bridge.permissions.includes(action)) {
      return {
        error: `Bridge to "${bridge.targetName}" does not allow "${action}". Allowed: ${bridge.permissions.join(', ')}`,
      };
    }

    // Resolve target workspace URL for direct A2A communication
    const targetUrl = bridge.targetUrl;
    if (!targetUrl) {
      // Fallback: legacy relay via control plane (backward compat)
      return await this._legacyRelay(bridge, action, content);
    }

    // ── A2A Direct Communication ──────────────────────────────
    // Send directly to target workspace's A2A endpoint via the wake proxy.
    // The wake proxy auto-wakes sleeping workspaces on HTTP requests.
    const taskId = crypto.randomUUID();
    const sourceName = config.workspaceName || config.workspaceId;

    try {
      const a2aEndpoint = `${targetUrl.replace(/\/$/, '')}/a2a`;
      const headers = { 'Content-Type': 'application/json' };

      // Auth: use the bridge API key if available
      if (bridge.a2aApiKey) {
        headers['x-api-key'] = bridge.a2aApiKey;
      }

      const messageText = action === 'delegate'
        ? `[Delegated from ${sourceName}] ${content}`
        : `[Message from ${sourceName}] ${content}`;

      const response = await fetch(a2aEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: taskId,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ type: 'text', text: messageText }],
            },
          },
        }),
        signal: AbortSignal.timeout(action === 'delegate' ? 120000 : 30000),
      });

      if (!response.ok) {
        const body = await response.text();
        // If A2A endpoint unavailable, try legacy relay
        if (response.status === 404 || response.status === 502 || response.status === 503) {
          console.warn(`[Bridge] A2A endpoint unavailable (${response.status}), falling back to relay`);
          return await this._legacyRelay(bridge, action, content);
        }
        return { error: `Bridge communication failed: ${response.status} ${body.slice(0, 200)}` };
      }

      const result = await response.json();

      // Extract response text from A2A task result
      let responseText = '';
      if (result?.result) {
        const task = result.result;
        if (task.artifacts && task.artifacts.length > 0) {
          for (const artifact of task.artifacts) {
            for (const part of (artifact.parts || [])) {
              if (part.type === 'text') responseText += part.text;
            }
          }
        }
        // Fallback: check status message
        if (!responseText && task.status?.message?.parts) {
          for (const part of task.status.message.parts) {
            if (part.type === 'text') responseText += part.text;
          }
        }
      }

      if (action === 'message') {
        return {
          success: true,
          message: `Message delivered to ${bridge.targetName} via A2A`,
          taskId,
          protocol: 'a2a',
        };
      }

      if (action === 'delegate') {
        return {
          success: true,
          message: `Task completed by ${bridge.targetName}`,
          taskId,
          response: responseText || 'Task completed (no text response)',
          protocol: 'a2a',
        };
      }

      return result;
    } catch (err) {
      // Network error — try legacy relay as fallback
      if (err.name === 'AbortError') {
        return { error: `Bridge communication timed out after ${action === 'delegate' ? '120' : '30'} seconds` };
      }
      console.warn(`[Bridge] A2A direct failed (${err.message}), falling back to relay`);
      return await this._legacyRelay(bridge, action, content);
    }
  },

  /**
   * Legacy relay via control plane — backward compatibility for workspaces
   * that don't have A2A enabled yet.
   */
  async _legacyRelay(bridge, action, content) {
    const controlPlaneUrl = process.env.CONTROL_PLANE_URL || 'https://roundtable.foxtrotcommunications.net';
    const wsId = config.workspaceId;
    const secret = config.sessionSecret || '';

    const timestamp = Date.now().toString();
    const signature = crypto.createHmac('sha256', secret).update(`${wsId}:${timestamp}`).digest('hex');

    try {
      const response = await fetch(`${controlPlaneUrl}/api/bridges/relay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Signature': signature,
          'X-Bridge-Timestamp': timestamp,
          'X-Bridge-WsId': wsId,
        },
        body: JSON.stringify({
          bridgeId: bridge.bridgeId,
          action,
          content,
          sourceWsId: wsId,
          orgId: bridge.orgId || '',
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const body = await response.text();
        return { error: `Bridge relay failed: ${response.status} ${body.slice(0, 200)}` };
      }

      const result = await response.json();

      if (action === 'message') {
        return {
          success: true,
          message: `Message sent to ${bridge.targetName}`,
          taskId: result.taskId,
          protocol: 'legacy-relay',
        };
      }

      if (action === 'delegate') {
        return {
          success: true,
          message: `Task delegated to ${bridge.targetName}. Task ID: ${result.taskId}.`,
          taskId: result.taskId,
          status: 'pending',
          protocol: 'legacy-relay',
        };
      }

      return result;
    } catch (err) {
      return { error: `Bridge communication failed: ${err.message}` };
    }
  },
};

module.exports = bridgeWorkspace;
