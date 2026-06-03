import describeWorkspace from '../../server/tools/describeWorkspace';
import verifyWorkspace from '../../server/tools/verifyWorkspace';
import bridgeWorkspace from '../../server/tools/bridgeWorkspace';

global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ tools: [] })
  })
) as jest.Mock;

jest.mock('../../server/db/adapter', () => ({
  getAdapter: jest.fn(() => ({
    getWorkspace: jest.fn().mockResolvedValue({ id: '1', data_sources: {} })
  }))
}));

describe('Workspace Tools', () => {
  describe('describe_workspace', () => {
    it('should execute successfully', async () => {
      const result = await describeWorkspace.execute({}, { name: 'Test Workspace', dataSources: {} });
      expect(result).toBeDefined();
    });
  });

  describe('verify_workspace', () => {
    it('should execute successfully', async () => {
      const result = await verifyWorkspace.execute({}, {});
      expect(result).toBeDefined();
    });
  });

  describe('bridge_workspace', () => {
    it('should execute successfully', async () => {
      const result = await bridgeWorkspace.execute({ command: 'help' });
      expect(result).toBeDefined();
    });
  });
});
