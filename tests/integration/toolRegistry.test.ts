// tests/integration/toolRegistry.test.ts — Tool registry integration tests
//
// Tests the tool registry: static tool registration, resolveTools filtering,
// meta-tool behavior (alwaysEnabled), format converters (OpenAI, Anthropic,
// Google), dynamic tool registration, and executeTool dispatch.
//
// Uses the REAL tool registry — no mocks on the registry itself.

import {
  tools,
  resolveTools,
  getAvailableTools,
  toOpenAITools,
  toAnthropicTools,
  toGoogleTools,
  executeTool,
  registerDynamicTools,
  clearDynamicTools,
  getDynamicTools,
} from '../../server/tools/index';

// ─── Static Tool Registration ─────────────────────────────────────

describe('Tool Registry — static tools', () => {
  it('should have all expected static tools registered', () => {
    const expectedTools = [
      'describe_workspace', 'verify_workspace',
      'web_search', 'read_url', 'calculator', 'run_code',
      'git_clone', 'git_commit', 'git_pull',
      'read_file', 'write_file', 'list_files', 'find_file',
      'shell_exec', 'render_chart',
      'query_bigquery', 'query_snowflake', 'query_databricks',
      'download_query_results',
      'bridge_workspace', 'intent_bridge', 'call_agent',
    ];

    for (const name of expectedTools) {
      expect(tools[name]).toBeDefined();
    }
  });

  it('should have required properties on every tool', () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.type).toBe('object');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('should have parameters with properties object', () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.parameters.properties).toBeDefined();
      expect(typeof tool.parameters.properties).toBe('object');
    }
  });

  it('should mark meta-tools with alwaysEnabled flag', () => {
    expect(tools['describe_workspace'].alwaysEnabled).toBe(true);
    expect(tools['verify_workspace'].alwaysEnabled).toBe(true);
  });

  it('should NOT mark standard tools with alwaysEnabled', () => {
    expect(tools['calculator'].alwaysEnabled).toBeFalsy();
    expect(tools['web_search'].alwaysEnabled).toBeFalsy();
    expect(tools['read_file'].alwaysEnabled).toBeFalsy();
  });
});

// ─── resolveTools ─────────────────────────────────────────────────

describe('resolveTools', () => {
  afterEach(() => {
    // Clean up any dynamic tools registered during tests
    clearDynamicTools('test_');
  });

  it('should return all tools when enabledNames is null', () => {
    const resolved = resolveTools(null);
    expect(Object.keys(resolved).length).toBe(Object.keys(tools).length);
  });

  it('should return all tools when enabledNames is undefined', () => {
    const resolved = resolveTools(undefined);
    expect(Object.keys(resolved).length).toBe(Object.keys(tools).length);
  });

  it('should return all tools when enabledNames is empty array', () => {
    const resolved = resolveTools([]);
    expect(Object.keys(resolved).length).toBe(Object.keys(tools).length);
  });

  it('should filter to only the specified tools + meta-tools', () => {
    const resolved = resolveTools(['calculator', 'web_search']);
    const names = Object.keys(resolved);

    // Should include requested tools
    expect(names).toContain('calculator');
    expect(names).toContain('web_search');

    // Should include meta-tools (always enabled)
    expect(names).toContain('describe_workspace');
    expect(names).toContain('verify_workspace');

    // Should NOT include other standard tools
    expect(names).not.toContain('shell_exec');
    expect(names).not.toContain('read_file');
    expect(names).not.toContain('query_bigquery');
  });

  it('should always include meta-tools even when filtering', () => {
    // Only request one tool
    const resolved = resolveTools(['calculator']);
    const names = Object.keys(resolved);

    expect(names).toContain('describe_workspace');
    expect(names).toContain('verify_workspace');
    expect(names).toContain('calculator');
  });

  it('should always include dynamic tools even when filtering', () => {
    registerDynamicTools([
      {
        name: 'test_dynamic_tool',
        description: 'A dynamic tool for testing',
        parameters: { type: 'object' as const, properties: {}, required: [] },
        execute: jest.fn().mockResolvedValue({ ok: true }),
      },
    ]);

    const resolved = resolveTools(['calculator']);
    expect(resolved['test_dynamic_tool']).toBeDefined();
  });

  it('should ignore unknown tool names gracefully', () => {
    const resolved = resolveTools(['calculator', 'nonexistent_tool']);
    const names = Object.keys(resolved);

    expect(names).toContain('calculator');
    expect(names).not.toContain('nonexistent_tool');
  });
});

