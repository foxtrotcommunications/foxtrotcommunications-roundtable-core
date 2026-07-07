// server/protocols/intentExecutor.ts — Intent Token Direct Execution Engine
// Processes compiled intent tokens WITHOUT LLM inference by mapping
// intent operations directly to tool calls. Part of the Roundtable
// Intent Compilation Engine (ICE) Phase 2+.
//
// Phase 3.5 additions:
//   - Execution proofs (verifiable traces)
//   - Intent caching (hash-based LRU)
//   - SQL fusion compiler (aggregate optimization)

import type {
  IntentToken, IntentResult, IntentOperation,
  QueryIntent, ToolCallIntent, AggregateIntent, SchemaDiscoveryIntent,
  CapabilityIntent,
} from './intentToken';
import { capabilityRegistry } from './capabilityRegistry';
import type { CapabilityContext } from './capabilityRegistry';
import { iceCapabilityCall } from './iceClient';
import { validateIntent, intentOpToAction } from './intentToken';
import { signIntentResult } from './intentTokenCodec';
import { executeTool, resolveTools, getAvailableTools } from '../tools/index';
import { intentMetrics } from './intentMetrics';
import { buildProof, type PolicyCheck } from './executionProof';
import { intentCache } from './intentCache';
import { compileIntents } from './intentCompiler';

// ─── SQL Safety ─────────────────────────────────────────────────────────────

/** Blocked SQL patterns — mirrors queryBigQuery.ts to prevent data mutation */
const BLOCKED_SQL_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|MERGE|GRANT|REVOKE)\b/i,
  /\bINTO\s+/i,
];

// ─── Transport Actions ──────────────────────────────────────────────────────

/**
 * Actions that are always permitted regardless of contract allowedActions.
 * These are foundational transport/discovery operations.
 */
const ALWAYS_ALLOWED_ACTIONS = ['intent_execute', 'discover'];

// ─── Execution Context ──────────────────────────────────────────────────────

/** Context required for executing an intent token against a workspace */
export interface ExecutionContext {
  contractKey: Buffer;
  contract: { contractId: string; allowedActions: string[]; status: string };
  workspaceConfig: Record<string, unknown>;
  enabledToolNames: string[] | null;
}

// ─── Authorization ──────────────────────────────────────────────────────────

/**
 * Check whether the contract authorizes the given action.
 * Transport-level actions (intent_execute, discover) are always allowed.
 */
function isActionAuthorized(action: string, allowedActions: string[]): boolean {
  if (ALWAYS_ALLOWED_ACTIONS.includes(action)) {
    return true;
  }
  return allowedActions.includes(action);
}

// ─── SQL Validation ─────────────────────────────────────────────────────────

/**
 * Validate that a SQL string contains only read-only operations.
 * Returns an error message if the query is unsafe, undefined otherwise.
 *
 * Uses an allowlist (must begin with SELECT/WITH) plus a single-statement
 * check plus a keyword blocklist. The allowlist is the primary guard — a
 * blocklist alone is easy to slip past. None of this replaces the durable
 * control, which is a read-only database role at the connection level.
 */
function validateSqlSafety(sql: string): string | undefined {
  const trimmed = sql.trim();

  // Allowlist: a read-only query must begin with SELECT or WITH.
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    return 'Only read-only queries (SELECT/WITH) are allowed.';
  }

  // Reject stacked statements (e.g. "SELECT 1; DELETE FROM users"). A single
  // trailing semicolon is permitted; a semicolon followed by more SQL is not.
  if (/;\s*\S/.test(trimmed.replace(/;\s*$/, ''))) {
    return 'Only read-only queries (SELECT/WITH) are allowed. Multiple statements are not permitted.';
  }

  // Keyword blocklist as a second layer of defence.
  for (const pattern of BLOCKED_SQL_PATTERNS) {
    if (pattern.test(sql)) {
      return 'Only read-only queries (SELECT/WITH) are allowed. Blocked write operation detected.';
    }
  }
  return undefined;
}

