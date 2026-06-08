// server/protocols/intentToken.ts — Intent Token Type System
// The foundational types for the Roundtable Intent Compilation Engine (ICE).
// Intent tokens are compiled, deterministic instructions that execute on
// receiving workspaces without LLM inference.

// ─── Intent Operations ──────────────────────────────────────────────────────

/** Execute a structured data query */
export interface QueryIntent {
  op: 'query';
  tool: string;                        // e.g. 'query_bigquery', 'query_snowflake'
  params: {
    sql?: string;                      // Pre-built SQL statement
    table?: string;                    // Structured query builder alternative
    select?: string[];
    where?: Record<string, unknown>;
    groupBy?: string[];
    orderBy?: string;
    limit?: number;
  };
  responseFormat: 'json_table' | 'csv' | 'summary' | 'scalar';
  maxBytes?: number;
}

/** Invoke a specific tool with known arguments */
export interface ToolCallIntent {
  op: 'tool_call';
  tool: string;                        // Any tool in the registry
  args: Record<string, unknown>;
  responseFormat?: string;
}

/** Multi-step pipeline of operations */
export interface AggregateIntent {
  op: 'aggregate';
  steps: Array<QueryIntent | ToolCallIntent>;
  reduce: 'concat' | 'merge' | 'last';
}

/** Discover what capabilities a workspace has */
export interface SchemaDiscoveryIntent {
  op: 'discover';
  scope: 'tools' | 'tables' | 'capabilities';
}

/** Invoke a published workspace capability by name */
export interface CapabilityIntent {
  op: 'capability';
  name: string;                          // e.g. 'risk.calculateVar'
  input: Record<string, unknown>;        // Validated against capability's inputSchema
}

/** Union of all supported intent operations */
export type IntentOperation =
  | QueryIntent
  | ToolCallIntent
  | AggregateIntent
  | SchemaDiscoveryIntent
  | CapabilityIntent;

// ─── Intent Token ───────────────────────────────────────────────────────────

/** A compiled, signed, deterministic instruction for cross-workspace execution */
export interface IntentToken {
  version: 1;
  type: 'intent_token';
  id: string;                          // crypto.randomUUID()

  // What to do — the compiled operation
  intent: IntentOperation;

  // Governance binding
  contractId: string;
  contractVersion: number;

  // Cryptographic envelope
  signature: string;                   // HMAC-SHA256 of canonical token body
  timestamp: string;                   // ISO 8601
  expiry: string;                      // ISO 8601 (default: +5 min)
  nonce: string;                       // Replay prevention

  // Optional E2E encryption of the intent body
  encrypted?: boolean;
  encryptedIntent?: {
    iv: string;
    ciphertext: string;
    authTag: string;
  };
}

// ─── Intent Result ──────────────────────────────────────────────────────────

/** Typed, signed result returned from intent execution */
export interface IntentResult {
  version: 1;
  type: 'intent_result';
  tokenId: string;                     // References the source IntentToken.id
  status: 'success' | 'error' | 'denied';
  data?: unknown;                      // Query results, tool output, etc.
  error?: string;                      // Error message if status !== 'success'
  executionMs: number;                 // Wall-clock execution time
  toolExecuted?: string;               // Which tool was actually invoked
  signature: string;                   // HMAC-SHA256 signed by receiving workspace
  timestamp: string;                   // ISO 8601
  cached?: boolean;                    // True if result came from intent cache
  proof?: import('./executionProof').ExecutionProof; // Verifiable execution trace
  compilation?: {                      // SQL fusion / optimization stats
    fusionCount: number;
    deduplicationCount: number;
    limitInjections: number;
    originalStepCount: number;
    optimizedStepCount: number;
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

const VALID_OPS = new Set(['query', 'tool_call', 'aggregate', 'discover', 'capability']);
const VALID_RESPONSE_FORMATS = new Set(['json_table', 'csv', 'summary', 'scalar']);
const VALID_REDUCE_OPS = new Set(['concat', 'merge', 'last']);
const VALID_DISCOVER_SCOPES = new Set(['tools', 'tables', 'capabilities']);

/** Validate an IntentOperation is well-formed */
export function validateIntent(intent: IntentOperation): { valid: boolean; error?: string } {
  if (!intent || typeof intent !== 'object') {
    return { valid: false, error: 'Intent must be an object' };
  }

  if (!VALID_OPS.has(intent.op)) {
    return { valid: false, error: `Invalid op: '${intent.op}'. Must be one of: ${[...VALID_OPS].join(', ')}` };
  }

  switch (intent.op) {
    case 'query': {
      if (!intent.tool || typeof intent.tool !== 'string') {
        return { valid: false, error: 'query intent requires a tool name' };
      }
      if (!intent.params || typeof intent.params !== 'object') {
        return { valid: false, error: 'query intent requires params object' };
      }
      if (!intent.params.sql && !intent.params.table) {
        return { valid: false, error: 'query intent requires either sql or table in params' };
      }
      if (!VALID_RESPONSE_FORMATS.has(intent.responseFormat)) {
        return { valid: false, error: `Invalid responseFormat: '${intent.responseFormat}'` };
      }
      break;
    }
    case 'tool_call': {
      if (!intent.tool || typeof intent.tool !== 'string') {
        return { valid: false, error: 'tool_call intent requires a tool name' };
      }
      if (!intent.args || typeof intent.args !== 'object') {
        return { valid: false, error: 'tool_call intent requires args object' };
      }
      break;
    }
    case 'aggregate': {
      if (!Array.isArray(intent.steps) || intent.steps.length === 0) {
        return { valid: false, error: 'aggregate intent requires a non-empty steps array' };
      }
      if (!VALID_REDUCE_OPS.has(intent.reduce)) {
        return { valid: false, error: `Invalid reduce: '${intent.reduce}'` };
      }
      // Validate each step recursively
      for (let i = 0; i < intent.steps.length; i++) {
        const stepResult = validateIntent(intent.steps[i]);
        if (!stepResult.valid) {
          return { valid: false, error: `Step ${i}: ${stepResult.error}` };
        }
      }
      break;
    }
    case 'discover': {
      if (!VALID_DISCOVER_SCOPES.has(intent.scope)) {
        return { valid: false, error: `Invalid discover scope: '${intent.scope}'` };
      }
      break;
    }
    case 'capability': {
      if (!intent.name || typeof intent.name !== 'string') {
        return { valid: false, error: 'capability intent requires a name string' };
      }
      if (!intent.input || typeof intent.input !== 'object') {
        return { valid: false, error: 'capability intent requires an input object' };
      }
      break;
    }
  }

  return { valid: true };
}

/** Map an intent operation to the contract action name for authorization */
export function intentOpToAction(intent: IntentOperation): string {
  switch (intent.op) {
    case 'query':      return `query:${intent.tool}`;
    case 'tool_call':  return `tool:${intent.tool}`;
    case 'aggregate':  return 'aggregate';
    case 'discover':   return 'discover';
    case 'capability': return `capability:${intent.name}`;
  }
}
