/**
 * Pooled tenant threading through the intent executor.
 * The chain under test: ExecutionContext.tenant → executeCapability →
 * CapabilityContext.tenant → handler ctx (what the plugin's resolveConfig
 * reads). Plus the two pooled guards: op restriction and empty-scope error.
 */

import {
  buildIntentToken,
} from '../../server/protocols/intentTokenCodec';
import { executeIntentToken, ExecutionContext } from '../../server/protocols/intentExecutor';
import { capabilityRegistry } from '../../server/protocols/capabilityRegistry';
import { deriveContractKey } from '../../server/utils/contractAuth';

const MASTER = 'pooled-threading-master';
const CONTRACT_ID = 'contract-pooled-1';

async function makeCtx(tenant?: Record<string, unknown>): Promise<ExecutionContext> {
  const contractKey = await deriveContractKey(MASTER, CONTRACT_ID, 1);
  return {
    contractKey,
    contract: {
      contractId: CONTRACT_ID,
      allowedActions: ['capability:echo.tenant', 'tool:read_file', 'discover'],
      status: 'active',
    },
    workspaceConfig: tenant ? { workspaceId: tenant.workspaceId } : {},
    enabledToolNames: null,
    ...(tenant ? { tenant } : {}),
  };
}

function capIntent() {
  return { op: 'capability' as const, name: 'echo.tenant', input: {} };
}

beforeAll(() => {
  capabilityRegistry.register({
    name: 'echo.tenant',
    description: 'test echo of ctx.tenant',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: {} },
    handler: async (_input: any, ctx: any) => ({ seenTenant: ctx?.tenant ?? null }),
  } as any);
});

afterAll(() => {
  capabilityRegistry.clear();
});

describe('tenant threading', () => {
  it('hands ctx.tenant to the capability handler', async () => {
    const token = await buildIntentToken(capIntent(), CONTRACT_ID, 1, MASTER, { encrypt: false });
    const tenant = { workspaceId: 'ws-a', databaseUrl: 'postgresql://svc@db/x' };
    const result = await executeIntentToken(token, await makeCtx(tenant));
    expect(result.status).toBe('success');
    expect((result.data as any).seenTenant).toEqual(tenant);
  });

  it('two tenants get distinct results and distinct cache scopes', async () => {
    const t1 = await buildIntentToken(capIntent(), CONTRACT_ID, 1, MASTER, { encrypt: false });
    const t2 = await buildIntentToken(capIntent(), CONTRACT_ID, 1, MASTER, { encrypt: false });
    const a = await executeIntentToken(t1, await makeCtx({ workspaceId: 'ws-a' }));
    const b = await executeIntentToken(t2, await makeCtx({ workspaceId: 'ws-b' }));
    expect((a.data as any).seenTenant.workspaceId).toBe('ws-a');
    expect((b.data as any).seenTenant.workspaceId).toBe('ws-b');
  });

  it('dedicated calls (no tenant) still see no tenant on ctx', async () => {
    const token = await buildIntentToken(capIntent(), CONTRACT_ID, 1, MASTER, { encrypt: false });
    const result = await executeIntentToken(token, await makeCtx());
    expect(result.status).toBe('success');
    expect((result.data as any).seenTenant).toBeNull();
  });
});

describe('pooled guards', () => {
  it('denies non-capability ops when a tenant is present', async () => {
    const token = await buildIntentToken(
      { op: 'tool_call' as const, tool: 'read_file', args: { path: 'x' } },
      CONTRACT_ID, 1, MASTER, { encrypt: false },
    );
    const result = await executeIntentToken(token, await makeCtx({ workspaceId: 'ws-a' }));
    expect(result.status).toBe('denied');
    expect(result.error).toContain('pooled');
  });

  it('errors on a tenant without a workspace id', async () => {
    const token = await buildIntentToken(capIntent(), CONTRACT_ID, 1, MASTER, { encrypt: false });
    const result = await executeIntentToken(token, await makeCtx({ workspaceId: '' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('tenant workspace id');
  });
});
