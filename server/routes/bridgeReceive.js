// server/routes/bridgeReceive.js — Receives bridged messages/tasks from the control plane
//
// POST /api/bridge/receive
// Auth: HMAC signature verification using SESSION_SECRET
//
// When a bridged message arrives:
// 1. Verify HMAC signature
// 2. Save the message to local DB with source_workspace_id
// 3. Broadcast to connected WebSocket clients
// 4. For 'delegate' action: invoke AI, return result to control plane

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const workspaceService = require('../services/workspaceService');

const router = express.Router();

router.post('/receive', async (req, res) => {
  try {
    const { taskId, bridgeId, action, content, sourceWorkspace, timestamp, signature } = req.body;

    // Verify HMAC signature
    const secret = config.sessionSecret;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${taskId}:${timestamp}`)
      .digest('hex');

    if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return res.status(401).json({ error: 'Invalid bridge signature' });
    }

    // Check timestamp freshness (5 min window)
    if (Math.abs(Date.now() - parseInt(timestamp)) > 5 * 60 * 1000) {
      return res.status(401).json({ error: 'Bridge timestamp expired' });
    }

    console.log(`[Bridge] Received ${action} from ${sourceWorkspace.name} (${sourceWorkspace.id}): ${content.slice(0, 100)}`);

    // Save incoming message to local DB with source workspace attribution
    const bridgeUser = null; // system-level message
    const savedMessage = await workspaceService.saveMessage(
      bridgeUser,
      'user',
      `[Bridge from ${sourceWorkspace.name}] ${content}`,
      null,
      null,
      sourceWorkspace.id
    );

    // Broadcast to connected clients so they see the bridged message
    if (global._io) {
      const wsChannel = `ws:${config.workspaceId}`;
      global._io.to(wsChannel).emit('new-message', {
        ...savedMessage,
        bridged: true,
        sourceWorkspace: sourceWorkspace.name,
      });
    }

    if (action === 'message') {
      // Simple message relay — already saved and broadcast, done
      // Report completion to the control plane
      await reportTaskComplete(taskId, timestamp, secret, {
        result: `Message delivered to ${config.workspaceName}`,
      });
      return res.json({ success: true, action: 'message_delivered' });
    }

    if (action === 'delegate') {
      // AI delegation — process the task asynchronously
      res.json({ success: true, action: 'delegation_started' });

      // Process in background
      processDelegation(taskId, timestamp, secret, content, sourceWorkspace).catch(err => {
        console.error('[Bridge] Delegation error:', err);
        reportTaskComplete(taskId, timestamp, secret, { error: err.message });
      });
      return;
    }

    res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[Bridge] receive error:', err);
    res.status(500).json({ error: 'Bridge receive failed' });
  }
});

/**
 * Process an AI delegation task.
 * Invokes the workspace's AI with the delegated content,
 * then reports the result back to the control plane.
 */
async function processDelegation(taskId, timestamp, secret, content, sourceWorkspace) {
  const { streamCompletion } = require('../services/aiProvider');

  const workspace = await workspaceService.getWorkspace();
  const aiProvider = workspace?.ai_provider || 'vertexai';
  const aiModel = workspace?.ai_model || 'gemini-2.5-flash';

  // Build minimal context for delegation
  const messages = [
    {
      role: 'system',
      content: `You are the AI assistant for the "${config.workspaceName}" workspace. You've received a delegated task from the "${sourceWorkspace.name}" workspace via a bridge. Process the task and provide a clear, complete response. The requesting workspace is waiting for your result.`,
    },
    {
      role: 'user',
      content: `[Delegated from ${sourceWorkspace.name}] ${content}`,
    },
  ];

  let fullText = '';
  const abortController = new AbortController();

  // 60 second timeout
  const timeout = setTimeout(() => abortController.abort(), 60000);

  try {
    for await (const event of streamCompletion(
      aiProvider, aiModel, messages, '', true,
      abortController.signal, null, {}
    )) {
      if (event.type === 'text-delta') {
        fullText += event.content;
      }
      if (event.type === 'done' && event.fullText) {
        fullText = event.fullText;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  // Save AI response to local DB
  await workspaceService.saveMessage(null, 'assistant', fullText, null, null, sourceWorkspace.id);

  // Broadcast result to local clients
  if (global._io) {
    const wsChannel = `ws:${config.workspaceId}`;
    global._io.to(wsChannel).emit('new-message', {
      role: 'assistant',
      content: fullText,
      bridged: true,
      sourceWorkspace: sourceWorkspace.name,
      delegationResult: true,
    });
  }

  // Report completion to control plane
  await reportTaskComplete(taskId, timestamp, secret, { result: fullText });
  console.log(`[Bridge] Delegation complete for task ${taskId}: ${fullText.slice(0, 100)}...`);
}

/**
 * Report task completion back to the control plane.
 */
async function reportTaskComplete(taskId, timestamp, secret, data) {
  const controlPlaneUrl = process.env.CONTROL_PLANE_URL || 'https://roundtable.foxtrotcommunications.net';
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${taskId}:${timestamp}`)
    .digest('hex');

  try {
    await fetch(`${controlPlaneUrl}/api/bridges/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        signature,
        timestamp,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error(`[Bridge] Failed to report task ${taskId}:`, err.message);
  }
}

module.exports = router;
