// @ts-nocheck
// server/tools/emitProvenance.ts — Provenance tool for financial AI workspaces
// Arthur calls this at the end of financial responses to emit structured provenance.
// The tool computes confidence deterministically — the AI never scores itself.
import type { Tool } from '../types';

/**
 * Reads RT_CONTRACTS and RT_BRIDGES to determine domain topology.
 */
function getTopology() {
  const contracts = (() => {
    try { return JSON.parse(process.env.RT_CONTRACTS || '[]'); }
    catch { return []; }
  })();
  const bridges = (() => {
    try { return JSON.parse(process.env.RT_BRIDGES || '[]'); }
    catch { return []; }
  })();

  const availableDomains = contracts
    .filter((c: any) => c.direction === 'outbound')
    .map((c: any) => c.counterparty?.name || 'Unknown');

  return { contracts, bridges, availableDomains, totalDomains: availableDomains.length };
}

/**
 * Deterministic confidence scoring.
 * coverage × freshness × assumptionPenalty × missingPenalty
 */
function computeConfidence(args: {
  domainsConsulted: string[];
  totalDomains: number;
  assumptions: string[];
  missingDomains: string[];
  dataFreshMinutes: number;
  toolCallCount: number;
}): { score: number; label: string } {
  const { domainsConsulted, totalDomains, assumptions, missingDomains, dataFreshMinutes, toolCallCount } = args;

  // Coverage: what fraction of available domains were consulted
  const coverageScore = totalDomains > 0
    ? domainsConsulted.length / totalDomains
    : (domainsConsulted.length > 0 ? 0.5 : 0);

  // Freshness: penalize stale data
  const freshnessScore =
    dataFreshMinutes <= 5 ? 1.0 :
    dataFreshMinutes <= 60 ? 0.9 :
    dataFreshMinutes <= 360 ? 0.7 :
    0.4;

  // Assumption penalty: each assumption reduces confidence
  const assumptionPenalty = Math.max(0.6, 1.0 - (assumptions.length * 0.08));

  // Missing data penalty
  const missingPenalty = Math.max(0.5, 1.0 - (missingDomains.length * 0.15));

  // No tool calls = cached data = big penalty
  const cachedPenalty = toolCallCount === 0 ? 0.5 : 1.0;

  const raw = coverageScore * freshnessScore * assumptionPenalty * missingPenalty * cachedPenalty * 100;
  const score = Math.round(Math.min(100, Math.max(0, raw)));

  const label =
    score >= 85 ? 'High' :
    score >= 65 ? 'Moderate' :
    score >= 40 ? 'Low' :
    'Very Low';

  return { score, label };
}

const tool: Tool = {
  name: 'emit_provenance',
  description: `Emit a structured provenance footer after financial analysis. Call this ONCE at the END of every financial response. Do NOT render provenance yourself — this tool handles it.

You provide:
- domainsConsulted: which domain workspaces you queried (e.g. ["Checking & Savings", "Debt Management"])
- assumptions: every assumption you made (e.g. ["APR = 20% (estimated)", "Monthly income from last 3 deposits"])
- keyCalculations: show the math steps (e.g. ["Monthly interest: $5,020 × (20% ÷ 12) = $83.67"])
- keyDrivers: the 2-4 most influential factors (e.g. ["Business card APR", "Recurring charges $4,157/mo"])
- limitations: constraints on your answer (e.g. ["Only 1 institution connected"])
- missingDomains: domains that would improve this answer (e.g. ["Investments", "Retirement"])
- wouldImprove: specific analyses missing data would enable (e.g. ["Employer match analysis"])
- dataFreshMinutes: approximate age of the data you used (0 = just fetched, 60 = 1 hour old)
- toolCallCount: how many tool calls you made for this response

The system computes confidence deterministically from these inputs. Never compute or state confidence yourself.`,
  parameters: {
    type: 'object',
    properties: {
      domainsConsulted: {
        type: 'array',
        items: { type: 'string' },
        description: 'Names of domain workspaces queried for this response',
      },
      assumptions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every assumption made in the analysis',
      },
      keyCalculations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Step-by-step math performed',
      },
      keyDrivers: {
        type: 'array',
        items: { type: 'string' },
        description: 'The 2-4 most influential factors',
      },
      limitations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Constraints that affected the answer',
      },
      missingDomains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Domain workspaces not connected that would improve the answer',
      },
      wouldImprove: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific analyses that missing domains would enable',
      },
      dataFreshMinutes: {
        type: 'number',
        description: 'How many minutes old is the data used (0 = just fetched)',
      },
      toolCallCount: {
        type: 'number',
        description: 'Number of tool calls made for this response',
      },
    },
    required: ['domainsConsulted', 'assumptions'],
  },
  async execute(args: any) {
    const topology = getTopology();

    const domainsConsulted = args.domainsConsulted || [];
    const assumptions = args.assumptions || [];
    const keyCalculations = args.keyCalculations || [];
    const keyDrivers = args.keyDrivers || [];
    const limitations = args.limitations || [];
    const missingDomains = args.missingDomains || [];
    const wouldImprove = args.wouldImprove || [];
    const dataFreshMinutes = args.dataFreshMinutes ?? 0;
    const toolCallCount = args.toolCallCount ?? 0;

    const { score, label } = computeConfidence({
      domainsConsulted,
      totalDomains: topology.totalDomains,
      assumptions,
      missingDomains,
      dataFreshMinutes,
      toolCallCount,
    });

    // Compute potential confidence if missing domains were connected
    const potentialConfidence = missingDomains.length > 0
      ? computeConfidence({
          domainsConsulted: [...domainsConsulted, ...missingDomains],
          totalDomains: topology.totalDomains + missingDomains.length,
          assumptions: assumptions.filter(a => !a.toLowerCase().includes('estimated')),
          missingDomains: [],
          dataFreshMinutes,
          toolCallCount: toolCallCount + missingDomains.length,
        })
      : null;

    const freshness = dataFreshMinutes <= 1 ? 'Just now'
      : dataFreshMinutes < 60 ? `${Math.round(dataFreshMinutes)}m ago`
      : `${Math.round(dataFreshMinutes / 60)}h ago`;

    // Build the provenance block that the AI should include in its response
    const provBlock = JSON.stringify({
      type: 'provenance',
      confidence: { score, label },
      domainsConsulted,
      domainsAvailable: topology.availableDomains,
      freshness,
      reasoning: {
        assumptions,
        keyCalculations,
        keyDrivers,
        limitations,
      },
      missingData: {
        missingDomains,
        wouldImprove,
        potentialConfidence: potentialConfidence ? `${score}% → ${potentialConfidence.score}%` : null,
      },
    });

    const chartBlock = '```provenance\n' + provBlock + '\n```';

    return {
      success: true,
      message: `Provenance computed. Confidence: ${label} (${score}%). IMPORTANT: Include the following provenance block at the END of your response to display it:\n\n${chartBlock}`,
      chartBlock,
    };
  },
};

export default tool;
