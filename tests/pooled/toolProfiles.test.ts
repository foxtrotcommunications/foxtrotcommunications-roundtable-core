/**
 * Tool profiles (upgrade plan 0.1) — deny by default, enforced at execution.
 *
 *   - NULL enabled_tools = registry minus DANGEROUS_TOOLS, and it MUST still
 *     contain intent_bridge and every ordinary tool (the 2026-08-14
 *     regression: a "NULL means nothing" reading silently dropped consults).
 *   - An explicit list is enforced at executeTool, not only at advertisement.
 *   - RT_TOOL_PROFILE_ENFORCE=warn logs and runs; =deny throws ToolNotEnabled;
 *     pooled services deny regardless of the flag.
 *   - The 'delegated' profile is read-only tools + intent_bridge, and never
 *     widens the workspace's own list.
 */

const mockConfig: any = {
  pooled: false,
  pooledArthur: false,
  pooledDomainType: null,
  workspaceId: 'ws-profiles',
  workspaceName: 'Profiles',
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
  ToolNotEnabled,
  enforcementMode,
  resolveTools,
  executeTool,
  toOpenAITools,
  registerDynamicTools,
  clearDynamicTools,
} from '../../server/tools/index';

const ORIGINAL_ENV = process.env.RT_TOOL_PROFILE_ENFORCE;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.RT_TOOL_PROFILE_ENFORCE;
  else process.env.RT_TOOL_PROFILE_ENFORCE = ORIGINAL_ENV;
  mockConfig.pooled = false;
  jest.restoreAllMocks();
});

describe('DANGEROUS_TOOLS', () => {
  it('is exactly the plan\'s six and every one is a registered core tool', () => {
    expect([...DANGEROUS_TOOLS].sort()).toEqual(
      ['git_clone', 'git_commit', 'git_pull', 'run_code', 'shell_exec', 'write_file'],
    );
    for (const name of DANGEROUS_TOOLS) expect(tools[name]).toBeDefined();
  });
});

describe('resolveTools — default profile (NULL enabled_tools)', () => {
  it('excludes every dangerous tool', () => {
    const resolved = resolveTools(null);
    for (const name of DANGEROUS_TOOLS) expect(resolved[name]).toBeUndefined();
  });

  it('still includes intent_bridge and every non-dangerous tool (2026-08-14 lesson)', () => {
    const resolved = resolveTools(null);
    expect(resolved['intent_bridge']).toBeDefined();
    expect(resolved['bridge_workspace']).toBeDefined();
    expect(resolved['describe_workspace']).toBeDefined();
    for (const name of Object.keys(tools)) {
      if (!DANGEROUS_TOOLS.includes(name)) expect(resolved[name]).toBeDefined();
    }
  });

  it('treats undefined and [] like NULL', () => {
    expect(Object.keys(resolveTools(undefined)).sort()).toEqual(Object.keys(resolveTools(null)).sort());
    expect(Object.keys(resolveTools([])).sort()).toEqual(Object.keys(resolveTools(null)).sort());
  });

  it('includes a dangerous tool only when enabled_tools names it', () => {
    expect(resolveTools(['calculator'])['shell_exec']).toBeUndefined();
    expect(resolveTools(['calculator', 'shell_exec'])['shell_exec']).toBeDefined();
    // Naming one dangerous tool does not drag the others in
    expect(resolveTools(['calculator', 'shell_exec'])['run_code']).toBeUndefined();
  });

  it('advertises the same set it will execute', () => {
    const advertised = toOpenAITools(null).map((t: any) => t.function.name);
    for (const name of DANGEROUS_TOOLS) expect(advertised).not.toContain(name);
    expect(advertised).toContain('intent_bridge');
  });
});

describe('resolveTools — delegated profile', () => {
  it('is read-only tools + intent_bridge + meta-tools', () => {
    const resolved = resolveTools(null, 'delegated');
    const names = Object.keys(resolved);
    expect(names).toContain('intent_bridge');
    expect(names).toContain('calculator');
    expect(names).toContain('read_file');
    expect(names).toContain('query_bigquery');
    expect(names).toContain('describe_workspace');
    // Side-effecting tools are out even though the default profile has them
    expect(names).not.toContain('bridge_workspace');
    expect(names).not.toContain('emit_provenance');
    expect(names).not.toContain('download_query_results');
    expect(names).not.toContain('call_agent');
    for (const name of DANGEROUS_TOOLS) expect(names).not.toContain(name);
    for (const name of names) {
      const t: any = resolved[name];
      expect(t.alwaysEnabled || t.readOnly === true || name === 'intent_bridge').toBe(true);
    }
  });

  it('never widens the workspace\'s own enabled list', () => {
    const resolved = resolveTools(['calculator'], 'delegated');
    expect(Object.keys(resolved).sort()).toEqual(
      ['calculator', 'describe_workspace', 'verify_workspace'].sort(),
    );
  });

  it('excludes dynamic (MCP) tools unless they declare readOnly', () => {
    registerDynamicTools([
      { name: 'mcp_x_write', description: 'w', parameters: { type: 'object', properties: {} }, execute: async () => ({}) } as any,
      { name: 'mcp_x_read', description: 'r', parameters: { type: 'object', properties: {} }, readOnly: true, execute: async () => ({}) } as any,
    ]);
    try {
      const resolved = resolveTools(null, 'delegated');
      expect(resolved['mcp_x_read']).toBeDefined();
      expect(resolved['mcp_x_write']).toBeUndefined();
      // default profile keeps both (MCP tools have their own governance)
      expect(resolveTools(null)['mcp_x_write']).toBeDefined();
    } finally {
      clearDynamicTools('mcp_x_');
    }
  });
});

