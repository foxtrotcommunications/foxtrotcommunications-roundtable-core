// @ts-nocheck
// server/tools/financialPlan.ts — Financial Plan tool for Arthur's workspace.
//
// Gives Arthur cross-domain visibility into all goals and enables surplus
// negotiation across competing financial priorities. This is the orchestrator's
// primary planning tool — it fans out to every bridged domain via intent_bridge
// to collect goals, computes available surplus from Checking & Savings, and
// runs a priority-weighted allocation algorithm.
//
// Operations:
//   snapshot  — Aggregate all domain goals + cashflow surplus
//   negotiate — Allocate surplus across competing goals by urgency
//   accept    — Record a plan acceptance (stub)
//   history   — Retrieve plan history (stub)

import type { Tool } from '../types';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Summary of a single financial goal, normalized across all domains. */
interface GoalSummary {
  id: string;
  name: string;
  goal_type: string;
  target_amount: number | null;
  current_value: number;
  progress_pct: number;
  on_track: boolean;
  monthly_required: number | null;
  monthly_current: number | null;
  gap: number | null;
  recommendation: string;
  resource_request: {
    monthly_requested: number;
    urgency_score: number;
    urgency_factors: string[];
    deferrable: boolean;
    opportunity_cost: number;
  } | null;
}

/** Per-domain goal collection returned by intent_bridge → goals.list. */
interface DomainGoals {
  domain: string;
  workspace_name: string;
  goals: GoalSummary[];
}

/** Cashflow surplus structure from get_cashflow. */
interface SurplusInfo {
  monthly_income: number;
  monthly_expenses: number;
  monthly_committed: number;
  monthly_available: number;
}

/** Full snapshot returned by the snapshot operation. */
interface SnapshotResult {
  domains: DomainGoals[];
  surplus: SurplusInfo;
  snapshot_at: string;
}

/** A single allocation from the negotiate algorithm. */
interface Allocation {
  goal_id: string;
  domain: string;
  name: string;
  requested: number;
  allocated: number;
  reason: string;
}