// ─── Operation Executors ────────────────────────────────────────────────────

/**
 * Execute a query intent — validates SQL safety, then delegates to the tool.
 */
async function executeQuery(
  intent: QueryIntent,
  ctx: ExecutionContext,
  policyChecks: PolicyCheck[],
): Promise<{ data?: unknown; error?: string }> {
  // Validate SQL safety if a raw SQL string is provided
  if (intent.params.sql) {
    const sqlError = validateSqlSafety(intent.params.sql);
    if (sqlError) {
      policyChecks.push({ type: 'sql_safety', passed: false, detail: sqlError });
      return { error: sqlError };
    }
    policyChecks.push({ type: 'sql_safety', passed: true });
  }

  const data = await executeTool(intent.tool, intent.params, ctx.workspaceConfig);
  return { data };
}

/**
 * Execute a tool_call intent — verifies the tool exists, then invokes it.
 */
async function executeToolCall(
  intent: ToolCallIntent,
  ctx: ExecutionContext,
  policyChecks: PolicyCheck[],
): Promise<{ data?: unknown; error?: string }> {
  // Verify the tool exists in the resolved tool set
  const resolved = resolveTools(ctx.enabledToolNames);
  if (!(intent.tool in resolved)) {
    policyChecks.push({ type: 'tool_exists', passed: false, detail: `Tool '${intent.tool}' not found` });
    return { error: `Tool '${intent.tool}' is not available in this workspace` };
  }
  policyChecks.push({ type: 'tool_exists', passed: true, detail: intent.tool });

  const data = await executeTool(intent.tool, intent.args, ctx.workspaceConfig);
  return { data };
}

/**
 * Execute an aggregate intent — compiles steps through the SQL fusion
 * optimizer, then runs them sequentially and reduces results.
 */
async function executeAggregate(
  intent: AggregateIntent,
  ctx: ExecutionContext,
  policyChecks: PolicyCheck[],
): Promise<{ data?: unknown; error?: string; compilation?: IntentResult['compilation'] }> {
  // ── SQL Fusion Compiler Pass ──────────────────────────────────
  const compiled = compileIntents(intent.steps);
  const steps = compiled.optimized;

  const compilation = compiled.wasOptimized ? {
    fusionCount: compiled.fusionCount,
    deduplicationCount: compiled.deduplicationCount,
    limitInjections: compiled.limitInjections,
    originalStepCount: compiled.originalCount,
    optimizedStepCount: compiled.optimizedCount,
  } : undefined;

  // Track SQL fusion in metrics
  if (compiled.fusionCount > 0) {
    intentMetrics.recordSqlFusion(compiled.fusionCount);
  }

  const results: unknown[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let stepResult: { data?: unknown; error?: string };

    if (step.op === 'query') {
      stepResult = await executeQuery(step, ctx, policyChecks);
    } else {
      stepResult = await executeToolCall(step as ToolCallIntent, ctx, policyChecks);
    }

    if (stepResult.error) {
      return { error: `Aggregate step ${i} failed: ${stepResult.error}` };
    }

    results.push(stepResult.data);
  }

  // Reduce based on the reduce strategy
  let data: unknown;
  switch (intent.reduce) {
    case 'concat':
      data = results;
      break;
    case 'merge':
      data = results.reduce<Record<string, unknown>>((acc, r) => {
        return Object.assign(acc, r);
      }, {});
      break;
    case 'last':
      data = results[results.length - 1];
      break;
    default:
      return { error: `Unknown reduce strategy: '${intent.reduce}'` };
  }

  return { data, compilation };
}

/**
 * Execute a discover intent — returns workspace capabilities metadata.
 */
