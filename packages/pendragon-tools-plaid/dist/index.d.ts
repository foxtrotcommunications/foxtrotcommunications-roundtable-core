import type { DomainType, ToolRegistry, CapabilityRegistry, PlaidPluginConfig } from './types.js';
export { ScopedPlaidClient } from './plaid/client.js';
export { ensureDefaultGoals } from './domains/autoGoals.js';
export * from './types.js';
export declare const pendragonPlaid: {
    name: "pendragon-plaid";
    version: string;
    register(toolRegistry: ToolRegistry, capabilityRegistry: CapabilityRegistry, config: PlaidPluginConfig): void;
    getAllowedOps(domainType: DomainType): string[];
    getCapabilities(domainType: DomainType): string[];
};
export declare function registerFromEnv(toolRegistry: ToolRegistry, capabilityRegistry: CapabilityRegistry): void;
//# sourceMappingURL=index.d.ts.map