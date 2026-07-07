// server/a2a/server.ts — A2A server implementation (JSON-RPC 2.0 over HTTP)
//
// Implements the Agent-to-Agent protocol without an external SDK.
// The protocol is simple JSON-RPC 2.0:
//   GET  /.well-known/agent.json  → return agent card
//   POST /a2a                     → JSON-RPC methods: message/send, tasks/get, tasks/cancel
//
import type { StreamEvent, ChatMessage, WorkspaceConfig } from '../types';
import type { Span } from '../tracing';

const { startSpan, endSpan, spanFromHeaders, generateTraceId, preview } = require('../tracing') as typeof import('../tracing');
const { recordSpan } = require('../tracing/collector') as typeof import('../tracing/collector');

const crypto = require('crypto');
const config = require('../config') as import('../types').AppConfig;
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

// ─── Step Log Labels (mirrored from chatHandler.ts) ────────
function describeActivity(toolName: string, args: Record<string, unknown>): { step: string; label: string } {
  if (toolName === 'intent_bridge' || toolName === 'bridge_workspace') {
    const target = (args.targetWorkspace || args.target || 'workspace') as string;
    const wsLabels: Record<string, string> = {
      'Retirement': 'Analyzing retirement accounts',
      'Investments': 'Reviewing investments',
      'Checking & Savings': 'Checking cash flow',
      'Debt Management': 'Evaluating debt obligations',
      'Real Estate': 'Reviewing real estate holdings',
      'Taxes': 'Considering tax implications',
      'Demographics': 'Reviewing your profile',
    };
    return { step: target, label: wsLabels[target] || `Consulting ${target}` };
  }
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
  const humanized = toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return { step: toolName, label: humanized };
}

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
  /** Incoming HTTP request headers for trace context propagation */
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Extract structured provenance from tool results.
 * Captures which domains/capabilities were queried, accounts accessed, timing, etc.
 */