async function executeDiscover(
  intent: SchemaDiscoveryIntent,
): Promise<{ data?: unknown; error?: string }> {
  switch (intent.scope) {
    case 'tools':
      return { data: getAvailableTools() };
    case 'tables':
      return { data: { message: 'Table discovery not yet implemented' } };
    case 'capabilities':
      return { data: { capabilities: capabilityRegistry.getManifest() } };
    default:
      return { error: `Unknown discover scope: '${intent.scope}'` };
  }
}

/**
 * Execute a capability intent — validates input, runs the handler,
 * and supports internal ICE hops via the CapabilityContext.
 */
async function executeCapability(
  intent: CapabilityIntent,
  ctx: ExecutionContext,
  policyChecks: PolicyCheck[],
): Promise<{ data?: unknown; error?: string }> {
  if (!capabilityRegistry.has(intent.name)) {
    policyChecks.push({ type: 'capability_exists', passed: false, detail: `Capability '${intent.name}' not found` });
    return { error: `Capability '${intent.name}' is not registered in this workspace` };
  }
  policyChecks.push({ type: 'capability_exists', passed: true, detail: intent.name });

  // Build the capability context with an ICE client for internal hops
  const masterSecret = (ctx.workspaceConfig as Record<string, string>).ORG_MASTER_SECRET || '';
  const capCtx: CapabilityContext = {
    executionCtx: ctx,
    iceCall: async (targetUrl, contractId, capabilityName, input) => {
      return iceCapabilityCall(targetUrl, contractId, capabilityName, input, masterSecret);
    },
  };

  return capabilityRegistry.execute(intent.name, intent.input, capCtx);
}

// ─── Main Executor ──────────────────────────────────────────────────────────

/**
 * Execute a compiled intent token directly without LLM inference.
 *
 * Flow:
 *   1. Validate intent structure
 *   2. Authorize action against contract
 *   3. Check intent cache → return cached result if hit
 *   4. Dispatch to operation executor (with SQL fusion for aggregates)
 *   5. Build execution proof (verifiable trace)
 *   6. Cache successful result
 *   7. Return signed result with proof
 */
