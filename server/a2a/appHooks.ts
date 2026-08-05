// server/a2a/appHooks.ts — Application extension hooks
//
// Core is vertical-agnostic. Domain-specific behavior — what provenance means
// for an application's data, how tool calls should be described to its users —
// is registered here by application plugins at load time (see
// server/tools/index.ts, which passes these registrars to the plugin's
// registerFromEnv). Roundtable-core itself ships only generic fallbacks.
//
// Before this boundary existed, a2a/server.ts and sockets/chatHandler.ts each
// carried a hardcoded copy of Pendragon's financial labels and a ~430-line
// financial provenance extractor — the platform knew about its one vertical.
// That logic now lives in @pendragon/tools-plaid (src/provenance/extract.ts).

export interface ActivityDescription { step: string; label: string }

export type ActivityDescriptor = (
  toolName: string,
  args: Record<string, unknown>,
) => ActivityDescription | null;

export type ToolResultRecord = { name: string; result: Record<string, unknown> };

export type ProvenanceExtractor = (
  toolResults: ToolResultRecord[],
) => Record<string, unknown> | null;

let activityDescriptor: ActivityDescriptor | null = null;
let provenanceExtractor: ProvenanceExtractor | null = null;
let missingExtractorWarned = false;

/** Register an application-specific activity descriptor (plugin load time). */
export function registerActivityDescriptor(fn: ActivityDescriptor): void {
  activityDescriptor = fn;
}

/** Register an application-specific provenance extractor (plugin load time). */
export function registerProvenanceExtractor(fn: ProvenanceExtractor): void {
  provenanceExtractor = fn;
}

// ─── Activity descriptions ──────────────────────────────────────────────────

/** Generic labels for core-owned tools. Applications override via the hook. */
const CORE_TOOL_LABELS: Record<string, ActivityDescription> = {
  describe_workspace: { step: 'planning', label: 'Planning analysis' },
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

/**
 * Human-friendly step description for a tool call (drives the ai-status step
 * log). Application descriptor wins; unknown tools humanize the name.
 */
export function describeActivity(
  toolName: string,
  args: Record<string, unknown>,
): ActivityDescription {
  const custom = activityDescriptor ? activityDescriptor(toolName, args) : null;
  if (custom) return custom;

  if (toolName === 'intent_bridge' || toolName === 'bridge_workspace') {
    const target = (args.targetWorkspace || args.target || 'workspace') as string;
    return { step: target, label: `Consulting ${target}` };
  }

  if (CORE_TOOL_LABELS[toolName]) return CORE_TOOL_LABELS[toolName];

  const humanized = toolName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { step: toolName, label: humanized };
}

// ─── Provenance extraction ──────────────────────────────────────────────────

/**
 * Extract a provenance artifact from this turn's tool results, using the
 * application-registered extractor. Core has no domain semantics of its own:
 * with no extractor registered, no provenance artifact is produced — and if
 * the tool results look like they carried provenance signal, that absence is
 * logged LOUDLY once. For an application whose UI depends on provenance
 * (Pendragon's confidence badges), silence here means the plugin failed to
 * load in the image — a do-not-regress condition that must be visible in
 * logs, never inferred from a quietly blank footer.
 */
export function extractProvenance(
  toolResults: ToolResultRecord[],
): Record<string, unknown> | null {
  if (provenanceExtractor) return provenanceExtractor(toolResults);

  const hadSignal = toolResults.some(
    (t) => t.name === 'intent_bridge' || t.name === 'emit_provenance' || t.name === 'declare_missing_data',
  );
  if (hadSignal && !missingExtractorWarned) {
    missingExtractorWarned = true;
    console.warn(
      '[a2a] No provenance extractor registered — provenance artifact skipped. ' +
      'If this workspace runs an application that renders provenance, its plugin did not load.',
    );
  }
  return null;
}

/** Test-only: reset registered hooks and warning state. */
export function _resetAppHooks(): void {
  activityDescriptor = null;
  provenanceExtractor = null;
  missingExtractorWarned = false;
}
