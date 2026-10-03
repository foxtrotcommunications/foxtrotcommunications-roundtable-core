/**
 * Pooled registry hard-exclusion (upgrade plan 0.2).
 *
 * With config.pooled the dangerous tools are not REGISTERED — not merely
 * filtered — so no enabled_tools row, plugin registration or dynamic MCP
 * discovery can opt a tenant back into code execution on a shared replica.
 */

const mockConfig: any = {
  pooled: true,
  pooledArthur: false,
  pooledDomainType: 'checking',
  workspaceId: 'default',
  workspaceName: 'pooled',
  bridgeHmacSecret: 'x',
  ai: {},
  vertexai: { project: '', location: '' },
  googleSearch: { apiKey: '', engineId: '' },
  snowflake: {}, databricks: {}, ollama: { host: '' },
};
jest.mock('../../server/config', () => mockConfig);

import {
  tools,
  DANGEROUS_TOOLS,
  resolveTools,
  executeTool,
  getAvailableTools,
  registerDynamicTools,
  getDynamicTools,
  clearDynamicTools,
} from '../../server/tools/index';

describe('pooled registry excludes dangerous tools', () => {
  it('does not register any dangerous tool', () => {
    for (const name of DANGEROUS_TOOLS) expect(tools[name]).toBeUndefined();
    const advertised = getAvailableTools().map((t: any) => t.name);
    for (const name of DANGEROUS_TOOLS) expect(advertised).not.toContain(name);
  });

  it('keeps every ordinary tool, including intent_bridge', () => {
    expect(tools['intent_bridge']).toBeDefined();
    expect(tools['calculator']).toBeDefined();
    expect(tools['query_bigquery']).toBeDefined();
    expect(tools['describe_workspace']).toBeDefined();
  });

  it('cannot be opted into via enabled_tools', () => {
    const resolved = resolveTools(['calculator', 'shell_exec', 'run_code']);
    expect(resolved['shell_exec']).toBeUndefined();
    expect(resolved['run_code']).toBeUndefined();
    expect(resolved['calculator']).toBeDefined();
  });

  it('executeTool reports the tool as unknown even with an explicit allowlist', async () => {
    await expect(
      executeTool('shell_exec', { command: 'ls' }, {}, { enabledToolNames: ['shell_exec'] }),
    ).rejects.toThrow(/Unknown tool: shell_exec/);
  });

  it('refuses a dynamic registration under a dangerous name', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      registerDynamicTools([
        { name: 'write_file', description: 'smuggled', parameters: { type: 'object', properties: {} }, execute: async () => ({}) } as any,
        { name: 'mcp_ok_tool', description: 'fine', parameters: { type: 'object', properties: {} }, execute: async () => ({}) } as any,
      ]);
      expect(getDynamicTools()['write_file']).toBeUndefined();
      expect(getDynamicTools()['mcp_ok_tool']).toBeDefined();
      expect(warn.mock.calls.some((c) => String(c[0]).includes("Refused to register dangerous tool 'write_file'"))).toBe(true);
    } finally {
      clearDynamicTools('mcp_ok_tool');
      warn.mockRestore();
    }
  });
});
