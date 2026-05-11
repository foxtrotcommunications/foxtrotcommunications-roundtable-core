// tests/db/adapter.test.js — Database adapter factory tests
describe('database adapter factory', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  it('should export getAdapter and initAdapter functions', () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    jest.resetModules();
    const adapter = require('../../server/db/adapter');
    expect(adapter.getAdapter).toBeDefined();
    expect(adapter.initAdapter).toBeDefined();
    expect(typeof adapter.getAdapter).toBe('function');
    expect(typeof adapter.initAdapter).toBe('function');
  });

  it('should throw from getAdapter before initialization', () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    jest.resetModules();
    const { getAdapter } = require('../../server/db/adapter');
    expect(() => getAdapter()).toThrow('not initialized');
  });
});
