import type { PlaidPluginConfig } from '../types.js';
/**
 * Check if this domain has any goals. If not, auto-generate sensible defaults.
 * Called after sync completes. Each domain MUST have at least one goal.
 */
export declare function ensureDefaultGoals(config: PlaidPluginConfig): Promise<void>;
//# sourceMappingURL=autoGoals.d.ts.map