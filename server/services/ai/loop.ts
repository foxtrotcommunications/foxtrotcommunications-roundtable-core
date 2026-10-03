// server/services/ai/loop.ts — Tool-loop machinery shared by every provider:
// allowlisted tool execution, the per-turn circuit breaker, and the compose
// nudge. Bodies moved verbatim from aiProvider.ts (Phase 6.1 split).
import type { ToolProfile, WorkspaceConfig } from '../../types';

const { executeTool } = require('../../tools') as {
  executeTool: (name: string, args: Record<string, unknown>, config?: Record<string, unknown>, options?: { enabledToolNames?: string[] | null; profile?: ToolProfile }) => Promise<Record<string, unknown>>;
};

/**
 * Execute a model-requested tool under the workspace's allowlist. The
 * registry enforces the profile (tools/index.ts executeTool); a denial —
 * ToolNotEnabled, or a tool name the model invented — is handed back to the
 * model as an error RESULT rather than thrown, so one hallucinated call does
 * not turn the whole turn into a stream error. The message matches
 * NON_TRANSIENT_PATTERNS so the breaker blocks that name for the rest of the
 * turn instead of letting the model retry it.
 */
export async function runWorkspaceTool(
  name: string,
  args: Record<string, unknown>,
  cfg: WorkspaceConfig & Record<string, unknown>,
  enabledToolNames: string[] | null,
): Promise<Record<string, unknown>> {
  try {
    return await executeTool(name, args, cfg, { enabledToolNames, profile: cfg.toolProfile });
  } catch (err: unknown) {
    const e = err as Error & { code?: string };
    if (e?.code === 'TOOL_NOT_ENABLED' || /^Unknown tool:/.test(e?.message || '')) {
      return { error: e.message, code: e.code || 'UNKNOWN_TOOL' };
    }
    throw err;
  }
}

// ─── Fail-fast constants and helpers ────────────────────
const MAX_TOOL_FAILURES = 3;
const PERM_FAIL = 999;

/** Patterns that indicate a non-transient (permanent) error — retrying won't help. */
const NON_TRANSIENT_PATTERNS = [
  'Contract signature invalid',
  'Contract rejected',
  'contract_rejected',
  'signature_invalid',
  // Bridge / capability resolution failures. These cannot succeed on retry
  // within a turn — the target or capability simply does not exist here. Left
  // transient, a model that hallucinates a target (e.g. bridging to a
  // non-existent "financial_plan") retries it across tool rounds, re-composing
  // its full answer each round (user sees the report duplicated). Marking them
  // permanent blocks the bad key after the first attempt — per-target, so
  // healthy domains are unaffected.
  'No bridge found',
  'is not registered in this workspace',
  'is not available in this workspace',
  // Tool-profile denials (tools/index.ts ToolNotEnabled) and invented tool
  // names: the allowlist does not change mid-turn, so retrying is pointless.
  'is not enabled in this workspace',
  'Unknown tool:',
];
const NON_TRANSIENT_STATUS_CODES = [401, 403];

function isNonTransientError(resultStr: string): boolean {
  for (const pat of NON_TRANSIENT_PATTERNS) {
    if (resultStr.includes(pat)) return true;
  }
  // Check for HTTP status codes in common error shapes
  for (const code of NON_TRANSIENT_STATUS_CODES) {
    if (resultStr.includes(`"status":${code}`) || resultStr.includes(`"status": ${code}`)
        || resultStr.includes(`"statusCode":${code}`) || resultStr.includes(`"statusCode": ${code}`)
        || resultStr.includes(`(${code})`) || resultStr.includes(`status ${code}`)) {
      return true;
    }
  }
  return false;
}

function isToolError(result: Record<string, unknown>): boolean {
  return !!(result.error || result.errors || (result as Record<string, unknown>).message?.toString().toLowerCase().includes('error'));
}

/**
 * Check a tool result for errors and update the failure map.
 * Returns the number of failures for this tool after the check.
 */
