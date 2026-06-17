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

type A2aPart =
  | { type: 'text'; text: string }
  | { type: 'data'; data: unknown };

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
 * Extract structured provenance from tool results.
 * Captures which domains/capabilities were queried, accounts accessed, timing, etc.
 */
function extractProvenance(toolResults: Array<{ name: string; result: Record<string, unknown> }>) {
  const intentResults = toolResults.filter(t => t.name === 'intent_bridge');
  if (intentResults.length === 0) return null;

  const domains: { name: string; capability: string }[] = [];
  const accounts: string[] = [];
  let totalExecutionMs = 0;
  let maxRoundTripMs = 0;
  let anyCached = false;
  let accountsAnalyzed = 0;
  let transactionsScanned = 0;
  let dataFreshness: string | undefined;

  // ── Epistemic analysis ─────────────────────────────────────
  const assumptions: string[] = [];
  const missing: string[] = [];
  const visible: string[] = [];
  let totalExplanationPct = 0;
  let explanationSamples = 0;
  let institutionsConnected = 0;
  let hasCriticalUnknowns = false;

  for (const tr of intentResults) {
    const r = tr.result as any;
    if (!r?.success) continue;

    // Extract domain and capability from the tool result
    if (r.toolExecuted) {
      domains.push({
        name: r.target || 'Unknown Domain',
        capability: r.toolExecuted,
      });
    }

    // Extract account names from multiple possible locations
    const accountSources = r.data?.accounts || r.data?.balances;
    if (accountSources && Array.isArray(accountSources)) {
      for (const acct of accountSources) {
        const name = acct.name || acct.account_name;
        if (name && !accounts.includes(name)) {
          accounts.push(name);
        }
      }
    }

    // Also count unique account_id values in any arrays within r.data
    if (r.data && typeof r.data === 'object') {
      const seenAccountIds = new Set<string>();
      for (const val of Object.values(r.data as Record<string, unknown>)) {
        if (Array.isArray(val)) {
          for (const item of val) {
            if (item && typeof item === 'object' && 'account_id' in (item as any)) {
              seenAccountIds.add(String((item as any).account_id));
            }
          }
        }
      }
      if (seenAccountIds.size > 0) {
        accountsAnalyzed = Math.max(accountsAnalyzed, seenAccountIds.size);
      }
    }

    // Count transactions scanned — check metadata first, then data fields
    if (r.data?.metadata?.transactions_scanned) {
      transactionsScanned += Number(r.data.metadata.transactions_scanned);
    } else if (r.data?.transactions_scanned) {
      transactionsScanned += Number(r.data.transactions_scanned);
    } else if (r.data?.total_count) {
      transactionsScanned += Number(r.data.total_count);
    } else if (r.data?.transactions && Array.isArray(r.data.transactions)) {
      transactionsScanned += r.data.transactions.length;
    }

    // Accumulate timing
    if (r.executionMs) totalExecutionMs += r.executionMs;
    if (r.roundTripMs) maxRoundTripMs = Math.max(maxRoundTripMs, r.roundTripMs);
    if (r.cached) anyCached = true;

    // Data freshness
    if (!dataFreshness) {
      dataFreshness = r.data?.data_freshness || r.data?.metadata?.data_freshness || r.data?.last_sync || undefined;
    }

    // ── Coverage analysis from tool results ────────────────
    const cov = r.data?.coverage;
    if (cov) {
      // Institutional coverage
      if (cov.institutions_connected) {
        institutionsConnected = Math.max(institutionsConnected, cov.institutions_connected);
      }

      // Explanation completeness
      if (typeof cov.explanation_pct === 'number') {
        totalExplanationPct += cov.explanation_pct;
        explanationSamples++;
      }

      // Collect visible evidence
      if (Array.isArray(cov.visible)) {
        for (const v of cov.visible) {
          if (!visible.includes(v)) visible.push(v);
        }
      }

      // Collect gaps as assumptions
      if (Array.isArray(cov.gaps)) {
        for (const gap of cov.gaps) {
          if (!assumptions.includes(gap)) assumptions.push(gap);
        }
      }

      // Critical unknowns
      if (cov.has_payroll_pattern === false) {
        hasCriticalUnknowns = true;
        if (!missing.includes('Payroll deposit source')) {
          missing.push('Payroll deposit source');
          assumptions.push('Income figure may be incomplete — no regular payroll pattern detected');
        }
      }
      if (cov.institutions_connected && cov.institutions_connected <= 1) {
        if (!missing.includes('Other banking institutions (only 1 connected)')) {
          missing.push('Other banking institutions (only 1 connected)');
        }
      }
      if (cov.unclassified_large_charges > 0) {
        const msg = `Purpose of ${cov.unclassified_large_charges} large uncategorized charge(s)`;
        if (!missing.includes(msg)) missing.push(msg);
      }
    }
  }

  // Fall back to roundTripMs when executionMs is 0
  if (totalExecutionMs === 0 && maxRoundTripMs > 0) {
    totalExecutionMs = maxRoundTripMs;
  }

  // Use accounts list length if accountsAnalyzed wasn't set from account_id scanning
  if (accountsAnalyzed === 0 && accounts.length > 0) {
    accountsAnalyzed = accounts.length;
  }

  // ── Evidence-based confidence ──────────────────────────────
  // Derived from three dimensions:
  //   Coverage Quality (40%): how much institutional breadth
  //   Explanation Completeness (40%): can we explain observed activity
  //   Critical Unknowns (20%): are essential inputs (payroll) missing
  const avgExplanationPct = explanationSamples > 0
    ? Math.round(totalExplanationPct / explanationSamples)
    : 50; // default if no explanation data

  const institutionScore = Math.min(institutionsConnected / 2, 1) * 100;
  const explanationScore = avgExplanationPct;
  const criticalScore = hasCriticalUnknowns ? 0 : 100;

  const coveragePct = Math.round(
    institutionScore * 0.4 +
    explanationScore * 0.4 +
    criticalScore * 0.2
  );

  // Confidence: can I explain what I see?
  //   High:   >90% coverage
  //   Medium: 60-90%
  //   Low:    <60%
  let confidence: 'high' | 'medium' | 'low';
  if (coveragePct >= 90) confidence = 'high';
  else if (coveragePct >= 60) confidence = 'medium';
  else confidence = 'low';

  // Deduplicate
  const uniqueMissing = [...new Set(missing)];
  const uniqueAssumptions = [...new Set(assumptions)];

  return {
    domains,
    accounts,
    accounts_analyzed: accountsAnalyzed,
    transactions_scanned: transactionsScanned,
    coverage_pct: coveragePct,
    visible,
    executionMs: totalExecutionMs,
    timestamp: new Date().toISOString(),
    cached: anyCached,
    confidence,
    assumptions: uniqueAssumptions,
    missing: uniqueMissing,
    data_freshness: dataFreshness,
  };
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
    // 4. Stream completion and collect full text + tool provenance
    let fullText = '';
    const toolResults: Array<{ name: string; result: Record<string, unknown> }> = [];

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
      } else if (event.type === 'tool-result') {
        toolResults.push({ name: event.name, result: event.result });
      } else if (event.type === 'done') {
        fullText = event.fullText || fullText;
      } else if (event.type === 'error') {
        throw new Error(event.error);
      }
    }

    // Extract provenance from intent_bridge tool results
    const provenance = extractProvenance(toolResults);

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

    const artifacts: A2aTask['artifacts'] = [
      {
        name: 'response',
        parts: [{ type: 'text', text: fullText }],
      },
    ];

    // Include provenance as a structured artifact if available
    if (provenance) {
      artifacts.push({
        name: 'provenance',
        parts: [{ type: 'data', data: provenance }],
      });
    }

    task.artifacts = artifacts;

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