// ─── getAvailableTools ────────────────────────────────────────────

describe('getAvailableTools', () => {
  it('should return an array of tool definitions', () => {
    const available = getAvailableTools();
    expect(Array.isArray(available)).toBe(true);
    expect(available.length).toBeGreaterThan(0);
  });

  it('should include name, description, and parameters for each tool', () => {
    const available = getAvailableTools();
    for (const tool of available) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.parameters).toBeDefined();
    }
  });

  it('should NOT include execute function in the output', () => {
    const available = getAvailableTools();
    for (const tool of available) {
      expect((tool as any).execute).toBeUndefined();
    }
  });
});

// ─── Format Converters ────────────────────────────────────────────

describe('toOpenAITools', () => {
  it('should produce valid OpenAI tool format', () => {
    const openaiTools = toOpenAITools(null);
    expect(Array.isArray(openaiTools)).toBe(true);
    expect(openaiTools.length).toBeGreaterThan(0);

    for (const tool of openaiTools) {
      expect(tool.type).toBe('function');
      expect(tool.function).toBeDefined();
      expect(typeof tool.function.name).toBe('string');
      expect(typeof tool.function.description).toBe('string');
      expect(tool.function.parameters).toBeDefined();
    }
  });

  it('should respect enabledNames filter', () => {
    const filtered = toOpenAITools(['calculator']);
    const names = filtered.map((t: any) => t.function.name);

    expect(names).toContain('calculator');
    // Meta-tools should also be present
    expect(names).toContain('describe_workspace');
    expect(names).toContain('verify_workspace');
  });

  it('should include the calculator tool with correct structure', () => {
    const tools = toOpenAITools(['calculator']);
    const calc = tools.find((t: any) => t.function.name === 'calculator');

    expect(calc).toBeDefined();
    expect(calc!.type).toBe('function');
    expect(calc!.function.parameters.type).toBe('object');
    expect(calc!.function.parameters.properties.expression).toBeDefined();
  });
});

describe('toAnthropicTools', () => {
  it('should produce valid Anthropic tool format', () => {
    const anthropicTools = toAnthropicTools(null);
    expect(Array.isArray(anthropicTools)).toBe(true);
    expect(anthropicTools.length).toBeGreaterThan(0);

    for (const tool of anthropicTools) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
    }
  });

  it('should use input_schema instead of parameters', () => {
    const tools = toAnthropicTools(['calculator']);
    const calc = tools.find((t: any) => t.name === 'calculator');

    expect(calc).toBeDefined();
    expect(calc!.input_schema).toBeDefined();
    expect((calc as any).parameters).toBeUndefined();
    expect((calc as any).function).toBeUndefined();
  });
});

describe('toGoogleTools', () => {
  it('should produce valid Google/Gemini tool format', () => {
    const googleTools = toGoogleTools(null);
    expect(Array.isArray(googleTools)).toBe(true);
    expect(googleTools.length).toBe(1); // wrapped in single functionDeclarations object

    const wrapper = googleTools[0];
    expect(wrapper.functionDeclarations).toBeInstanceOf(Array);
    expect(wrapper.functionDeclarations.length).toBeGreaterThan(0);
  });

  it('should include name, description, and parameters for each function declaration', () => {
    const googleTools = toGoogleTools(null);
    const declarations = googleTools[0].functionDeclarations;

    for (const decl of declarations) {
      expect(typeof decl.name).toBe('string');
      expect(typeof decl.description).toBe('string');
      expect(decl.parameters).toBeDefined();
    }
  });

  it('should strip empty required arrays from parameters', () => {
    const googleTools = toGoogleTools(null);
    const declarations = googleTools[0].functionDeclarations;

    for (const decl of declarations) {
      if (decl.parameters.required) {
        // If required exists, it should not be empty
        expect(decl.parameters.required.length).toBeGreaterThan(0);
      }
    }
  });
});

// ─── Dynamic Tool Registration ────────────────────────────────────

