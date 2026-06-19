// @ts-nocheck
// server/tools/emitProvenance.ts — Provenance tool for financial AI workspaces
// Arthur calls this at the end of financial responses to emit structured provenance.
// The tool computes confidence deterministically — the AI never scores itself.
import type { Tool } from '../types';

/**
 * Reads RT_CONTRACTS and RT_BRIDGES to determine domain topology.
 */
async function getTopology() {
  const { fetchManifest } = require('../utils/fetchManifest');
  const manifest = await fetchManifest();
  const contracts = manifest.RT_CONTRACTS || [];
  const bridges = manifest.RT_BRIDGES || [];

  const availableDomains = contracts
    .filter((c: any) => c.direction === 'outbound')
    .map((c: any) => c.counterparty?.name || 'Unknown');

  return { contracts, bridges, availableDomains, totalDomains: availableDomains.length };
}

// All possible Pendragon financial domains
const TOTAL_PENDRAGON_DOMAINS = 6; // checking, investments, retirement, debt, taxes, realestate

/**
 * Deterministic confidence scoring.
 * Confidence = data quality: freshness × assumptions × tool calls
 * Coverage = financial picture breadth: domainsConsulted / total possible domains
 */
function computeConfidence(args: {
  domainsConsulted: string[];
  totalDomains: number;
  assumptions: string[];
  missingDomains: string[];
  dataFreshMinutes: number;
  toolCallCount: number;
}): { score: number; label: string; coverage: number; coverageLabel: string } {
  const { domainsConsulted, assumptions, dataFreshMinutes, toolCallCount } = args;

  // ── Confidence: how trustworthy is what we're saying? ──

  // Did we actually query real data?
  const hasRealData = domainsConsulted.length > 0 && toolCallCount > 0;
  const baseScore = hasRealData ? 1.0 : 0.3;

  // Freshness: penalize stale data
  const freshnessScore =
    dataFreshMinutes <= 5 ? 1.0 :
    dataFreshMinutes <= 60 ? 0.9 :
    dataFreshMinutes <= 360 ? 0.7 :
    0.4;

  // Assumption penalty: each assumption reduces confidence
  const assumptionPenalty = Math.max(0.6, 1.0 - (assumptions.length * 0.08));

  // No tool calls = no real data = low confidence
  const toolPenalty = toolCallCount === 0 ? 0.4 : 1.0;

  const rawConfidence = baseScore * freshnessScore * assumptionPenalty * toolPenalty * 100;
  const score = Math.round(Math.min(100, Math.max(0, rawConfidence)));

  const label =
    score >= 85 ? 'High' :
    score >= 65 ? 'Moderate' :
    score >= 40 ? 'Low' :
    'Very Low';

  // ── Coverage: how much of the financial picture do we see? ──

  const coverageRaw = Math.round((domainsConsulted.length / TOTAL_PENDRAGON_DOMAINS) * 100);
  const coverage = Math.min(100, Math.max(0, coverageRaw));

  const coverageLabel =
    coverage >= 80 ? 'Comprehensive' :
    coverage >= 50 ? 'Moderate' :
    coverage >= 25 ? 'Partial' :
    'Limited';

  return { score, label, coverage, coverageLabel };
}

/**
 * Compute provenance alignment — did the narrative stay within the evidence?
 * Validates claim types against evidence strength.
 */