export async function executeIntentToken(
  token: IntentToken,
  ctx: ExecutionContext,
): Promise<IntentResult> {
  const startTime = Date.now();
  const policyChecks: PolicyCheck[] = [];

  try {
    // 1. Validate the intent is well-formed
    const validation = validateIntent(token.intent);
    if (!validation.valid) {
      return buildResult(token, ctx, startTime, policyChecks, {
        status: 'error',
        error: `Invalid intent: ${validation.error}`,
      });
    }

    // 2. Authorize the action against the contract BEFORE any cache lookup.
    //    The intent cache is keyed by intent alone, not by contract, so a cache
    //    hit must never be served to a caller whose contract does not authorize
    //    the action — otherwise one contract could read results it is not
    //    permitted to request. Authorizing first closes that gap.
    const action = intentOpToAction(token.intent);
    const authorized = isActionAuthorized(action, ctx.contract.allowedActions);
    policyChecks.push({
      type: 'action_auth',
      passed: authorized,
      detail: `Action '${action}' ${authorized ? 'authorized' : 'denied'} by contract '${ctx.contract.contractId}'`,
    });

    if (!authorized) {
      return buildResult(token, ctx, startTime, policyChecks, {
        status: 'denied',
        error: `Action '${action}' is not authorized by contract '${ctx.contract.contractId}'`,
      });
    }

    // 3. Check intent cache (only reached once the action is authorized)
    const cached = intentCache.get(token.intent);
    if (cached) {
      intentMetrics.record(cached.toolExecuted || 'cache_hit', 0, true);
      intentMetrics.recordCacheHit();
      // Re-sign the cached result with current token ID and timestamp
      return buildResult(token, ctx, startTime, policyChecks, {
        status: 'success',
        data: cached.data,
        toolExecuted: cached.toolExecuted,
        cached: true,
      });
    }

    // 4. Dispatch to the appropriate operation executor
    let result: { data?: unknown; error?: string; compilation?: IntentResult['compilation'] };
    let toolExecuted: string | undefined;

    switch (token.intent.op) {
      case 'query': {
        const intent = token.intent as QueryIntent;
        toolExecuted = intent.tool;
        result = await executeQuery(intent, ctx, policyChecks);
        break;
      }
      case 'tool_call': {
        const intent = token.intent as ToolCallIntent;
        toolExecuted = intent.tool;
        result = await executeToolCall(intent, ctx, policyChecks);
        break;
      }
      case 'aggregate': {
        const intent = token.intent as AggregateIntent;
        toolExecuted = 'aggregate';
        result = await executeAggregate(intent, ctx, policyChecks);
        break;
      }
      case 'discover': {
        const intent = token.intent as SchemaDiscoveryIntent;
        toolExecuted = 'discover';
        result = await executeDiscover(intent);
        break;
      }
      case 'capability': {
        const intent = token.intent as CapabilityIntent;
        toolExecuted = `capability:${intent.name}`;
        result = await executeCapability(intent, ctx, policyChecks);
        break;
      }
      default:
        return buildResult(token, ctx, startTime, policyChecks, {
          status: 'error',
          error: `Unsupported intent op: '${(token.intent as any).op}'`,
        });
    }

    // 5. Handle execution errors from the tool
    if (result.error) {
      return buildResult(token, ctx, startTime, policyChecks, {
        status: 'error',
        error: result.error,
        toolExecuted,
      });
    }

    // 6. Build result (with proof, caching, and compilation stats)
    const intentResult = buildResult(token, ctx, startTime, policyChecks, {
      status: 'success',
      data: result.data,
      toolExecuted,
      compilation: result.compilation,
    });

    // 7. Cache the successful result
    intentCache.set(token.intent, intentResult);

    return intentResult;
  } catch (err: unknown) {
    // Catch unexpected errors during execution
    const message = err instanceof Error ? err.message : String(err);
    return buildResult(token, ctx, startTime, policyChecks, {
      status: 'error',
      error: `Execution failed: ${message}`,
    });
  }
}

// ─── Result Builder ─────────────────────────────────────────────────────────

interface ResultFields {
  status: 'success' | 'error' | 'denied';
  data?: unknown;
  error?: string;
  toolExecuted?: string;
  cached?: boolean;
  compilation?: IntentResult['compilation'];
}

/**
 * Build and sign an IntentResult with execution proof and metrics.
 */
function buildResult(
  token: IntentToken,
  ctx: ExecutionContext,
  startTime: number,
  policyChecks: PolicyCheck[],
  fields: ResultFields,
): IntentResult {
  const executionMs = Date.now() - startTime;

  // Record metrics — compiled tokens are the ones flowing through this executor
  if (fields.toolExecuted) {
    intentMetrics.record(fields.toolExecuted, executionMs, true);
  }

  // Build execution proof for successful executions
  let proof: import('./executionProof').ExecutionProof | undefined;
  if (fields.status === 'success' || fields.status === 'denied') {
    proof = buildProof(
      token.intent,
      fields.data,
      fields.toolExecuted || 'unknown',
      executionMs,
      ctx.contract.contractId,
      ctx.contractKey,
      policyChecks,
    );
  }

  const unsigned: Omit<IntentResult, 'signature'> = {
    version: 1,
    type: 'intent_result',
    tokenId: token.id,
    status: fields.status,
    executionMs,
    timestamp: new Date().toISOString(),
    ...(fields.data !== undefined ? { data: fields.data } : {}),
    ...(fields.error ? { error: fields.error } : {}),
    ...(fields.toolExecuted ? { toolExecuted: fields.toolExecuted } : {}),
    ...(fields.cached ? { cached: true } : {}),
    ...(proof ? { proof } : {}),
    ...(fields.compilation ? { compilation: fields.compilation } : {}),
  };

  return signIntentResult(unsigned, ctx.contractKey);
}