describe('executeTool — allowlist enforced at execution', () => {
  it('RT_TOOL_PROFILE_ENFORCE defaults to deny everywhere; warn is opt-in on dedicated only', () => {
    // Independent review 2026-10-03 R1: a warn default left run_code (and the
    // vm escape to BRIDGE_HMAC_SECRET) reachable from any NULL-row dedicated
    // pod. The shipped default must fail closed.
    delete process.env.RT_TOOL_PROFILE_ENFORCE;
    expect(enforcementMode()).toBe('deny');
    process.env.RT_TOOL_PROFILE_ENFORCE = 'garbage';
    expect(enforcementMode()).toBe('deny');
    process.env.RT_TOOL_PROFILE_ENFORCE = 'warn';
    expect(enforcementMode()).toBe('warn');
    mockConfig.pooled = true;
    expect(enforcementMode()).toBe('deny');
  });

  it('with no flag set, a NULL-row dedicated workspace cannot execute run_code', async () => {
    delete process.env.RT_TOOL_PROFILE_ENFORCE;
    mockConfig.pooled = false;
    await expect(executeTool('run_code', { code: '1+1' }, { enabledToolNames: null, workspaceId: 'ws-null' }))
      .rejects.toMatchObject({ code: 'TOOL_NOT_ENABLED' });
  });

  it('deny: a tool outside the explicit list throws ToolNotEnabled before running', async () => {
    process.env.RT_TOOL_PROFILE_ENFORCE = 'deny';
    const spy = jest.spyOn(tools.read_url, 'execute');
    await expect(
      executeTool('read_url', { url: 'https://example.com' }, {}, { enabledToolNames: ['calculator'] }),
    ).rejects.toBeInstanceOf(ToolNotEnabled);
    expect(spy).not.toHaveBeenCalled();
  });

  it('deny: a dangerous tool under NULL enabled_tools is refused', async () => {
    process.env.RT_TOOL_PROFILE_ENFORCE = 'deny';
    const spy = jest.spyOn(tools.shell_exec, 'execute');
    await expect(
      executeTool('shell_exec', { command: 'ls' }, {}, { enabledToolNames: null }),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_ENABLED', status: 403 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('deny: a dangerous tool runs when the workspace named it explicitly', async () => {
    process.env.RT_TOOL_PROFILE_ENFORCE = 'deny';
    const spy = jest.spyOn(tools.shell_exec, 'execute').mockResolvedValue({ ok: true } as any);
    const out = await executeTool('shell_exec', { command: 'ls' }, {}, { enabledToolNames: ['shell_exec'] });
    expect(out).toEqual({ ok: true });
    expect(spy).toHaveBeenCalled();
  });

  it('deny: a caller that passes no allowlist gets the default profile (fails closed on dangerous)', async () => {
    process.env.RT_TOOL_PROFILE_ENFORCE = 'deny';
    await expect(executeTool('run_code', { code: '1' }, {})).rejects.toBeInstanceOf(ToolNotEnabled);
    // ...and open on ordinary tools
    const out = await executeTool('calculator', { expression: '2+2' }, {});
    expect(out.result).toBe('4');
  });

  it('warn: logs and executes a tool outside the list (dedicated transition mode)', async () => {
    process.env.RT_TOOL_PROFILE_ENFORCE = 'warn';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await executeTool('calculator', { expression: '6*7' }, {}, { enabledToolNames: ['read_url'] });
    expect(out.result).toBe('42');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('WARN-ONLY'))).toBe(true);
  });

  it('pooled: denies regardless of the flag', async () => {
    process.env.RT_TOOL_PROFILE_ENFORCE = 'warn';
    mockConfig.pooled = true;
    await expect(
      executeTool('calculator', { expression: '1' }, {}, { enabledToolNames: ['read_url'] }),
    ).rejects.toBeInstanceOf(ToolNotEnabled);
  });

  it('delegated profile is honored via workspaceConfig.toolProfile', async () => {
    process.env.RT_TOOL_PROFILE_ENFORCE = 'deny';
    const spy = jest.spyOn(tools.bridge_workspace, 'execute');
    await expect(
      executeTool('bridge_workspace', { action: 'delegate' }, { toolProfile: 'delegated' }, { enabledToolNames: null }),
    ).rejects.toBeInstanceOf(ToolNotEnabled);
    expect(spy).not.toHaveBeenCalled();
    const out = await executeTool('calculator', { expression: '1+1' }, { toolProfile: 'delegated' }, { enabledToolNames: null });
    expect(out.result).toBe('2');
  });

  it('unknown tools still throw Unknown tool (not ToolNotEnabled)', async () => {
    process.env.RT_TOOL_PROFILE_ENFORCE = 'deny';
    await expect(executeTool('no_such_tool', {}, {})).rejects.toThrow(/Unknown tool/);
  });
});
