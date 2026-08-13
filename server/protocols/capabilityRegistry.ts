// server/protocols/capabilityRegistry.ts — Workspace Capability Registry
// Each workspace publishes typed capabilities (service interface) instead of
// exposing raw tools. Capabilities encapsulate implementation details including
// internal ICE hops to other workspaces.
//
// Example:
//   risk.calculateVar — takes { product, desk, proposedQty }
//                     — internally hops to compliance.positionLimits
//                     — returns { var99_1d, withinLimits, positionPctOfLimit }
//
// Callers see the typed interface. Internal hops are invisible.

import type { ExecutionContext } from './intentExecutor';

// ─── Types ──────────────────────────────────────────────────────────────────

/** JSON Schema subset for input/output validation */
export type JSONSchema = Record<string, unknown>;

/** Context passed to capability handlers during execution */
export interface CapabilityContext {
  /** Standard execution context (contract, keys, workspace config) */
  executionCtx: ExecutionContext;
  /** Pooled runtime: the request's tenant (workspace id, service DB URL,
   *  per-request credentials). Plugins overlay it on their base config via
   *  resolveConfig(config, ctx). Absent on dedicated pods. */
  tenant?: Record<string, unknown>;
  /** Make an outbound ICE call to another workspace (internal hop) */
  iceCall: (
    targetUrl: string,
    contractId: string,
    capabilityName: string,
    input: Record<string, unknown>,
  ) => Promise<{ data?: unknown; error?: string; proof?: unknown }>;
}

/** A capability handler function — the implementation */
export type CapabilityHandler = (
  input: Record<string, unknown>,
  ctx: CapabilityContext,
) => Promise<unknown>;

/** Published workspace capability — typed service interface */
export interface WorkspaceCapability {
  /** Namespaced capability name, e.g. 'risk.calculateVar' */
  name: string;
  /** Human + AI readable description */
  description: string;
  /** JSON Schema for the input object */
  inputSchema: JSONSchema;
  /** JSON Schema for the output object */
  outputSchema: JSONSchema;
  /** Required contract action for access (optional — defaults to capability:name) */
  requiredAction?: string;
}

/** Internal registration — capability definition + handler */
interface CapabilityRegistration extends WorkspaceCapability {
  handler: CapabilityHandler;
}

/** Published capability metadata (no handler — safe to send over the wire) */
export interface CapabilityManifest {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
}

// ─── Schema Validation ──────────────────────────────────────────────────────

/**
 * Lightweight JSON Schema validation.
 * Checks required fields and basic type constraints.
 * Does NOT implement the full JSON Schema spec — just enough for capability I/O.
 */
export function validateInput(
  input: Record<string, unknown>,
  schema: JSONSchema,
): { valid: boolean; error?: string } {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }

  // Check required fields
  const required = schema.required as string[] | undefined;
  if (required && Array.isArray(required)) {
    for (const field of required) {
      if (!(field in input) || input[field] === undefined || input[field] === null) {
        return { valid: false, error: `Missing required field: '${field}'` };
      }
    }
  }

  // Check property types
  const properties = schema.properties as Record<string, { type?: string; enum?: unknown[] }> | undefined;
  if (properties) {
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!(key in input)) continue; // optional field not provided
      const value = input[key];

      // Type check
      if (propSchema.type) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (propSchema.type !== actualType) {
          return {
            valid: false,
            error: `Field '${key}' expected type '${propSchema.type}', got '${actualType}'`,
          };
        }
      }

      // Enum check
      if (propSchema.enum && Array.isArray(propSchema.enum)) {
        if (!propSchema.enum.includes(value)) {
          return {
            valid: false,
            error: `Field '${key}' must be one of: ${propSchema.enum.join(', ')}`,
          };
        }
      }
    }
  }

  return { valid: true };
}

// ─── Registry ───────────────────────────────────────────────────────────────

export class CapabilityRegistry {
  private capabilities = new Map<string, CapabilityRegistration>();

  /**
   * Register a workspace capability.
   *
   * Supports two calling conventions:
   *   1. register(capability, handler)  — handler as separate arg (legacy)
   *   2. register({ ...capability, handler })  — handler embedded in object (@pendragon/tools-plaid)
   */
  register(capability: WorkspaceCapability & { handler?: CapabilityHandler }, handler?: CapabilityHandler): void {
    if (this.capabilities.has(capability.name)) {
      throw new Error(`Capability '${capability.name}' is already registered`);
    }
    // Support both: explicit second arg takes priority, else use embedded handler
    const resolvedHandler = handler || capability.handler;
    if (!resolvedHandler) {
      throw new Error(`Capability '${capability.name}' registered without a handler`);
    }
    this.capabilities.set(capability.name, { ...capability, handler: resolvedHandler });
  }

  /**
   * Look up a capability by name.
   */
  get(name: string): CapabilityRegistration | undefined {
    return this.capabilities.get(name);
  }

  /**
   * Check if a capability exists.
   */
  has(name: string): boolean {
    return this.capabilities.has(name);
  }

  /**
   * Get the published manifest (safe to send over the wire — no handlers).
   */
  getManifest(): CapabilityManifest[] {
    return [...this.capabilities.values()].map(({ name, description, inputSchema, outputSchema }) => ({
      name,
      description,
      inputSchema,
      outputSchema,
    }));
  }

  /**
   * Execute a capability by name.
   *
   * @param name  - Capability name (e.g. 'risk.calculateVar')
   * @param input - Input data (validated against inputSchema)
   * @param ctx   - Execution context with ICE client for internal hops
   * @returns The capability's output
   */
  async execute(
    name: string,
    input: Record<string, unknown>,
    ctx: CapabilityContext,
  ): Promise<{ data?: unknown; error?: string }> {
    const cap = this.capabilities.get(name);
    if (!cap) {
      return { error: `Capability '${name}' not found` };
    }

    // Validate input against schema. Validation errors are TEACHING errors:
    // the caller is usually an LLM that cannot see this capability's schema
    // (intent_bridge is generic), so a bare "missing field X" sends it into
    // one-field-per-retry guesswork until the tool circuit breaker kills the
    // attempt (observed live 2026-07-17: a real decision brief went unsaved
    // twice). Return the full expected shape so the next attempt can be right.
    const validation = validateInput(input, cap.inputSchema);
    if (!validation.valid) {
      const required = (cap.inputSchema as { required?: string[] })?.required || [];
      return {
        error: `Input validation failed for '${name}': ${validation.error}. `
          + `Required fields: [${required.join(', ')}]. `
          + `Full input schema: ${JSON.stringify(cap.inputSchema)}`,
      };
    }

    // Execute the handler
    try {
      const result = await cap.handler(input, ctx);
      return { data: result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Capability '${name}' execution failed: ${message}` };
    }
  }

  /**
   * Get the contract action name for a capability.
   */
  getAction(name: string): string {
    const cap = this.capabilities.get(name);
    return cap?.requiredAction || `capability:${name}`;
  }

  /** Number of registered capabilities */
  get size(): number {
    return this.capabilities.size;
  }

  /** Remove all registrations (for testing) */
  clear(): void {
    this.capabilities.clear();
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

/** Global capability registry for this workspace */
export const capabilityRegistry = new CapabilityRegistry();


// ─── Domain capability auto-registration ────────────────────────────────────
// NOTE: Domain capabilities (plaid.getBalances, plaid.getHoldings, etc.) are
// now registered by @pendragon/tools-plaid via registerFromEnv() in
// server/tools/index.ts. The old registerAllCapabilities() call has been
// removed from here.
