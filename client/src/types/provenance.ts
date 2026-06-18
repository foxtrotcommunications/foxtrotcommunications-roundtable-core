// Type definitions for provenance footer payloads

export interface ToolTrace {
  name: string;
  durationMs: number;
  status: 'success' | 'error';
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
