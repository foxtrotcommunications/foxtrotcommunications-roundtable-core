// @ts-nocheck
// server/tools/bridgeWorkspace.js — Bridge tool: communicate with connected workspaces
//
// Enables the AI to send messages or delegate tasks to other workspaces
// via the A2A (Agent-to-Agent) protocol. Direct workspace-to-workspace.
//
// Transport: A2A JSON-RPC (message/send) → target workspace's /a2a endpoint.
// The wake proxy handles sleeping workspaces automatically.

const config = require('../config');
import crypto from 'crypto';
import {  fetchManifest  } from '../utils/fetchManifest';

import type { Tool } from '../types';
// @ts-ignore


const bridgeWorkspace: Tool = {
  name: 'bridge_workspace',
  description:
    'Delegate a reasoning task to another workspace\'s AI via its bridge. ' +
    'Use this ONLY when you need the other AI to reason, analyze, or synthesize — not for structured data or tool calls (use intent_bridge for those). ' +
    'NEVER relay a user\'s message verbatim. YOU decide when delegation is necessary based on the user\'s request. ' +
    'The user should not need to say "ask X" or "send this to Y" — you handle routing transparently.',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Name or ID of the target workspace to delegate to. Must be connected via a bridge.',
      },
      action: {
        type: 'string',
        enum: ['delegate'],
        description:
          'delegate: ask the target workspace\'s AI to perform a reasoning task and return the result. ' +
          'Use only when you need subjective analysis, creative synthesis, or judgment that no capability or query can provide.',
      },
      content: {
        type: 'string',
        description: 'The task description for the target AI. Frame this as YOUR request to the other AI, not as a relay of the user\'s words.',
      },
    },
    required: ['target', 'action', 'content'],
  },

  async execute(args: any, _workspaceConfig: any = {}, _context?: any) {
    const { target, action, content } = args;

    if (!target || !action || !content) {
      return { error: 'target, action, and content are required' };
    }

    // Read bridge manifest dynamically (falls back to env if control plane is down)
    const manifest = await fetchManifest();
    const bridges = manifest.RT_BRIDGES;

    if (!bridges || !bridges.length) {
      return {
        error: 'No bridges configured for this workspace. Ask an admin to create a bridge in the dashboard.',
      };
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

    // ── Contract enforcement (required) ────────────────────────
    // No contract = no activity. Bridges are connectivity only.
    const contracts = manifest.RT_CONTRACTS;
    let contract = null;
    if (contracts && Array.isArray(contracts)) {
      try {
        contract = contracts.find(
          (c) =>
            c.direction === 'outbound' &&
            c.counterparty.wsId === bridge.targetWsId &&
            c.status === 'active'
        );
      } catch { /* intentionally empty */ }
    }

    if (!contract) {
      return {
        error: `No active governance contract with "${bridge.targetName}". A contract must be approved before any cross-workspace activity.`,
      };
    }

    // Verify the action is allowed by the contract
    if (!contract.allowedActions || !contract.allowedActions.includes(action)) {
      return {
        error: `Action "${action}" is not permitted by the contract with "${bridge.targetName}". Allowed: ${(contract.allowedActions || []).join(', ')}`,
      };
    }

    // Resolve target workspace URL for direct A2A communication
    const targetUrl = bridge.targetUrl;
    if (!targetUrl) {
      return {
        error: `No A2A endpoint configured for "${bridge.targetName}". Contact an administrator.`,
      };
    }



    // ── A2A Direct Communication ──────────────────────────────
    // Send directly to target workspace's A2A endpoint via the wake proxy.
    // The wake proxy auto-wakes sleeping workspaces on HTTP requests.
    const taskId = crypto.randomUUID();
    const _sourceName = config.workspaceName || config.workspaceId;

    try {
      const a2aEndpoint = `${targetUrl.replace(/\/$/, '')}/a2a`;
      const headers = { 'Content-Type': 'application/json' };

      if (contract && process.env.ORG_MASTER_SECRET) {
        // Contract-based HKDF auth — cryptographic proof of valid contract
        const { deriveContractKey, signRequest, encryptPayload   } = require('../utils/contractAuth');
        const timestamp = Date.now().toString();
        const contractKey = await deriveContractKey(
          process.env.ORG_MASTER_SECRET,
          contract.contractId,
          contract.version || 1
        );
        const signature = signRequest(contractKey, contract.contractId, timestamp, action);

        headers['X-Contract-Id'] = contract.contractId;
        headers['X-Contract-Signature'] = signature;
        headers['X-Contract-Timestamp'] = timestamp;
        headers['X-Contract-Action'] = action;

        // E2E encrypt the message payload — only the target workspace can decrypt
        const encrypted = encryptPayload(contractKey, { text: content });
        headers['X-Contract-Encrypted'] = 'aes-256-gcm';

        const doFetch = () => {
          const ts = Date.now().toString();
          return fetch(a2aEndpoint, {
          method: 'POST',
          headers: {
            ...headers,
            'X-Contract-Timestamp': ts,
            'X-Contract-Signature': signRequest(contractKey, contract.contractId, ts, action),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: taskId,
            method: 'message/send',
            params: {
              message: {
                role: 'user',
                parts: [{
                  type: 'text',
                  text: '__ENCRYPTED__',
                  encrypted: {
                    iv: encrypted.iv,
                    ciphertext: encrypted.ciphertext,
                    authTag: encrypted.authTag,
                  },
                }],
              },
            },
          }),
          signal: AbortSignal.timeout(action === 'delegate' ? 120000 : 30000),
        });
        };

        const response = await doFetch();
        return await this._handleA2aResponse(response, bridge, action, content, taskId, doFetch);
      }

      if (bridge.a2aApiKey) {
        // Fallback: API key auth (no E2E encryption — TLS only)
        headers['x-api-key'] = bridge.a2aApiKey;
      }

      const doFetch = () => fetch(a2aEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: taskId,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ type: 'text', text: content }],
            },
          },
        }),
        signal: AbortSignal.timeout(action === 'delegate' ? 120000 : 30000),
      });

      const response = await doFetch();

      return await this._handleA2aResponse(response, bridge, action, content, taskId, doFetch);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { error: `Bridge communication timed out after ${action === 'delegate' ? '120' : '30'} seconds` };
      }
      return { error: `Bridge communication failed: ${err.message}` };
    }
  },

  /**
   * Handle A2A response — shared by encrypted and unencrypted paths.
   */
  async _handleA2aResponse(response, bridge, action, content, taskId, fetchFn?: () => Promise<Response>) {
    // ── Wake-on-request: retry if workspace is sleeping ──────
    if (response.status === 503 && fetchFn) {
      const isSleeping = await this._detectSleepingWorkspace(response);

      if (isSleeping) {
        console.log(`[bridge_workspace] ${bridge.targetName} is sleeping — waking and retrying (up to 120s)`);

        // Scale the target deployment from 0 → 1 via K8s API
        try {
          const fs = require('fs');
          const https = require('https');
          const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim();
          const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
          const namespace = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
          const depName = `rt-ws-${bridge.targetWsId.slice(0, 12).toLowerCase()}`;
          const payload = JSON.stringify({ spec: { replicas: 1 } });
          const apiHost = process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
          const apiPort = process.env.KUBERNETES_SERVICE_PORT || '443';

          await new Promise<void>((resolve) => {
            const req = https.request({
              hostname: apiHost, port: Number(apiPort),
              path: `/apis/apps/v1/namespaces/${namespace}/deployments/${depName}`,
              method: 'PATCH', ca, rejectUnauthorized: true,
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/strategic-merge-patch+json',
                'Content-Length': Buffer.byteLength(payload),
              },
            }, (res) => {
              let data = '';
              res.on('data', (c) => data += c);
              res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                  console.log(`[bridge_workspace] Scaled ${depName} → 1 replica`);
                } else {
                  console.error(`[bridge_workspace] Scale failed: ${res.statusCode}`);
                }
                resolve();
              });
            });
            req.on('error', () => resolve());
            req.write(payload);
            req.end();
          });
        } catch (err: any) {
          console.error(`[bridge_workspace] Wake error: ${err.message}`);
        }

        const wakeStart = Date.now();
        const MAX_WAKE_WAIT = 120_000;
        const RETRY_INTERVAL = 5_000;

        while (Date.now() - wakeStart < MAX_WAKE_WAIT) {
          await new Promise((r) => setTimeout(r, RETRY_INTERVAL));

          try {
            response = await fetchFn();
            const elapsed = Math.round((Date.now() - wakeStart) / 1000);
            if (response.ok) {
              console.log(`[bridge_workspace] ${bridge.targetName} is awake after ${elapsed}s`);
              break;
            } else {
              console.log(`[bridge_workspace] Retry at ${elapsed}s → HTTP ${response.status}`);
            }
          } catch (retryErr: any) {
            const elapsed = Math.round((Date.now() - wakeStart) / 1000);
            console.log(`[bridge_workspace] Retry at ${elapsed}s failed: ${retryErr.message}`);
          }
        }

        if (!response.ok) {
          return {
            error: `${bridge.targetName} did not respond after ${MAX_WAKE_WAIT / 1000}s. The workspace may still be starting up — try again in a moment.`,
            workspaceWaking: true,
          };
        }
      }
    }

    if (!response.ok) {
      const body = await response.text();
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
  },

  /**
   * Detect if a 503 response indicates a sleeping workspace.
   */
  async _detectSleepingWorkspace(response) {
    try {
      const body = await response.clone().text();
      if (body.includes('"waking"')) return true;
      if (body.includes('503 Service Temporarily Unavailable')) return true;
      return false;
    } catch {
      return false;
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
    } catch (err: any) {
      return { error: `Bridge communication failed: ${err.message}` };
    }
  },
};

export default bridgeWorkspace;
