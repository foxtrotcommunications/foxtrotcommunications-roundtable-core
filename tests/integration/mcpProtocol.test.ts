// tests/integration/mcpProtocol.test.ts — MCP JSON-RPC 2.0 protocol tests
//
// Tests the MCP server handler for JSON-RPC compliance: initialize,
// tools/list, tools/call, error handling, and method dispatch.
//
// Mocks: tools/index (resolveTools, executeTool), config
// Real:  JSON-RPC envelope validation, method routing

// ─── Mock Dependencies ────────────────────────────────────────────

const mockTools: Record<string, any> = {
  calculator: {
    name: 'calculator',
    description: 'Evaluate math expressions',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'The expression' },
      },
      required: ['expression'],
    },
    execute: jest.fn().mockResolvedValue({ result: '4' }),
  },
  web_search: {
    name: 'web_search',
    description: 'Search the web',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
    execute: jest.fn().mockResolvedValue({ results: [] }),
  },
};

jest.mock('../../server/tools/index', () => ({
  resolveTools: jest.fn((enabledNames?: string[] | null) => {
    if (!enabledNames || enabledNames.length === 0) return { ...mockTools };
    const filtered: Record<string, any> = {};
    for (const name of enabledNames) {
      if (mockTools[name]) filtered[name] = mockTools[name];
    }
    return filtered;
  }),
  executeTool: jest.fn(async (name: string, args: any) => {
    const tool = mockTools[name];
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.execute(args);
  }),
}));

jest.mock('../../server/config', () => ({
  workspaceId: 'test-mcp-workspace',
  workspaceName: 'Test MCP Workspace',
  mcpApiKey: 'test-mcp-key',
}));

// ─── Import MCP Handler ──────────────────────────────────────────

const { createMcpRequestHandler } = require('../../server/mcp/server');

// ─── Express Mock Helpers ─────────────────────────────────────────

interface MockResponse {
  statusCode: number;
  body: any;
  status: (code: number) => MockResponse;
  json: (data: any) => MockResponse;
}

function createMockRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

function makeJsonRpcRequest(method: string, params?: any, id: number | string = 1) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method,
    params,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('MCP Protocol — initialize', () => {
  const handler = createMcpRequestHandler(null);

  it('should return server capabilities and protocol version', async () => {
    const req = { body: makeJsonRpcRequest('initialize') };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBe(1);
    expect(res.body.result).toBeDefined();
    expect(res.body.result.protocolVersion).toBe('2025-03-26');
    expect(res.body.result.capabilities).toBeDefined();
    expect(res.body.result.capabilities.tools).toBeDefined();
    expect(res.body.result.serverInfo).toBeDefined();
    expect(res.body.result.serverInfo.name).toMatch(/roundtable-/);
    expect(res.body.result.serverInfo.version).toBe('1.0.0');
  });

  it('should use the request id in the response', async () => {
    const req = { body: makeJsonRpcRequest('initialize', undefined, 42) };
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.id).toBe(42);
  });

  it('should handle string id', async () => {
    const req = { body: makeJsonRpcRequest('initialize', undefined, 'init-1') };
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.id).toBe('init-1');
  });
});

describe('MCP Protocol — notifications/initialized', () => {
  const handler = createMcpRequestHandler(null);

  it('should accept the initialized notification', async () => {
    const req = { body: makeJsonRpcRequest('notifications/initialized') };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });
});

describe('MCP Protocol — tools/list', () => {
  it('should return all tools when no filter is applied', async () => {
    const handler = createMcpRequestHandler(null);
    const req = { body: makeJsonRpcRequest('tools/list') };
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.result).toBeDefined();
    expect(res.body.result.tools).toBeInstanceOf(Array);
    expect(res.body.result.tools.length).toBe(2); // calculator + web_search

    const names = res.body.result.tools.map((t: any) => t.name);
    expect(names).toContain('calculator');
    expect(names).toContain('web_search');
  });

  it('should return tools with name, description, and inputSchema', async () => {
    const handler = createMcpRequestHandler(null);
    const req = { body: makeJsonRpcRequest('tools/list') };
    const res = createMockRes();

    await handler(req, res);

    const calcTool = res.body.result.tools.find((t: any) => t.name === 'calculator');
    expect(calcTool).toBeDefined();
    expect(calcTool.name).toBe('calculator');
    expect(calcTool.description).toBe('Evaluate math expressions');
    expect(calcTool.inputSchema).toBeDefined();
    expect(calcTool.inputSchema.type).toBe('object');
    expect(calcTool.inputSchema.properties.expression).toBeDefined();
  });

  it('should pass enabledToolNames to resolveTools', async () => {
    const handler = createMcpRequestHandler(['calculator']);
    const req = { body: makeJsonRpcRequest('tools/list') };
    const res = createMockRes();

    await handler(req, res);

    const { resolveTools } = require('../../server/tools/index');
    expect(resolveTools).toHaveBeenCalledWith(['calculator']);
  });
});

