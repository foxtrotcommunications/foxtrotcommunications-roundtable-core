/**
 * chatHandler pure helpers (pooled-arthur-plan step 8).
 * The @-mention trigger pattern is now built per-connection from the
 * TENANT's row name + workspace id — one tenant's alias must never trigger
 * on another tenant's connection. (The full send-message harness needs a
 * live socket server; the derivation itself is covered here.)
 */

const mockConfig: any = {
  pooledArthur: false,
  pooled: false,
  workspaceId: 'ded-ws',
  workspaceName: 'Dedicated WS',
  embedMode: false,
  vertexai: { project: '', location: '' },
  ai: {},
  ollama: { host: '' },
  platformOrg: '',
  bridgeHmacSecret: 'x',
};
jest.mock('../../server/config', () => mockConfig);
jest.mock('../../server/services/aiProvider', () => ({ streamCompletion: jest.fn() }));
jest.mock('../../server/services/workspaceService', () => ({
  scoped: jest.fn(),
  saveMessage: jest.fn(),
  getWorkspace: jest.fn(),
}));
jest.mock('../../server/tracing/collector', () => ({ recordSpan: jest.fn() }));

const { buildAiTriggerPattern } = require('../../server/sockets/chatHandler');

describe('buildAiTriggerPattern', () => {
  it('always triggers on @ai', () => {
    expect(buildAiTriggerPattern('Arthur', 'ws-a').test('hey @ai what gives')).toBe(true);
  });

  it('derives the alias from the first word of the workspace name', () => {
    const p = buildAiTriggerPattern('ICU — Critical Care', 'ws-icu-1');
    expect(p.test('@icu check the census')).toBe(true);
    expect(p.test('@ws-icu-1 check the census')).toBe(true);
    expect(p.test('@pharmacy anything?')).toBe(false);
  });

  it('is case-insensitive', () => {
    const p = buildAiTriggerPattern('Arthur', 'ws-a');
    expect(p.test('@ARTHUR hello')).toBe(true);
  });

  it('per-connection isolation: tenant A aliases never fire on tenant B patterns', () => {
    const a = buildAiTriggerPattern('Arthur', 'household-a');
    const b = buildAiTriggerPattern('Finance', 'household-b');
    expect(a.test('@household-a hi')).toBe(true);
    expect(b.test('@household-a hi')).toBe(false);
    expect(b.test('@finance hi')).toBe(true);
    expect(a.test('@finance hi')).toBe(false);
  });

  it('excludes the generic "roundtable" alias and single-char aliases', () => {
    const p = buildAiTriggerPattern('Roundtable', 'r');
    expect(p.test('@roundtable hi')).toBe(false);
    expect(p.test('@r hi')).toBe(false);
    expect(p.test('@ai hi')).toBe(true);
  });

  it('escapes regex metacharacters in names', () => {
    const p = buildAiTriggerPattern('C++ Team', 'ws-x');
    expect(() => p.test('@c++ hello')).not.toThrow();
    expect(p.test('@ws-x hello')).toBe(true);
  });
});
