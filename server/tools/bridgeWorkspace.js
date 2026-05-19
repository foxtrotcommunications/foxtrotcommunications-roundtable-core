// server/tools/bridgeWorkspace.js — Bridge tool: communicate with connected workspaces
//
// Enables the AI to send messages or delegate tasks to other workspaces
// via the control plane relay. Async — returns a task ID for polling.
//
// Auth: HMAC signature using SESSION_SECRET (same key as the control plane).

const config = require('../config');
const crypto = require('crypto');

const bridgeWorkspace = {
  name: 'bridge_workspace',
  description:
    'Send a message or delegate a task to a connected workspace via a bridge. ' +
    'Bridges are bidirectional connections between workspaces — like VPC peering for AI. ' +
    'Use "message" to post a chat message to the other workspace. ' +
    'Use "delegate" to ask the other workspace\'s AI to perform a task and return the result. ' +
    'Delegation is async — you will receive a task ID. The result will appear when the target workspace completes it.',
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

    // Relay via control plane with HMAC auth
    const controlPlaneUrl = process.env.CONTROL_PLANE_URL || 'https://roundtable.foxtrotcommunications.net';
    const wsId = config.workspaceId;
    const orgSlug = process.env.ORG_SLUG || '';
    const secret = config.sessionSecret || '';

    // HMAC signature: HMAC-SHA256(SESSION_SECRET, wsId:timestamp)
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
        };
      }

      if (action === 'delegate') {
        return {
          success: true,
          message: `Task delegated to ${bridge.targetName}. Task ID: ${result.taskId}. The target workspace's AI is processing your request.`,
          taskId: result.taskId,
          status: 'pending',
        };
      }

      return result;
    } catch (err) {
      return { error: `Bridge communication failed: ${err.message}` };
    }
  },
};

module.exports = bridgeWorkspace;