export function checkToolResult(toolName: string, result: Record<string, unknown>, toolFailures: Map<string, { count: number; lastError: string }>, fineKey?: string | null): number {
  const resultStr = JSON.stringify(result);
  if (!isToolError(result)) return 0; // success — don't reset count, just don't increment

  if (isNonTransientError(resultStr)) {
    // Action-level contract rejections ("Contract rejected: Action X not
    // permitted") poison only that ACTION — the target workspace is healthy
    // and the model should be free to retry with a valid tool. Recording them
    // at the target key disabled the whole domain after one hallucinated
    // action name. Target-resolution failures ("No bridge found", etc.) still
    // block the whole target — that protection prevents duplicated-answer
    // retry loops (see NON_TRANSIENT_PATTERNS comment).
    const isActionRejection = /Contract rejected: Action/.test(resultStr) || /not permitted by contract/.test(resultStr);
    const key = (fineKey && isActionRejection) ? fineKey : toolName;
    const entry = toolFailures.get(key) || { count: 0, lastError: '' };
    entry.count = PERM_FAIL;
    entry.lastError = resultStr.slice(0, 500);
    toolFailures.set(key, entry);
    console.warn(`[aiProvider] Tool '${key}' permanently failed (non-transient): ${entry.lastError.slice(0, 200)}`);
    return PERM_FAIL;
  }

  const entry = toolFailures.get(toolName) || { count: 0, lastError: '' };
  entry.count += 1;
  entry.lastError = resultStr.slice(0, 500);
  toolFailures.set(toolName, entry);
  if (entry.count >= MAX_TOOL_FAILURES) {
    console.warn(`[aiProvider] Tool '${toolName}' has failed ${entry.count} times — will not be retried`);
  }
  return entry.count;
}

/** Build a human-readable error message to inject as a tool result when a tool is blocked. */
export function blockedToolMessage(toolName: string, toolFailures: Map<string, { count: number; lastError: string }>): string {
  const entry = toolFailures.get(toolName);
  const reason = entry && entry.count >= PERM_FAIL
    ? `permanently failed due to a non-transient error`
    : `failed ${entry?.count ?? '?'} times (max ${MAX_TOOL_FAILURES})`;
  return `Tool "${toolName}" has been disabled because it ${reason}. Last error: ${entry?.lastError || 'unknown'}. Do NOT call this tool again — answer the user with the information you already have, or explain what went wrong.`;
}

/**
 * Circuit-breaker key for a tool call. Every cross-workspace call uses the tool
 * name "intent_bridge", so keying the failure counter on the bare name lets a
 * few unreachable targets trip the breaker (MAX_TOOL_FAILURES) and block calls
 * to *healthy* targets for the rest of the turn. Scope the key by target
 * workspace so each domain fails (and is blocked) independently.
 */
export function breakerKey(toolName: string, rawArgs: unknown): string {
  if (toolName !== 'intent_bridge') return toolName;
  let a: any = rawArgs;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { return toolName; }
  }
  const target = a && (a.target ?? a.targetWorkspace ?? a.workspace);
  return target ? `intent_bridge:${target}` : toolName;
}

/**
 * Finer-grained breaker key including the specific action (op + tool/
 * capability name). Used to record action-level contract rejections so one
 * hallucinated action name doesn't disable an otherwise-healthy target.
 */
export function fineBreakerKey(toolName: string, rawArgs: unknown): string | null {
  if (toolName !== 'intent_bridge') return null;
  let a: any = rawArgs;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { return null; }
  }
  const target = a && (a.target ?? a.targetWorkspace ?? a.workspace);
  if (!target) return null;
  const op = a.op ?? '';
  const detail = a.tool ?? a.name ?? a.capability ?? '';
  return `intent_bridge:${target}#${op}:${detail}`;
}

/**
 * Fail-fast lookup across both breaker tiers. Returns the key that tripped,
 * or null if the call may proceed.
 */
export function trippedBreakerKey(
  toolName: string,
  rawArgs: unknown,
  toolFailures: Map<string, { count: number; lastError: string }>,
): string | null {
  const coarse = breakerKey(toolName, rawArgs);
  if ((toolFailures.get(coarse)?.count ?? 0) >= MAX_TOOL_FAILURES) return coarse;
  const fine = fineBreakerKey(toolName, rawArgs);
  if (fine && (toolFailures.get(fine)?.count ?? 0) >= MAX_TOOL_FAILURES) return fine;
  return null;
}

/**
 * Length of real user-facing prose in a response: strips chart fences (charts
 * are also often rendered via the render_chart TOOL, in which case they aren't
 * in the text at all) and the follow-ups comment.
 */
export function proseLength(fullText: string): number {
  return fullText
    .replace(/```chart[\s\S]*?```/g, '')          // charts (fenced)
    .replace(/```[a-z]*\s*[\s\S]*?```/g, '')       // any other fenced block
    .replace(/<tool_call[\s\S]*?<\/tool_call>/gi, '') // inline emit_provenance/render_chart-as-text
    .replace(/<!--[\s\S]*?-->/g, '')                // follow-ups comment
    .trim().length;
}

export const COMPOSE_NUDGE =
  'You rendered charts/data but have not written your analysis yet. Write the COMPLETE written financial analysis for the user NOW — findings, numbers, tables, and recommendations — followed by the follow_ups comment. Do not call any more tools.';
