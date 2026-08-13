/**
 * processMessage tenant options (pooled-arthur-plan step 9):
 * tenantWsId stamps the task (tasks/get tenant isolation), and
 * workspaceName drives the pre-consult gate + span identity — pooled rows
 * are all named 'Arthur', so the gate fires per tenant.
 * Dedicated (no options): tenantWsId stays unset, config values apply.
 */

const mockConfig: any = {
  pooledArthur: false,
  pooled: false,
  workspaceId: 'ded-ws',
  workspaceName: 'Dedicated WS',
};
jest.mock('../../server/config', () => mockConfig);

// Fake model stream: one text chunk, then done.
const mockStreamCompletion = jest.fn(async function* () {
  yield { type: 'text-delta', content: 'hello from the model' };
  yield { type: 'done', fullText: 'hello from the model' };
});
jest.mock('../../server/services/aiProvider', () => ({ streamCompletion: mockStreamCompletion }));

const mockExecuteTool = jest.fn();
jest.mock('../../server/tools', () => ({ executeTool: mockExecuteTool }));
jest.mock('../../server/tracing/collector', () => ({ recordSpan: jest.fn() }));

const { processMessage, getTask } = require('../../server/a2a/server');
const { registerPreConsultDescriber, _resetAppHooks } = require('../../server/a2a/appHooks');

function textMessage(text: string) {
  return { role: 'user' as const, parts: [{ type: 'text' as const, text }] };
}

function baseOptions(extra: Record<string, unknown> = {}) {
  return {
    message: textMessage('hi'),
    provider: 'openai',
    model: 'test-model',
    apiKey: 'k',
    enabledToolNames: null,
    workspaceConfig: {},
    ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  _resetAppHooks();
  jest.restoreAllMocks();
});

describe('processMessage — tenant stamping', () => {
  it('stamps task.tenantWsId from options and isolates reads by tenant', async () => {
    const task = await processMessage(baseOptions({ tenantWsId: 'ws-a', workspaceName: 'Arthur' }));
    expect(task.status.state).toBe('completed');
    expect(task.tenantWsId).toBe('ws-a');
    // Same tenant reads it; another tenant sees not-found (no existence oracle)
    expect(getTask(task.id, 'ws-a')).toBe(task);
    expect(getTask(task.id, 'ws-b')).toBeUndefined();
    expect(getTask(task.id, '')).toBeUndefined();
  });

  it('dedicated (no tenant option): no stamp, unscoped reads work', async () => {
    const task = await processMessage(baseOptions());
    expect(task.status.state).toBe('completed');
    expect(task.tenantWsId).toBeUndefined();
    expect(getTask(task.id)).toBe(task);
  });
});

describe('processMessage — pre-consults fire per tenant workspaceName', () => {
  it('passes options.workspaceName to the pre-consult gate and executes with the tenant workspaceConfig', async () => {
    const describer = jest.fn((ctx: { workspaceName?: string }) =>
      ctx.workspaceName === 'Arthur'
        ? [{ args: { target: 'demographics', op: 'capability', name: 'demographics.snapshot' }, label: 'Demographics' }]
        : []
    );
    registerPreConsultDescriber(describer);
    mockExecuteTool.mockResolvedValue({ success: true, data: { people: 2 } });

    const workspaceConfig = { workspaceId: 'ws-a', tenant: { workspaceId: 'ws-a', orgId: 'org-a' } };
    const task = await processMessage(baseOptions({ tenantWsId: 'ws-a', workspaceName: 'Arthur', workspaceConfig }));

    expect(task.status.state).toBe('completed');
    expect(describer).toHaveBeenCalledWith({ workspaceName: 'Arthur' });
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    const [toolName, , cfg] = mockExecuteTool.mock.calls[0];
    expect(toolName).toBe('intent_bridge');
    expect(cfg.workspaceId).toBe('ws-a');
    expect(cfg.tenant).toEqual({ workspaceId: 'ws-a', orgId: 'org-a' });
  });

  it('dedicated: the gate sees config.workspaceName', async () => {
    const describer = jest.fn(() => []);
    registerPreConsultDescriber(describer);
    await processMessage(baseOptions());
    expect(describer).toHaveBeenCalledWith({ workspaceName: 'Dedicated WS' });
  });
});