function computeAlignment(claims: any[], responseText: string, coveragePct: number): { score: number; penalties: string[] } {
  let score = 100;
  const penalties: string[] = [];

  if (!claims || claims.length === 0) {
    // No claims emitted — check for superlative/historical issues in raw text
    const strongClaims = /comprehensive|complete|full|thorough|definitive/gi;
    if (strongClaims.test(responseText) && coveragePct < 80) {
      score -= 20;
      penalties.push('Superlative claim with < 80% coverage');
    }
    return { score: Math.max(score, 0), penalties };
  }

  // 1. Observations without evidence
  const observations = claims.filter((c: any) => c.type === 'observation');
  for (const obs of observations) {
    if (!obs.evidence || obs.evidence.length === 0) {
      score -= 10;
      penalties.push(`Observation without evidence: "${String(obs.text).slice(0, 60)}..."`);
    }
  }

  // 2. Ungrounded inferences
  const inferences = claims.filter((c: any) => c.type === 'inference');
  for (const inf of inferences) {
    if (!inf.based_on || inf.based_on.length === 0) {
      score -= 8;
      penalties.push(`Ungrounded inference: "${String(inf.text).slice(0, 60)}..."`);
    }
  }

  // 3. Hypothesis stated as fact (missing conditional language)
  const hypotheses = claims.filter((c: any) => c.type === 'hypothesis');
  for (const hyp of hypotheses) {
    const conditional = /may|might|could|possibly|potentially|perhaps|one (possible )?explanation/i;
    if (!conditional.test(String(hyp.text))) {
      score -= 15;
      penalties.push(`Hypothesis stated as fact: "${String(hyp.text).slice(0, 60)}..."`);
    }
  }

  // 4. Superlative inflation
  const strongClaims = /comprehensive|complete|full|thorough|definitive|all.*accounts/gi;
  if (strongClaims.test(responseText) && coveragePct < 80) {
    score -= 20;
    penalties.push('Superlative claim with < 80% coverage');
  }

  // 5. Historical inflation
  const historicalClaims = /trend|pattern|historically|over time|trajectory/gi;
  if (historicalClaims.test(responseText) && coveragePct < 30) {
    score -= 15;
    penalties.push('Historical claim with < 30% historical coverage');
  }

  // 6. Long analysis with few classified claims
  const analysisLength = responseText.replace(/```[\s\S]*?```/g, '').length;
  if (analysisLength > 500 && claims.length < 2) {
    score -= 10;
    penalties.push('Long analysis with few classified claims');
  }

  return { score: Math.max(score, 0), penalties };
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

The system computes confidence deterministically from these inputs. Never compute or state confidence yourself.

For claim classification, tag each factual statement in your response:
- observation: directly read from data. Include evidence.
- calculation: derived via math. Include formula.
- inference: conclusion drawn from observations. Include based_on indices.
- hypothesis: speculative explanation. MUST use conditional language (may, could, might).
- recommendation: actionable suggestion. Separate from facts.`,
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
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['observation', 'calculation', 'inference', 'hypothesis', 'recommendation'],
              description: 'The type of claim',
            },
            text: { type: 'string', description: 'The claim statement' },
            evidence: {
              type: 'array',
              items: { type: 'string' },
              description: 'For observations/calculations: what data supports this',
            },
            formula: {
              type: 'string',
              description: 'For calculations: the math expression',
            },
            based_on: {
              type: 'array',
              items: { type: 'number' },
              description: 'For inferences/hypotheses: indices of supporting claims',
            },
          },
          required: ['type', 'text'],
        },
        description: 'Classified claims from your response. Tag each factual statement.',
      },
      responseText: {
        type: 'string',
        description: 'Your full response text (for alignment validation)',
      },
    },
    required: ['domainsConsulted', 'assumptions'],
  },
  async execute(args: any) {
    const topology = await getTopology();

    const domainsConsulted = args.domainsConsulted || [];
    const assumptions = args.assumptions || [];
    const keyCalculations = args.keyCalculations || [];
    const keyDrivers = args.keyDrivers || [];
    const limitations = args.limitations || [];
    const missingDomains = args.missingDomains || [];
    const wouldImprove = args.wouldImprove || [];
    const dataFreshMinutes = args.dataFreshMinutes ?? 0;
    const toolCallCount = args.toolCallCount ?? 0;
    const claims = args.claims || [];
    const responseText = args.responseText || '';

    const { score, label, coverage, coverageLabel } = computeConfidence({
      domainsConsulted,
      totalDomains: topology.totalDomains,
      assumptions,
      missingDomains,
      dataFreshMinutes,
      toolCallCount,
    });

    // Compute provenance alignment from claims
    const alignment = computeAlignment(claims, responseText, coverage);

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

    // Return structured provenance data.
    // The chatHandler / ProvenanceFooter component renders this automatically
    // from the tool result — the AI should NOT echo this as text.
    return {
      success: true,
      type: 'provenance',
      claims,
      alignment: {
        score: alignment.score,
        penalties: alignment.penalties,
      },
      confidence: { score, label },
      coverage: { score: coverage, label: coverageLabel },
      domainsConsulted,
      domainsAvailable: topology.availableDomains,
      totalPossibleDomains: TOTAL_PENDRAGON_DOMAINS,
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
      message: `Provenance recorded. Confidence: ${label} (${score}%). Coverage: ${coverageLabel} (${coverage}%). Alignment: ${alignment.score}%. Do NOT output any provenance text or code blocks — the UI renders this automatically.`,
    };
  },
};

export default tool;
