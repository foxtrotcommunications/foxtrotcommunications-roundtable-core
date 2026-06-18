// server/utils/provenance.ts — Deterministic provenance computation for AI responses

// ─── Types ─────────────────────────────────────────────────

export interface ToolTrace {
  name: string;
  durationMs: number;
  status: 'success' | 'error';
  args?: Record<string, unknown>;
}

export interface BridgeTrace {
  targetWorkspace: string;
  capability: string;
  durationMs: number;
  status: 'success' | 'error';
}

export interface SystemProvenance {
  confidence: number;
  confidenceLabel: string;
  domainsConsulted: string[];
  domainsAvailable: number;
  accountsAnalyzed: number;
  transactionsReviewed: number;
  dataAge: string;
  dataTimestamp: number;
  toolsCalled: ToolTrace[];
  totalDurationMs: number;
  bridgeCalls: BridgeTrace[];
}

export interface ReasoningProvenance {
  assumptions: string[];
  keyCalculations: string[];
  keyDrivers: string[];
  limitations: string[];
  missingDomains: string[];
  wouldImprove: string[];
}

export interface ProvenancePayload {
  system: SystemProvenance;
  reasoning: ReasoningProvenance | null;
}

// ─── Confidence Scoring ────────────────────────────────────

interface ConfidenceContext {
  domainsConsulted: string[];
  domainsAvailable: number;
  dataTimestamp: number;
  toolsCalled: ToolTrace[];
  assumptionCount: number;
}

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeConfidence(ctx: ConfidenceContext): number {
  const coverageScore = ctx.domainsConsulted.length / Math.max(ctx.domainsAvailable, 1);

  const ageMinutes = ctx.dataTimestamp > 0
    ? (Date.now() - ctx.dataTimestamp) / 60_000
    : Infinity;

  const freshnessScore =
    ageMinutes <= 5 ? 1.0 :
    ageMinutes <= 60 ? 0.9 :
    ageMinutes <= 360 ? 0.7 :
    0.4;

  const successCount = ctx.toolsCalled.filter(t => t.status === 'success').length;
  const successRate = successCount / Math.max(ctx.toolsCalled.length, 1);

  const assumptionPenalty = Math.max(0.6, 1.0 - (ctx.assumptionCount * 0.08));

  const cachedPenalty = ctx.toolsCalled.length === 0 ? 0.5 : 1.0;

  const raw = coverageScore * freshnessScore * successRate * assumptionPenalty * cachedPenalty * 100;
  return Math.round(clamp(0, 100, raw));
}

export function confidenceLabel(score: number): string {
  if (score >= 85) return 'High';
  if (score >= 65) return 'Moderate';
  if (score >= 40) return 'Low';
  return 'Very Low';
}

// ─── Reasoning Comment Parser ──────────────────────────────

const REASONING_RE = /<!--reasoning:([\s\S]*?)-->/;
// Strip old AI-generated provenance blockquotes (> 📍 Data Provenance ... )
const OLD_PROVENANCE_RE = /\n*(?:> *📍[^\n]*\n(?:> *[^\n]*\n?)*)$/;
// Strip AI-generated metadata blocks (Sources, Confidence, Coverage, etc.)
const OLD_METADATA_RE = /\n*(?:\n🐉[^\n]*\n(?:.*\n)*?(?:Jun|Jan|Feb|Mar|Apr|May|Jul|Aug|Sep|Oct|Nov|Dec) \d+.*$)/m;

export function parseReasoningComment(fullText: string): {
  cleanText: string;
  reasoning: ReasoningProvenance | null;
} {
  const match = REASONING_RE.exec(fullText);
  let text = fullText;
  let reasoning: ReasoningProvenance | null = null;

  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      reasoning = {
        assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
        keyCalculations: Array.isArray(parsed.keyCalculations) ? parsed.keyCalculations : [],
        keyDrivers: Array.isArray(parsed.keyDrivers) ? parsed.keyDrivers : [],
        limitations: Array.isArray(parsed.limitations) ? parsed.limitations : [],
        missingDomains: Array.isArray(parsed.missingDomains) ? parsed.missingDomains : [],
        wouldImprove: Array.isArray(parsed.wouldImprove) ? parsed.wouldImprove : [],
      };
      text = text.replace(match[0], '');
    } catch {
      // Invalid JSON — keep text as-is
    }
  }

  // Strip old-style provenance blockquotes the AI might still generate
  text = text.replace(OLD_PROVENANCE_RE, '');

  console.log('[Provenance] reasoning found:', !!reasoning,
    reasoning ? `assumptions=${reasoning.assumptions.length}` : 'none');

  return { cleanText: text.trimEnd(), reasoning };
}

// ─── System Provenance Builder ─────────────────────────────

function formatDataAge(timestampMs: number): string {
  if (timestampMs <= 0) return 'no data';

  const diffMs = Date.now() - timestampMs;
  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function buildSystemProvenance(
  toolTraces: ToolTrace[],
  bridgeTraces: BridgeTrace[],
  domainsAvailable: number,
  firstToolTimestamp: number,
): SystemProvenance {
  // Extract unique domain names from bridge traces
  const domainsConsulted = Array.from(
    new Set(bridgeTraces.map(b => b.targetWorkspace).filter(w => w !== 'unknown')),
  );

  // Sum accounts and transactions from bridge trace results if available
  let accountsAnalyzed = 0;
  let transactionsReviewed = 0;
  for (const trace of bridgeTraces) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traceAny = trace as any;
    if (typeof traceAny.accountsAnalyzed === 'number') accountsAnalyzed += traceAny.accountsAnalyzed;
    if (typeof traceAny.transactionsReviewed === 'number') transactionsReviewed += traceAny.transactionsReviewed;
  }

  const totalDurationMs = toolTraces.reduce((sum, t) => sum + t.durationMs, 0);
  const dataTimestamp = firstToolTimestamp || 0;
  const dataAge = formatDataAge(dataTimestamp);

  return {
    confidence: 0, // computed later in mergeProvenance
    confidenceLabel: 'Very Low',
    domainsConsulted,
    domainsAvailable,
    accountsAnalyzed,
    transactionsReviewed,
    dataAge,
    dataTimestamp,
    toolsCalled: toolTraces,
    totalDurationMs,
    bridgeCalls: bridgeTraces,
  };
}

// ─── Merge Provenance ──────────────────────────────────────

export function mergeProvenance(
  system: SystemProvenance,
  reasoning: ReasoningProvenance | null,
): ProvenancePayload {
  const assumptionCount = reasoning ? reasoning.assumptions.length : 0;

  const confidence = computeConfidence({
    domainsConsulted: system.domainsConsulted,
    domainsAvailable: system.domainsAvailable,
    dataTimestamp: system.dataTimestamp,
    toolsCalled: system.toolsCalled,
    assumptionCount,
  });

  const merged: SystemProvenance = {
    ...system,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
  };

  return {
    system: merged,
    reasoning,
  };
}