export function extractProvenance(toolResults: Array<{ name: string; result: Record<string, unknown> }>) {
  const intentResults = toolResults.filter(t => t.name === 'intent_bridge');
  const emitOnlyResults = toolResults.filter(t => t.name === 'emit_provenance');

  // If no intent_bridge AND no emit_provenance results, no provenance to extract
  if (intentResults.length === 0 && emitOnlyResults.length === 0) return null;

  // If no intent_bridge but we have emit_provenance, build minimal provenance
  if (intentResults.length === 0 && emitOnlyResults.length > 0) {
    const emitData = emitOnlyResults[0].result as any;
    const ep = emitData || {};
    // Build provenance from emit_provenance args (domainsConsulted, assumptions, etc.)
    const domainsConsulted = ep.domainsConsulted || ep.domains_consulted || [];
    const toolCallCount = ep.toolCallCount || ep.tool_call_count || 0;
    const dataFreshMinutes = ep.dataFreshMinutes ?? ep.data_fresh_minutes ?? 0;
    const claims = ep.claims || [];
    const alignment = ep.alignment || {};

    // Compute freshness from data age
    const freshness = dataFreshMinutes <= 5 ? 100 : dataFreshMinutes <= 60 ? 90 : dataFreshMinutes <= 360 ? 75 : 50;
    const alignmentScore = alignment.score ?? 100;
    const confidencePct = Math.round(freshness * 0.5 + alignmentScore * 0.5);

    return {
      domains: domainsConsulted.map((d: string) => ({
        name: d,
        capability: 'query',
        balance_coverage_pct: 100,
        historical_coverage_pct: null,
        verified_amount: 0,
        inferred_amount: 0,
        accounts: [],
      })),
      accounts: [],
      accounts_analyzed: 0,
      transactions_scanned: ep.transactionsScanned || 0,
      answer_coverage_pct: 100,
      confidence_pct: confidencePct,
      confidence_factors: {
        freshness,
        historical_support: 0,
        completeness: 0,
        provenance_alignment: alignmentScore,
      },
      claims,
      alignment_penalties: alignment.penalties || [],
      executionMs: 0,
      timestamp: new Date().toISOString(),
      cached: false,
      coverage_pct: 100,
      confidence: confidencePct >= 85 ? 'high' as const : confidencePct >= 60 ? 'medium' as const : 'low' as const,
      visible: [],
      assumptions: ep.assumptions || [],
      missing: ep.missingDomains || [],
    };
  }

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

  // ── Lookup coverage ────────────────────────────────────────
  // Failed cross-workspace lookups were previously dropped on the floor here
  // (`if (!success) continue`), which made confidence blind to missing
  // domains: an answer that admitted "domain X did not respond" still scored
  // 100%. Track attempted vs. failed target:capability pairs so coverage can
  // feed the confidence score. A key that fails once but succeeds on a later
  // attempt (transient error + retry) is not counted as failed.
  const attemptedLookups = new Set<string>();
  const succeededLookups = new Set<string>();
  const failedLookupLabels = new Map<string, string>();

  for (const tr of intentResults) {
    const r = tr.result as any;

    // Self-bridge guidance results are not lookups; skip accounting.
    if (!r?.skipped) {
      const lookupTarget: string =
        r?.target ||
        (typeof r?.error === 'string' ? (r.error.match(/No bridge found for "([^"]+)"/)?.[1] || '') : '');
      const lookupCap: string = r?.toolExecuted || r?.capability || r?.tool || '';
      const lookupKey = `${lookupTarget || 'unknown'}:${lookupCap || 'call'}`;
      attemptedLookups.add(lookupKey);
      if (r?.success) {
        succeededLookups.add(lookupKey);
      } else {
        const label = lookupTarget && lookupCap
          ? `${lookupTarget} (${lookupCap})`
          : lookupTarget || lookupCap || (typeof r?.error === 'string' ? r.error.slice(0, 80) : 'unknown lookup');
        failedLookupLabels.set(lookupKey, label);
      }
    }

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
        // Inferred = the portion of the balance NOT directly verified from
        // source. Institution balances are fully verified, so this is 0 for a
        // pure balance query. (The previous formula subtracted
        // historical_verified, which is 0 for non-historical calls and made
        // inferred wrongly equal the whole balance.)
        domainEntry.inferred_amount = Math.max(0, (p.total_balance || 0) - (p.balance_verified || 0));
        domainEntry.balance_coverage_pct = p.total_balance > 0
          ? Math.round((p.balance_verified / p.total_balance) * 100) : 100;
        domainEntry.historical_coverage_pct = p.total_balance > 0
          ? Math.round((p.historical_verified / p.total_balance) * 100) : null;

        if (p.last_synced && (!latestSyncedAt || p.last_synced > latestSyncedAt)) {
          latestSyncedAt = p.last_synced;
        }
      }

      // Skip pure transport/discovery capabilities — they carry no financial
      // data and would render as $0/$0 noise rows in the provenance footer.
      const isTransport = /(^|:|\.)(discover|verify_workspace|describe_workspace)$/i.test(capName);
      if (!isTransport) domains.push(domainEntry);
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

  // Lookup coverage: fraction of attempted cross-workspace lookups that
  // ultimately succeeded. Distinct target:capability keys; a later success
  // for the same key clears an earlier failure.
  const effectiveFailedLookups = [...failedLookupLabels.keys()].filter(k => !succeededLookups.has(k));
  const lookupAttemptCount = attemptedLookups.size;
  const lookupSuccessPct = lookupAttemptCount > 0
    ? Math.round(((lookupAttemptCount - effectiveFailedLookups.length) / lookupAttemptCount) * 100)
    : 100;

  // Weighted confidence — only include factors relevant to the query
  const factors: Array<{ value: number; weight: number; key: string }> = [
    { value: freshness, weight: 0.35, key: 'freshness' },
    { value: alignmentScore, weight: 0.25, key: 'alignment' },
  ];

  // Lookup coverage always weighs in when at least one cross-workspace lookup
  // was attempted — a failed domain/capability must dent confidence even when
  // every claim that WAS made is verified. (This is what previously allowed
  // "Demographics did not respond" to coexist with a 100% confidence badge.)
  if (lookupAttemptCount > 0) {
    factors.push({ value: lookupSuccessPct, weight: 0.30, key: 'lookup' });
  }

  // Only include historical support if this is a historical query OR accounts have history
  if (isHistorical || accountsWithHistory > 0) {
    factors.push({ value: historicalSupport, weight: 0.25, key: 'historical' });
  }

  // Only include completeness if we actually have accounts to measure against
  if (totalAccounts > 0 && isHistorical) {
    factors.push({ value: completeness, weight: 0.15, key: 'completeness' });
  }

  // Reconstruction quality only for derived/trend queries
  if (reconstruction !== null) {
    factors.push({ value: reconstruction, weight: 0.10, key: 'reconstruction' });
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
      // Historical support and completeness measure verified-history coverage
      // of the accounts touched. They are only meaningful (and only feed the
      // weighted confidence above) when the query is historical — reporting
      // them as 0 for a scoped balance question made the UI show "0%
      // completeness" beside a 100% confidence. Omit them when they were not
      // factors in the confidence calculation.
      historical_support: (isHistorical || accountsWithHistory > 0) ? historicalSupport : undefined,
      completeness: (totalAccounts > 0 && isHistorical) ? completeness : undefined,
      provenance_alignment: alignmentScore, // from emit_provenance claim classification
      lookup_success: lookupAttemptCount > 0 ? lookupSuccessPct : undefined,
      reconstruction: reconstruction ?? undefined,
    },
    claims,
    // Human-readable labels for lookups that never succeeded this turn —
    // lets the UI show WHY confidence was docked, not just that it was.
    failed_lookups: effectiveFailedLookups.map(k => failedLookupLabels.get(k)),
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
  const { message, provider, model, apiKey, enabledToolNames, workspaceConfig, systemPrompt, headers } = options;

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  // ── Distributed tracing: extract incoming context or start a new trace ──
  const traceCtx = headers ? spanFromHeaders(headers) : null;
  const messageText = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  const rootSpan = startSpan({
    traceId: traceCtx?.traceId || generateTraceId(),
    parentSpanId: traceCtx?.parentSpanId || null,
    workspaceId: config.workspaceId || '',
    workspaceName: config.workspaceName || '',
    operation: 'a2a.message_send',
    inputPreview: preview(messageText),
    sampled: traceCtx?.sampled,
  });

  // Attach trace context to workspaceConfig so tools can propagate it
  const tracedWorkspaceConfig = {
    ...workspaceConfig,
    traceContext: {
      traceId: rootSpan.traceId,
      spanId: rootSpan.spanId,
      sampled: rootSpan._sampled,
    },
  };

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

  // Track tool call count at function scope so it's available in the catch block
  let toolCallCount = 0;

  try {
    // 4. Stream completion and collect full text + tool provenance
    let fullText = '';
    let snapshotText = '';  // Captures text before post-response tool calls to prevent duplicates
    const toolResults: Array<{ name: string; result: Record<string, unknown> }> = [];
    const injectedChartBlocks: string[] = [];  // Chart blocks injected from render_chart — tracked separately so they survive the done handler's fullText overwrite

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
        tracedWorkspaceConfig
      );

      const wsChannel = `ws:${config.workspaceId}`;
      const io = (global as any)._io;
      let firstTextChunk = true;

      for await (const event of stream) {
        if (event.type === 'text-delta') {
          fullText += event.content;
          // First text chunk — AI is composing
          if (firstTextChunk && io) {
            io.to(wsChannel).emit('ai-status', { step: 'composing', label: 'Composing response', state: 'active' });
            firstTextChunk = false;
          }
        } else if (event.type === 'tool-call') {
          // Emit step log: tool call starting
          if (io && event.name) {
            const activity = describeActivity(event.name, (event as any).args || {});
            io.to(wsChannel).emit('ai-status', { step: activity.step, label: activity.label, state: 'active' });
          }
        } else if (event.type === 'tool-result') {
          // ── Distributed tracing: record child span for each tool result ──
          const toolSpan = startSpan({
            traceId: rootSpan.traceId,
            parentSpanId: rootSpan.spanId,
            workspaceId: rootSpan.workspaceId,
            workspaceName: rootSpan.workspaceName,
            operation: 'tool_call',
            toolName: event.name,
            sampled: rootSpan._sampled,
          });
          endSpan(toolSpan, 'completed', { outputPreview: preview(event.result) });
          recordSpan(toolSpan);

          toolResults.push({ name: event.name, result: event.result });
          toolCallCount++;

          // Emit step log: tool call completed
          if (io && event.name) {
            const completedActivity = describeActivity(event.name, (event.result as Record<string, unknown>) || {});
            io.to(wsChannel).emit('ai-status', { step: completedActivity.step, label: completedActivity.label, state: 'completed' });
          }

          // render_chart: inject chartBlock directly into fullText so the
          // A2A response includes the chart block, regardless of whether
          // the model echoes it back in its text output.
          if (event.name === 'render_chart' && event.result) {
            const chartResult = (typeof event.result === 'string' ? JSON.parse(event.result) : event.result) as Record<string, unknown>;
            const block = (chartResult.chartBlock as string) || '';
            if (block) {
              injectedChartBlocks.push(block);
            }
          }

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
          // Re-append any injected chart blocks that were wiped by the fullText overwrite
          for (const block of injectedChartBlocks) {
            if (!fullText.includes(block)) {
              fullText = block + '\n' + fullText;
            }
          }
          // Mark composing as done
          if (io) {
            io.to(wsChannel).emit('ai-status', { step: 'composing', label: 'Composing response', state: 'completed' });
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
          tracedWorkspaceConfig
        );

        for await (const event of retryStream) {
          if (event.type === 'text-delta') {
            fullText += event.content;
          } else if (event.type === 'done') {
            fullText = event.fullText || fullText;
          }
        }
      } finally {
        clearTimeout(retryTimeoutId);
      }

      if (!fullText.trim()) {
        fullText = '⚠️ I retrieved your financial data but was unable to generate a response. This is typically caused by a temporary issue with the AI model. Please try asking your question again.';
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

    // ── Distributed tracing: end root span on success ──
    endSpan(rootSpan, 'completed', {
      outputPreview: preview(fullText),
      metadata: { toolCallCount: toolResults.length, provider, model },
    });
    recordSpan(rootSpan);
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

    // ── Distributed tracing: end root span on error (always recorded) ──
    endSpan(rootSpan, 'error', {
      outputPreview: preview(error.message),
      metadata: { toolCallCount },
    });
    recordSpan(rootSpan);
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

// NOTE: this CJS export object overrides any `export` statements above under
// the tsx/ts-jest CJS transforms — new exports must be added HERE.
module.exports = { processMessage, getTask, cancelTask, taskStore, extractProvenance };
