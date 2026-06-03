
import child_process from 'child_process';
import fs from 'fs';
import gitClone from '../../server/tools/gitClone';
import gitCommit from '../../server/tools/gitCommit';
import gitPull from '../../server/tools/gitPull';

jest.mock('child_process');
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

describe('Git Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('git_clone', () => {
    it('should reject invalid git URLs', async () => {
      const result = await gitClone.execute({ url: 'file:///etc/passwd' });
      expect(result.error).toContain('Invalid git URL');
    });

    it('should clone valid repositories', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const result = await gitClone.execute({ url: 'https://github.com/test/repo.git' });
      
      expect(child_process.execFileSync).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
    
    it('should fallback to pull if repository already exists', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const result = await gitClone.execute({ url: 'https://github.com/test/repo.git' });
      
      expect(child_process.execFileSync).toHaveBeenCalled();
      expect(result.action).toBe('pulled');
    });
  });

  describe('git_commit', () => {
    it('should require a directory', async () => {
      const result = await gitCommit.execute({ message: 'test' });
      expect(result.error).toBeDefined();
    });
    
    it('should execute commit commands', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (child_process.execSync as jest.Mock).mockReturnValue('mock output');
      
      const result = await gitCommit.execute({ directory: 'repo', message: 'test message' });
      
      expect(child_process.execSync).toHaveBeenCalled();
      expect(result.commitHash).toBe('mock output');
    });
  });

  describe('git_pull', () => {
    it('should require a directory', async () => {
      const result = await gitPull.execute({});
      expect(result.error).toBeDefined();
    });

    it('should execute git pull', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (child_process.execFileSync as jest.Mock).mockReturnValue('Already up to date.');
      
      const result = await gitPull.execute({ directory: 'repo' });
      
      expect(child_process.execFileSync).toHaveBeenCalled();
      expect(result.success ?? result.output ?? result.beforeHash).toBeDefined();
    });
  });
});
