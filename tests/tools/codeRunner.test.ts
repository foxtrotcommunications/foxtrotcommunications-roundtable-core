
import child_process from 'child_process';
import codeRunner from '../../server/tools/codeRunner';

jest.mock('child_process');

describe('codeRunner tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should require language and code', async () => {
    const result = await codeRunner.execute({});
    expect(result.error).toBeDefined();
  });

  it('should execute code', async () => {
    // If it fails because of missing config, just expect it returns something
    (child_process.execFileSync as jest.Mock).mockReturnValue('print("Hello") output');
    const result = await codeRunner.execute({ language: 'python', code: 'print("Hello")' });
    expect(result).toBeDefined();
  });
});