describe('registerDynamicTools / clearDynamicTools / getDynamicTools', () => {
  afterEach(() => {
    clearDynamicTools('mcp_');
    clearDynamicTools('test_');
  });

  it('should register dynamic tools', () => {
    registerDynamicTools([
      {
        name: 'mcp_server_search',
        description: 'Search via MCP server',
        parameters: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] },
        execute: jest.fn().mockResolvedValue({ results: [] }),
      },
    ]);

    const dynamic = getDynamicTools();
    expect(dynamic['mcp_server_search']).toBeDefined();
    expect(dynamic['mcp_server_search'].name).toBe('mcp_server_search');
  });

  it('should include dynamic tools in resolveTools', () => {
    registerDynamicTools([
      {
        name: 'mcp_test_tool',
        description: 'Test MCP tool',
        parameters: { type: 'object' as const, properties: {}, required: [] },
        execute: jest.fn(),
      },
    ]);

    const resolved = resolveTools(null);
    expect(resolved['mcp_test_tool']).toBeDefined();
  });

  it('should clear dynamic tools by prefix', () => {
    registerDynamicTools([
      {
        name: 'mcp_server1_search',
        description: 'Server 1 search',
        parameters: { type: 'object' as const, properties: {}, required: [] },
        execute: jest.fn(),
      },
      {
        name: 'mcp_server1_query',
        description: 'Server 1 query',
        parameters: { type: 'object' as const, properties: {}, required: [] },
        execute: jest.fn(),
      },
      {
        name: 'mcp_server2_search',
        description: 'Server 2 search',
        parameters: { type: 'object' as const, properties: {}, required: [] },
        execute: jest.fn(),
      },
    ]);

    // Clear only server1 tools
    clearDynamicTools('mcp_server1_');

    const dynamic = getDynamicTools();
    expect(dynamic['mcp_server1_search']).toBeUndefined();
    expect(dynamic['mcp_server1_query']).toBeUndefined();
    expect(dynamic['mcp_server2_search']).toBeDefined();
  });

  it('should allow overwriting existing dynamic tools', () => {
    const execute1 = jest.fn();
    const execute2 = jest.fn();

    registerDynamicTools([
      {
        name: 'mcp_tool',
        description: 'Version 1',
        parameters: { type: 'object' as const, properties: {}, required: [] },
        execute: execute1,
      },
    ]);

    registerDynamicTools([
      {
        name: 'mcp_tool',
        description: 'Version 2',
        parameters: { type: 'object' as const, properties: {}, required: [] },
        execute: execute2,
      },
    ]);

    const dynamic = getDynamicTools();
    expect(dynamic['mcp_tool'].description).toBe('Version 2');
  });
});

// ─── executeTool ──────────────────────────────────────────────────

describe('executeTool', () => {
  it('should execute the calculator tool', async () => {
    const result = await executeTool('calculator', { expression: '10 * 5' });
    expect(result.result).toBe('50');
  });

  it('should throw for unknown tool', async () => {
    await expect(
      executeTool('definitely_not_a_real_tool', {})
    ).rejects.toThrow(/Unknown tool/);
  });

  it('should execute a dynamically registered tool', async () => {
    const mockExecute = jest.fn().mockResolvedValue({ data: 'dynamic result' });
    registerDynamicTools([
      {
        name: 'test_exec_dynamic',
        description: 'Test dynamic exec',
        parameters: { type: 'object' as const, properties: {}, required: [] },
        execute: mockExecute,
      },
    ]);

    const result = await executeTool('test_exec_dynamic', { foo: 'bar' });
    expect(result.data).toBe('dynamic result');
    expect(mockExecute).toHaveBeenCalledWith({ foo: 'bar' }, {});

    clearDynamicTools('test_');
  });

  it('should pass workspaceConfig to tool execute', async () => {
    const mockExecute = jest.fn().mockResolvedValue({ ok: true });
    registerDynamicTools([
      {
        name: 'test_config_pass',
        description: 'Test config passing',
        parameters: { type: 'object' as const, properties: {}, required: [] },
        execute: mockExecute,
      },
    ]);

    await executeTool('test_config_pass', { arg: 1 }, { dataSources: { bigquery: { project: 'proj' } } });
    expect(mockExecute).toHaveBeenCalledWith(
      { arg: 1 },
      { dataSources: { bigquery: { project: 'proj' } } }
    );

    clearDynamicTools('test_');
  });
});
