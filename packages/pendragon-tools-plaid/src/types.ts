// src/types.ts — Type definitions for @pendragon/tools-plaid
// Duck-typed interfaces compatible with roundtable-core to avoid direct coupling.

// ─── Domain Types ───────────────────────────────────────────────────────────

export type DomainType = 'checking' | 'savings' | 'investments' | 'retirement' | 'debt' | 'taxes' | 'realestate' | 'demographics';

// ─── Tool Interface (matches roundtable-core's Tool) ────────────────────────

export interface ToolParameters {
  type: 'object';
  properties: Record<string, {
    type: string;
    items?: { type: string };
    description?: string;
    enum?: string[];
    default?: unknown;
  }>;
  required?: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameters;
  alwaysEnabled?: boolean;
  execute: (args: Record<string, unknown>, workspaceConfig?: unknown) => Promise<Record<string, unknown>>;
}

// ─── Capability Interfaces (matches roundtable-core's capability registry) ──

export interface WorkspaceCapability {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  handler: CapabilityHandler;
}

export type CapabilityHandler = (
  input: Record<string, unknown>,
  ctx: unknown,
) => Promise<unknown>;

// ─── Plugin Config ──────────────────────────────────────────────────────────

export interface PlaidPluginConfig {
  domainType: DomainType;
  accessToken: string;
  clientId: string;
  secret: string;
  env: 'sandbox' | 'production';
  itemId?: string;
  databaseUrl: string;
}

// ─── Registry Interfaces (duck-typed) ───────────────────────────────────────

export interface ToolRegistry {
  register(name: string, tool: Tool): void;
}

export interface CapabilityRegistry {
  register(capability: WorkspaceCapability & { handler: CapabilityHandler }): void;
}
