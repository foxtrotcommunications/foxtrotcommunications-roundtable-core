// server/a2a/server.ts — A2A server implementation (JSON-RPC 2.0 over HTTP)
//
// Implements the Agent-to-Agent protocol without an external SDK.
// The protocol is simple JSON-RPC 2.0:
//   GET  /.well-known/agent.json  → return agent card
//   POST /a2a                     → JSON-RPC methods: message/send, tasks/get, tasks/cancel
//
import type { StreamEvent, ChatMessage, WorkspaceConfig } from '../types';

const crypto = require('crypto');
const { streamCompletion } = require('../services/aiProvider') as {
  streamCompletion: (
    provider: string,
    model: string,
    messages: ChatMessage[],
    apiKey: string,
    enableTools: boolean,
    signal: AbortSignal | null,
    enabledToolNames: string[] | null,
    workspaceConfig: WorkspaceConfig
  ) => AsyncGenerator<StreamEvent>;
};

// ─── A2A Task Types ────────────────────────────────────────

interface A2aPart {
  type: 'text';
  text: string;
}

interface A2aMessage {
  role: 'user' | 'agent';
  parts: A2aPart[];
}

interface A2aArtifact {
  name?: string;
  parts: A2aPart[];
}

type TaskStatus = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled';

interface A2aTask {
  id: string;
  status: {
    state: TaskStatus;
    message?: A2aMessage;
    timestamp: string;
  };
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
}

// ─── In-Memory Task Store ──────────────────────────────────

const taskStore = new Map<string, A2aTask>();

// Clean up completed tasks older than 1 hour to prevent memory leaks
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, task] of taskStore) {
    const ts = new Date(task.status.timestamp).getTime();
    if (ts < cutoff && (task.status.state === 'completed' || task.status.state === 'failed' || task.status.state === 'canceled')) {
      taskStore.delete(id);
    }
  }
}, 10 * 60 * 1000); // Run every 10 min

// ─── Process Message ───────────────────────────────────────

interface ProcessMessageOptions {
  message: A2aMessage;
  provider: string;
  model: string;
  apiKey: string;
  enabledToolNames: string[] | null;
  workspaceConfig: WorkspaceConfig;
  systemPrompt?: string;
}

/**
 * Process an incoming A2A message: create a task, run AI completion, return result.
 */
async function processMessage(options: ProcessMessageOptions): Promise<A2aTask> {
  const { message, provider, model, apiKey, enabledToolNames, workspaceConfig, systemPrompt } = options;

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  // 1. Create task with status 'submitted'
  const task: A2aTask = {
    id: taskId,
    status: {
      state: 'submitted',
      timestamp: now,
    },
    history: [message],
  };
  taskStore.set(taskId, task);

  // 2. Set status to 'working'
  task.status = {
    state: 'working',
    timestamp: new Date().toISOString(),
  };

  // 3. Build messages array
  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  // Convert A2A message parts to a single user message
  const userText = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');

  messages.push({ role: 'user', content: userText });

  try {
    // 4. Stream completion and collect full text
    let fullText = '';
    const stream = streamCompletion(
      provider,
      model,
      messages,
      apiKey,
      true,       // enableTools
      null,       // signal
      enabledToolNames,
      workspaceConfig
    );

    for await (const event of stream) {
      if (event.type === 'text-delta') {
        fullText += event.content;
      } else if (event.type === 'done') {
        fullText = event.fullText || fullText;
      } else if (event.type === 'error') {
        throw new Error(event.error);
      }
    }

    // 5. Set status to 'completed' with result as an artifact
    const agentMessage: A2aMessage = {
      role: 'agent',
      parts: [{ type: 'text', text: fullText }],
    };

    task.status = {
      state: 'completed',
      message: agentMessage,
      timestamp: new Date().toISOString(),
    };

    task.artifacts = [
      {
        name: 'response',
        parts: [{ type: 'text', text: fullText }],
      },
    ];

    if (task.history) {
      task.history.push(agentMessage);
    }
  } catch (err: unknown) {
    const error = err as Error;
    task.status = {
      state: 'failed',
      message: {
        role: 'agent',
        parts: [{ type: 'text', text: `Error: ${error.message}` }],
      },
      timestamp: new Date().toISOString(),
    };
  }

  return task;
}

/**
 * Get a task by ID from the in-memory store.
 */
function getTask(taskId: string): A2aTask | undefined {
  return taskStore.get(taskId);
}

/**
 * Cancel a task by ID (only if it's still working).
 */
function cancelTask(taskId: string): A2aTask | null {
  const task = taskStore.get(taskId);
  if (!task) return null;

  if (task.status.state === 'working' || task.status.state === 'submitted') {
    task.status = {
      state: 'canceled',
      timestamp: new Date().toISOString(),
    };
  }

  return task;
}

module.exports = { processMessage, getTask, cancelTask, taskStore };
