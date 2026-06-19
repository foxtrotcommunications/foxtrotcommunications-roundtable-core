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

  // Build a lookup from workspace ID → friendly bridge name
  const bridgeNameLookup: Record<string, string> = {};
  try {
    const bridges = JSON.parse(process.env.RT_BRIDGES || '[]');
    for (const b of bridges) {
      if (b.targetWsId && b.targetName) {
        bridgeNameLookup[b.targetWsId] = b.targetName;
        bridgeNameLookup[b.targetWsId.toLowerCase()] = b.targetName;
        bridgeNameLookup[b.targetName.toLowerCase()] = b.targetName;
      }
    }
  } catch { /* intentionally empty */ }

  // ── Collect domain results with provenance ─────────────────
  const domains: Array<{
    name: string;
    capability: string;
    balance_coverage_pct: number;
    historical_coverage_pct: number | null;
    verified_amount: number;
    inferred_amount: number;
    accounts: Array<{
      account_id: string;
      current_balance: number;
      current_balance_verified: boolean;
      historical_series_verified: boolean;
    }>;
  }> = [];

  const accountNames: string[] = [];
  let totalExecutionMs = 0;
  let maxRoundTripMs = 0;
  let anyCached = false;
  let accountsAnalyzed = 0;
  let transactionsScanned = 0;

  // Aggregate provenance numbers
  let totalBalanceVerified = 0;
  let totalHistoricalVerified = 0;
  let totalBalance = 0;
  let totalAccounts = 0;
  let accountsWithHistory = 0;
  let latestSyncedAt: string | null = null;
  let isHistorical = false;

  for (const tr of intentResults) {
    const r = tr.result as any;
    if (!r?.success) continue;

    // Detect query type from capability name
    const cap = r.toolExecuted || r.capability || '';
    if (/getTransactions|getCashflow|getBalanceHistory|getSpending/i.test(cap)) {
      isHistorical = true;
    }

    // Extract domain info
    if (r.toolExecuted || r.capability) {
      // Resolve friendly name: try bridge lookup by target, then workspace ID patterns
      const rawTarget = r.target || '';
      const domainName = bridgeNameLookup[rawTarget] || bridgeNameLookup[rawTarget.toLowerCase()] || rawTarget || 'Unknown Domain';
      const capName = r.toolExecuted || r.capability;

      // Extract provenance from capability result
      const p = r.data?.provenance;
      const domainEntry: typeof domains[number] = {
        name: domainName,
        capability: capName,
        balance_coverage_pct: 100,
        historical_coverage_pct: null,
        verified_amount: 0,
        inferred_amount: 0,
        accounts: [],
      };

      if (p) {
        // Use structured provenance from domain tools
        totalBalanceVerified += p.balance_verified || 0;
        totalHistoricalVerified += p.historical_verified || 0;
        totalBalance += p.total_balance || 0;

        if (p.accounts && Array.isArray(p.accounts)) {
          totalAccounts += p.accounts.length;
          accountsWithHistory += p.accounts.filter((a: any) => a.historical_series_verified).length;
          domainEntry.accounts = p.accounts;
        }

        domainEntry.verified_amount = p.balance_verified || 0;
        domainEntry.inferred_amount = (p.total_balance || 0) - (p.historical_verified || 0);
        domainEntry.balance_coverage_pct = p.total_balance > 0
          ? Math.round((p.balance_verified / p.total_balance) * 100) : 100;
        domainEntry.historical_coverage_pct = p.total_balance > 0
          ? Math.round((p.historical_verified / p.total_balance) * 100) : null;

        if (p.last_synced && (!latestSyncedAt || p.last_synced > latestSyncedAt)) {
          latestSyncedAt = p.last_synced;
        }
      }

      domains.push(domainEntry);
    }

    // Extract account names
    const accountSources = r.data?.accounts || r.data?.balances;
    if (accountSources && Array.isArray(accountSources)) {
      for (const acct of accountSources) {
        const name = acct.name || acct.account_name;
        if (name && !accountNames.includes(name)) accountNames.push(name);
      }
    }

    // Count unique account_ids
    if (r.data && typeof r.data === 'object') {
      const seenIds = new Set<string>();
      for (const val of Object.values(r.data as Record<string, unknown>)) {
        if (Array.isArray(val)) {
          for (const item of val) {
            if (item && typeof item === 'object' && 'account_id' in (item as any)) {
              seenIds.add(String((item as any).account_id));
            }
          }
        }
      }
      if (seenIds.size > 0) accountsAnalyzed = Math.max(accountsAnalyzed, seenIds.size);
    }

    // Count transactions
    if (r.data?.transactions && Array.isArray(r.data.transactions)) {
      transactionsScanned += r.data.transactions.length;
    } else if (r.data?.count) {
      transactionsScanned += Number(r.data.count);
    }

    // Timing
    if (r.executionMs) totalExecutionMs += r.executionMs;
    if (r.roundTripMs) maxRoundTripMs = Math.max(maxRoundTripMs, r.roundTripMs);
    if (r.cached) anyCached = true;
  }

  // Fall back to roundTripMs
  if (totalExecutionMs === 0 && maxRoundTripMs > 0) totalExecutionMs = maxRoundTripMs;
  if (accountsAnalyzed === 0 && accountNames.length > 0) accountsAnalyzed = accountNames.length;

  // ── Extract alignment from emit_provenance tool results ──
  const emitResults = toolResults.filter(t => t.name === 'emit_provenance');
  let alignmentScore = 100; // default
  let alignmentPenalties: string[] = [];
  let claims: any[] = [];
  for (const er of emitResults) {
    const erResult = er.result as any;
    if (erResult?.alignment) {
      alignmentScore = erResult.alignment.score ?? 100;
      alignmentPenalties = erResult.alignment.penalties ?? [];
    }
    if (erResult?.claims) {
      claims = erResult.claims;
    }
  }

  // ── Compute three metrics ─────────────────────────────────

  // 1. Answer Coverage (balance-weighted, query-specific)
  const answerCoveragePct = totalBalance > 0
    ? Math.round((totalBalanceVerified / totalBalance) * 100) : 100;

  // 2. Historical Coverage (null for non-historical queries)
  const historicalCoveragePct = isHistorical && totalBalance > 0
    ? Math.round((totalHistoricalVerified / totalBalance) * 100) : null;

  // 3. Confidence (multi-factor with renormalization)
  // Freshness
  let freshness = 100;
  if (latestSyncedAt) {
    const ageMs = Date.now() - new Date(latestSyncedAt).getTime();
    const ageMinutes = ageMs / 60000;
    freshness = ageMinutes <= 5 ? 100 : ageMinutes <= 60 ? 90 : ageMinutes <= 360 ? 75 : ageMinutes <= 1440 ? 50 : 25;
  }

  // Historical support
  const historicalSupport = totalBalance > 0
    ? Math.round((totalHistoricalVerified / totalBalance) * 100) : 0;

  // Completeness
  const completeness = totalAccounts > 0
    ? Math.round((accountsWithHistory / totalAccounts) * 100) : 0;

  // Reconstruction quality (null for non-derived queries)
  const isReconstructed = isHistorical; // only for trend/cashflow queries
  const reconstruction: number | null = isReconstructed ? 80 : null; // base score, refined later

  // Weighted confidence with renormalization
  const factors: Array<{ value: number; weight: number }> = [
    { value: freshness, weight: 0.30 },
    { value: historicalSupport, weight: 0.30 },
    { value: completeness, weight: 0.15 },
    { value: alignmentScore, weight: 0.15 }, // provenance_alignment from emit_provenance claims
  ];
  if (reconstruction !== null) {
    factors.push({ value: reconstruction, weight: 0.10 });
  }
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const confidencePct = Math.round(
    factors.reduce((s, f) => s + f.value * (f.weight / totalWeight), 0)
  );

  return {
    domains,
    accounts: accountNames,
    accounts_analyzed: accountsAnalyzed,
    transactions_scanned: transactionsScanned,
    answer_coverage_pct: answerCoveragePct,
    portfolio_coverage_pct: totalBalance > 0 ? answerCoveragePct : undefined,
    historical_coverage_pct: historicalCoveragePct,
    confidence_pct: confidencePct,
    confidence_factors: {
      freshness,
      historical_support: historicalSupport,
      completeness,
      provenance_alignment: alignmentScore, // from emit_provenance claim classification
      reconstruction: reconstruction ?? undefined,
    },
    claims,
    alignment_penalties: alignmentPenalties,
    executionMs: totalExecutionMs,
    timestamp: new Date().toISOString(),
    cached: anyCached,
    // Backwards compat
    coverage_pct: answerCoveragePct,
    confidence: confidencePct >= 85 ? 'high' as const : confidencePct >= 60 ? 'medium' as const : 'low' as const,
    visible: [],
    assumptions: [],
    missing: [],
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
    let snapshotText = '';  // Captures text before post-response tool calls to prevent duplicates
    const toolResults: Array<{ name: string; result: Record<string, unknown> }> = [];

    // Add a 4-minute timeout to prevent indefinite hangs
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 240_000);

    try {
      const stream = streamCompletion(
        provider,
        model,
        messages,
        apiKey,
        true,       // enableTools
        controller.signal,
        enabledToolNames,
        workspaceConfig
      );

      for await (const event of stream) {
        if (event.type === 'text-delta') {
          fullText += event.content;
        } else if (event.type === 'tool-result') {
          toolResults.push({ name: event.name, result: event.result });
          // If we already have a substantial response and the model is doing
          // a follow-up tool call (e.g. emit_provenance after the main response),
          // snapshot the text so we don't append a duplicate response afterward.
          if (fullText.trim().length > 100) {
            snapshotText = fullText;
          }
        } else if (event.type === 'done') {
          // If we snapshotted text before a tool call, use the snapshot
          // to avoid duplicated responses from post-tool-call generation.
          if (snapshotText && event.fullText && event.fullText.length > snapshotText.length * 1.5) {
            fullText = snapshotText;
          } else {
            fullText = event.fullText || fullText;
          }
        } else if (event.type === 'error') {
          throw new Error(event.error);
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    // ── Retry on empty response ────────────────────────────────
    // If the AI did tool calls but produced no text (safety filter, model
    // refusal, or output token exhaustion), retry with a synthesis prompt.
    if (!fullText.trim() && toolResults.length > 0) {
      console.warn(`[A2A] Empty response after ${toolResults.length} tool calls — retrying with synthesis prompt`);

      // Build a concise summary of tool results for the retry
      const toolSummaries = toolResults.map(tr => {
        const r = tr.result as any;
        if (tr.name === 'intent_bridge' && r?.success) {
          const cap = r.toolExecuted || r.capability || 'unknown';
          const dataPreview = JSON.stringify(r.data).slice(0, 500);
          return `[${cap}]: ${dataPreview}`;
        }
        return `[${tr.name}]: ${JSON.stringify(tr.result).slice(0, 300)}`;
      }).join('\n\n');

      const retryMessages: ChatMessage[] = [
        ...messages,
        {
          role: 'assistant' as const,
          content: `I queried the following domains and received data:\n\n${toolSummaries}`,
        },
        {
          role: 'user' as const,
          content: 'Based on the data you just retrieved, please provide your analysis. Respond directly — do not make additional tool calls.',
        },
      ];

      const retryController = new AbortController();
      const retryTimeoutId = setTimeout(() => retryController.abort(), 60_000);

      try {
        const retryStream = streamCompletion(
          provider,
          model,
          retryMessages,
          apiKey,
          false,      // disable tools on retry
          retryController.signal,
          null,       // no tool names needed
          workspaceConfig
        );

        for await (const event of retryStream) {
          if (event.type === 'text-delta') {
            fullText += event.content;
            yield { type: 'text-delta', content: event.content };
          } else if (event.type === 'done') {
            fullText = event.fullText || fullText;
          }
        }
      } finally {
        clearTimeout(retryTimeoutId);
      }

      if (!fullText.trim()) {
        fullText = '⚠️ I retrieved your financial data but was unable to generate a response. This is typically caused by a temporary issue with the AI model. Please try asking your question again.';
        yield { type: 'text-delta', content: fullText };
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
