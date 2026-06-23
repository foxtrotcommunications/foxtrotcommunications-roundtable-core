export type DomainType = 'checking' | 'savings' | 'investments' | 'retirement' | 'debt' | 'taxes' | 'realestate' | 'demographics';
export interface ToolParameters {
    type: 'object';
    properties: Record<string, {
        type: string;
        items?: {
            type: string;
        };
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
export interface WorkspaceCapability {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    handler: CapabilityHandler;
}
export type CapabilityHandler = (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
export interface PlaidPluginConfig {
    domainType: DomainType;
    accessToken: string;
    clientId: string;
    secret: string;
    env: 'sandbox' | 'production';
    itemId?: string;
    databaseUrl: string;
}
export interface ToolRegistry {
    register(name: string, tool: Tool): void;
}
export interface CapabilityRegistry {
    register(capability: WorkspaceCapability & {
        handler: CapabilityHandler;
    }): void;
}
//# sourceMappingURL=types%202.d.ts.map