/** Result of the negotiate operation. */
interface NegotiateResult {
  allocations: Allocation[];
  unallocated: number;
  trade_offs: string[];
  surplus: SurplusInfo;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Default urgency scores by goal type.
 * Used when a domain's resource_request doesn't supply its own urgency_score.
 */
const DEFAULT_URGENCY_BY_TYPE: Record<string, number> = {
  debt:              0.9,   // High APR debt is the most expensive to carry
  emergency_fund:    0.8,   // Safety net — critical if below target
  savings_target:    0.8,   // Short-term savings goal
  retirement:        0.6,   // Long horizon, but compounding matters
  portfolio_growth:  0.5,   // Discretionary investment growth
  equity_growth:     0.5,   // Real estate equity building
  tax_reserve:       0.4,   // Seasonal — only urgent near filing deadlines
};

/** Fallback urgency for unknown goal types */
const DEFAULT_URGENCY_FALLBACK = 0.3;

/** Map workspace names to human-readable step labels (mirrors chatHandler.ts) */
function describeWorkspace(name: string): string {
  const wsDescriptions: Record<string, string> = {
    'Retirement': 'Analyzing retirement accounts',
    'Investments': 'Reviewing investments',
    'Checking & Savings': 'Checking cash flow',
    'Debt Management': 'Evaluating debt obligations',
    'Real Estate': 'Reviewing real estate holdings',
    'Taxes': 'Considering tax implications',
    'Demographics': 'Reviewing your profile',
  };
  return wsDescriptions[name] || `Querying ${name}`;
}

/** Slugify workspace name to a step key */
function slugifyStep(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────────

/**
 * Lazily import executeTool from the tool registry to avoid circular
 * dependency at module-load time (index.ts imports this file).
 */
let _executeTool: typeof import('./index').executeTool | null = null;

async function getExecuteTool() {
  if (!_executeTool) {
    const mod = await import('./index.js');
    _executeTool = mod.executeTool;
  }
  return _executeTool;
}

/**
 * Safely call intent_bridge to invoke a capability on a domain workspace.
 * Returns the data payload on success, or null if the domain is unreachable.
 */
async function callDomainCapability(
  targetName: string,
  capabilityName: string,
  input: Record<string, unknown>,
  workspaceConfig: any,
): Promise<any | null> {
  const executeTool = await getExecuteTool();
  try {
    const result = await executeTool('intent_bridge', {
      target: targetName,
      op: 'capability',
      name: capabilityName,
      input,
    }, workspaceConfig);

    if (result?.success === false) {
      console.warn(`[financial_plan] ${targetName}/${capabilityName} failed: ${result.error}`);
      return null;
    }
    return result?.data ?? result;
  } catch (err: any) {
    console.warn(`[financial_plan] ${targetName}/${capabilityName} error: ${err.message}`);
    return null;
  }
}

/**
 * Safely call intent_bridge to invoke a tool on a domain workspace.
 * Returns the data payload on success, or null if the domain is unreachable.
 */
async function callDomainTool(
  targetName: string,
  toolName: string,
  args: Record<string, unknown>,
  workspaceConfig: any,
): Promise<any | null> {
  const executeTool = await getExecuteTool();
  try {
    const result = await executeTool('intent_bridge', {
      target: targetName,
      op: 'tool_call',
      tool: toolName,
      args,
    }, workspaceConfig);

    if (result?.success === false) {
      console.warn(`[financial_plan] ${targetName}/${toolName} failed: ${result.error}`);
      return null;
    }
    return result?.data ?? result;
  } catch (err: any) {
    console.warn(`[financial_plan] ${targetName}/${toolName} error: ${err.message}`);
    return null;
  }
}

/**
 * Compute the urgency score for a goal.
 * Prefers the domain-provided urgency_score from resource_request;
 * falls back to the default urgency table by goal_type.
 */
function getUrgencyScore(goal: GoalSummary): number {
  // Domain-provided urgency takes precedence
  if (goal.resource_request?.urgency_score != null) {
    return goal.resource_request.urgency_score;
  }

  const baseScore = DEFAULT_URGENCY_BY_TYPE[goal.goal_type] ?? DEFAULT_URGENCY_FALLBACK;

  // For savings/emergency goals, reduce urgency if already at target
  if (
    (goal.goal_type === 'emergency_fund' || goal.goal_type === 'savings_target') &&
    goal.progress_pct >= 100
  ) {
    return 0.0;
  }

  return baseScore;
}

/**
 * Build the full cross-domain snapshot by fanning out to all bridged workspaces.
 */
async function buildSnapshot(workspaceConfig: any, onProgress?: any): Promise<SnapshotResult> {
  // Fetch the workspace manifest to discover bridges
  const { fetchManifest } = require('../utils/fetchManifest');
  const manifest = await fetchManifest();
  const bridges: any[] = manifest.RT_BRIDGES || [];

  if (!bridges.length) {
    return {
      domains: [],
      surplus: { monthly_income: 0, monthly_expenses: 0, monthly_committed: 0, monthly_available: 0 },
      snapshot_at: new Date().toISOString(),
    };
  }

  // Emit root planning step
  onProgress?.('planning', 'Building financial plan', 'active');

  // Register all domain steps as pending (DAG structure)
  for (const bridge of bridges) {
    onProgress?.(slugifyStep(bridge.targetName), describeWorkspace(bridge.targetName), 'pending', { parent: 'planning' });
  }

  // ── Fan out: goals.list on every bridged domain (parallel) ──
  const goalPromises = bridges.map(async (bridge): Promise<DomainGoals | null> => {
    const stepKey = slugifyStep(bridge.targetName);
    const stepLabel = describeWorkspace(bridge.targetName);
    const start = Date.now();
    onProgress?.(stepKey, stepLabel, 'active', { parent: 'planning' });

    const data = await callDomainCapability(
      bridge.targetName,
      'goals.list',
      {},
      workspaceConfig,
    );

    onProgress?.(stepKey, stepLabel, 'completed', {
      parent: 'planning',
      durationMs: Date.now() - start,
    });

    if (!data) return null;

    // Normalize: data may be { goals: [...] } or an array directly
    const goals: GoalSummary[] = Array.isArray(data)
      ? data
      : Array.isArray(data.goals)
        ? data.goals
        : [];

    return {
      domain: data.domain || bridge.targetName.toLowerCase().replace(/\s+/g, '_'),
      workspace_name: bridge.targetName,
      goals,
    };
  });

  // ── Fan out: get_cashflow from Checking & Savings (parallel) ──
  const cashflowPromise = callDomainTool(
    'Checking & Savings',
    'get_cashflow',
    {},
    workspaceConfig,
  );

  // Wait for all calls to settle
  const [goalResults, cashflowResult] = await Promise.all([
    Promise.all(goalPromises),
    cashflowPromise,
  ]);

  onProgress?.('planning', 'Building financial plan', 'completed');

  // Aggregation step
  onProgress?.('aggregating', 'Aggregating goal data', 'active');

  // Filter out unreachable domains
  const domains: DomainGoals[] = goalResults.filter(
    (d): d is DomainGoals => d !== null && d.goals.length > 0,
  );

  // Parse cashflow into surplus structure
  const surplus: SurplusInfo = {
    monthly_income: cashflowResult?.monthly_income ?? 0,
    monthly_expenses: cashflowResult?.monthly_expenses ?? 0,
    monthly_committed: cashflowResult?.monthly_committed ?? 0,
    monthly_available: cashflowResult?.monthly_available ?? 0,
  };

  onProgress?.('aggregating', 'Aggregating goal data', 'completed');

  return {
    domains,
    surplus,
    snapshot_at: new Date().toISOString(),
  };
}

/**
 * Run the surplus allocation algorithm across competing goals.
 *
 * Algorithm:
 *   1. Collect all goals with gaps (monthly_required > monthly_current)
 *   2. Score each by urgency (domain-provided or default by goal_type)
 *   3. Sort by urgency DESC
 *   4. Allocate available surplus in order (each goal gets min(gap, remaining))
 *   5. Generate trade-off explanations
 */
function negotiateSurplus(
  snapshot: SnapshotResult,
  surplusOverride?: number,
): NegotiateResult {
  const availableSurplus = surplusOverride ?? snapshot.surplus.monthly_available;
  let remaining = Math.max(0, availableSurplus);

  // ── 1. Collect all goals with gaps ──
  interface ScoredGoal {
    goal: GoalSummary;
    domain: string;
    workspace_name: string;
    urgency: number;
    gap: number;
  }

  const scoredGoals: ScoredGoal[] = [];

  for (const domainGroup of snapshot.domains) {
    for (const goal of domainGroup.goals) {
      const gap = goal.gap ?? (
        goal.monthly_required != null && goal.monthly_current != null
          ? Math.max(0, goal.monthly_required - goal.monthly_current)
          : 0
      );

      if (gap <= 0) continue;

      scoredGoals.push({
        goal,
        domain: domainGroup.domain,
        workspace_name: domainGroup.workspace_name,
        urgency: getUrgencyScore(goal),
        gap,
      });
    }
  }

  // ── 2. Sort by urgency DESC, then by gap DESC (tie-breaker) ──
  scoredGoals.sort((a, b) => {
    if (b.urgency !== a.urgency) return b.urgency - a.urgency;
    return b.gap - a.gap;
  });

  // ── 3. Allocate surplus ──
  const allocations: Allocation[] = [];
  const tradeOffs: string[] = [];

  for (const sg of scoredGoals) {
    if (remaining <= 0) {
      tradeOffs.push(
        `${sg.goal.name} (${sg.domain}) needs $${sg.gap.toFixed(0)}/mo but no surplus remains — ` +
        `urgency ${sg.urgency.toFixed(2)}. ${sg.goal.recommendation || 'Consider increasing income or reducing other commitments.'}`,
      );

      allocations.push({
        goal_id: sg.goal.id,
        domain: sg.domain,
        name: sg.goal.name,
        requested: sg.gap,
        allocated: 0,
        reason: `No surplus remaining (urgency: ${sg.urgency.toFixed(2)})`,
      });
      continue;
    }

    const allocated = Math.min(sg.gap, remaining);
    remaining -= allocated;

    const fullyFunded = allocated >= sg.gap;
    const reason = fullyFunded
      ? `Fully funded — urgency ${sg.urgency.toFixed(2)}`
      : `Partially funded ($${allocated.toFixed(0)} of $${sg.gap.toFixed(0)} needed) — urgency ${sg.urgency.toFixed(2)}`;

    allocations.push({
      goal_id: sg.goal.id,
      domain: sg.domain,
      name: sg.goal.name,
      requested: sg.gap,
      allocated,
      reason,
    });

    if (!fullyFunded) {
      tradeOffs.push(
        `${sg.goal.name} (${sg.domain}) is only partially funded: $${allocated.toFixed(0)} of $${sg.gap.toFixed(0)}/mo needed. ` +
        `${sg.goal.recommendation || 'Consider prioritizing or finding additional funds.'}`,
      );
    }
  }

  // Summary trade-off if everything was funded
  if (tradeOffs.length === 0 && scoredGoals.length > 0) {
    tradeOffs.push('All identified funding gaps are covered by available surplus.');
  }

  if (remaining > 0 && scoredGoals.length > 0) {
    tradeOffs.push(
      `$${remaining.toFixed(0)}/mo surplus remains unallocated after funding all gaps. ` +
      `Consider increasing retirement contributions or building an additional safety buffer.`,
    );
  }

  return {
    allocations,
    unallocated: remaining,
    trade_offs: tradeOffs,
    surplus: {
      ...snapshot.surplus,
      // Override monthly_available if the caller provided surplus_override
      ...(surplusOverride != null ? { monthly_available: surplusOverride } : {}),
    },
  };
}

// ─── Tool Definition ────────────────────────────────────────────────────────

const financialPlan: Tool = {
  name: 'financial_plan',
  description:
    'Cross-domain financial planning tool. Aggregates goals from all domain workspaces, ' +
    'computes surplus, and negotiates allocation across competing priorities.\n\n' +
    'Operations:\n' +
    "- snapshot: Aggregate all domain goals + cashflow surplus into a unified view\n" +
    "- negotiate: Run surplus allocation algorithm across competing goals (optional: surplus_override)\n" +
    "- accept: Record a plan acceptance (takes allocations from negotiate)\n" +
    "- history: Retrieve plan history",
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['snapshot', 'negotiate', 'accept', 'history'],
        description: 'Operation to perform',
      },
      surplus_override: {
        type: 'number',
        description: 'For negotiate: override the calculated monthly surplus with this value',
      },
      allocations: {
        type: 'array',
        description: 'For accept: the allocations array from a negotiate result',
        items: { type: 'object' },
      },
    },
    required: ['op'],
  },

  /**
   * Execute a financial plan operation.
   *
   * @param args.op - Operation: snapshot | negotiate | accept | history
   * @param args.surplus_override - (negotiate only) Override calculated surplus
   * @param args.allocations - (accept only) Allocations from negotiate result
   * @param workspaceConfig - Workspace config with traceContext, bridges, etc.
   */
  async execute(args: any, workspaceConfig: any = {}, _context?: any) {
    const { op } = args;

    if (!op) {
      return { success: false, error: 'op is required. Use: snapshot, negotiate, accept, or history.' };
    }

    switch (op) {
      // ────────────────────────────────────────────────────────────
      // SNAPSHOT — Aggregate all domain goals + cashflow surplus
      // ────────────────────────────────────────────────────────────
      case 'snapshot': {
        try {
          const snapshot = await buildSnapshot(workspaceConfig, _context?.onProgress);

          const totalGoals = snapshot.domains.reduce((sum, d) => sum + d.goals.length, 0);
          const domainsReached = snapshot.domains.length;

          return {
            success: true,
            ...snapshot,
            _meta: {
              domains_reached: domainsReached,
              total_goals: totalGoals,
              protocol: 'intent',
            },
          };
        } catch (err: any) {
          console.error(`[financial_plan] snapshot error: ${err.message}`);
          return {
            success: false,
            error: `Failed to build financial snapshot: ${err.message}`,
          };
        }
      }

      // ────────────────────────────────────────────────────────────
      // NEGOTIATE — Allocate surplus across competing goals
      // ────────────────────────────────────────────────────────────
      case 'negotiate': {
        try {
          const snapshot = await buildSnapshot(workspaceConfig, _context?.onProgress);
          const result = negotiateSurplus(snapshot, args.surplus_override);

          return {
            success: true,
            ...result,
            _meta: {
              goals_with_gaps: result.allocations.length,
              goals_fully_funded: result.allocations.filter(a => a.allocated >= a.requested).length,
              goals_unfunded: result.allocations.filter(a => a.allocated === 0).length,
              surplus_override_used: args.surplus_override != null,
              protocol: 'intent',
            },
          };
        } catch (err: any) {
          console.error(`[financial_plan] negotiate error: ${err.message}`);
          return {
            success: false,
            error: `Failed to negotiate surplus allocation: ${err.message}`,
          };
        }
      }

      // ────────────────────────────────────────────────────────────
      // ACCEPT — Record plan acceptance (stub)
      // ────────────────────────────────────────────────────────────
      case 'accept': {
        if (!args.allocations || !Array.isArray(args.allocations)) {
          return {
            success: false,
            error: 'accept requires an allocations array from a negotiate result.',
          };
        }

        // Stub: in the future this will update domain_goals monthly_contribution
        // values via intent_bridge calls to each domain.
        return {
          success: true,
          accepted: true,
          accepted_at: new Date().toISOString(),
          allocations_count: args.allocations.length,
          _note: 'Plan acceptance recorded. Domain contribution updates will be implemented in a future release.',
        };
      }

      // ────────────────────────────────────────────────────────────
      // HISTORY — Plan history (stub)
      // ────────────────────────────────────────────────────────────
      case 'history': {
        // Stub: will query a plan_history table once persistence is implemented
        return {
          success: true,
          history: [],
          message: 'Plan history coming soon',
        };
      }

      default:
        return {
          success: false,
          error: `Unknown operation: "${op}". Use: snapshot, negotiate, accept, or history.`,
        };
    }
  },
};

export default financialPlan;