describe('MCP Protocol — tools/call', () => {
  const handler = createMcpRequestHandler(null);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should execute a valid tool and return result', async () => {
    const req = {
      body: makeJsonRpcRequest('tools/call', { name: 'calculator', arguments: { expression: '2+2' } }),
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBe(1);
    expect(res.body.result).toBeDefined();
    expect(res.body.result.content).toBeInstanceOf(Array);
    expect(res.body.result.content[0].type).toBe('text');

    const parsed = JSON.parse(res.body.result.content[0].text);
    expect(parsed.result).toBe('4');
  });

  it('should return error content for unknown tool', async () => {
    const { executeTool } = require('../../server/tools/index');
    executeTool.mockRejectedValueOnce(new Error('Unknown tool: nonexistent'));

    const req = {
      body: makeJsonRpcRequest('tools/call', { name: 'nonexistent', arguments: {} }),
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.result).toBeDefined();
    expect(res.body.result.isError).toBe(true);

    const parsed = JSON.parse(res.body.result.content[0].text);
    expect(parsed.error).toMatch(/Unknown tool/);
  });

  it('should return error when tool name is missing', async () => {
    const req = {
      body: makeJsonRpcRequest('tools/call', { arguments: {} }),
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32600); // INVALID_REQUEST
    expect(res.body.error.message).toMatch(/Missing required param: name/);
  });

  it('should pass arguments to the tool executor', async () => {
    const { executeTool } = require('../../server/tools/index');

    const req = {
      body: makeJsonRpcRequest('tools/call', { name: 'calculator', arguments: { expression: '3*7' } }),
    };
    const res = createMockRes();

    await handler(req, res);

    expect(executeTool).toHaveBeenCalledWith('calculator', { expression: '3*7' });
  });

  it('should default arguments to empty object when not provided', async () => {
    const { executeTool } = require('../../server/tools/index');

    const req = {
      body: makeJsonRpcRequest('tools/call', { name: 'calculator' }),
    };
    const res = createMockRes();

    await handler(req, res);

    expect(executeTool).toHaveBeenCalledWith('calculator', {});
  });
});

describe('MCP Protocol — Invalid JSON-RPC', () => {
  const handler = createMcpRequestHandler(null);

  it('should reject when jsonrpc is not "2.0"', async () => {
    const req = {
      body: { jsonrpc: '1.0', id: 1, method: 'initialize' },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200); // JSON-RPC errors still use HTTP 200
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32600); // INVALID_REQUEST
  });

  it('should reject when method is missing', async () => {
    const req = {
      body: { jsonrpc: '2.0', id: 1 },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32600);
  });

  it('should reject when body is null', async () => {
    const req = { body: null };
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32600);
  });

  it('should reject when body is empty object', async () => {
    const req = { body: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32600);
  });

  it('should use null for id when not provided', async () => {
    const req = { body: { jsonrpc: '1.0' } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.id).toBeNull();
  });
});

describe('MCP Protocol — Unknown Method', () => {
  const handler = createMcpRequestHandler(null);

  it('should return METHOD_NOT_FOUND for unknown methods', async () => {
    const req = { body: makeJsonRpcRequest('foo/bar') };
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32601); // METHOD_NOT_FOUND
    expect(res.body.error.message).toMatch(/Method not found: foo\/bar/);
  });

  it('should preserve the request id in error responses', async () => {
    const req = { body: makeJsonRpcRequest('nonexistent', undefined, 99) };
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.id).toBe(99);
  });
});
