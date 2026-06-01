// tests/tools/shellExec.test.js — Security tests for shell execution
const shellExec = require('../../server/tools/shellExec');

describe('shell_exec tool', () => {
  describe('command allowlist', () => {
    it('should allow listed commands', async () => {
      const result = await shellExec.execute({ command: 'echo hello' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello');
    });

    it('should block unlisted commands', async () => {
      const result = await shellExec.execute({ command: 'whoami' });
      expect(result.error).toContain('not in the allowlist');
    });

    it('should block explicitly blocked commands', async () => {
      const blockedCmds = ['bash', 'sh', 'sudo', 'kill', 'ssh', 'dd', 'nc'];
      for (const cmd of blockedCmds) {
        const result = await shellExec.execute({ command: `${cmd} --version` });
        expect(result.error).toContain('blocked for security');
      }
    });
  });

  describe('dangerous pattern detection', () => {
    it('should block command chaining with semicolons', async () => {
      const result = await shellExec.execute({ command: 'echo hello; rm -rf /' });
      expect(result.error).toContain('blocked shell pattern');
    });

    it('should block AND chaining (&&)', async () => {
      const result = await shellExec.execute({ command: 'echo a && echo b' });
      expect(result.error).toContain('blocked shell pattern');
    });

    it('should block OR chaining (||)', async () => {
      const result = await shellExec.execute({ command: 'echo a || echo b' });
      expect(result.error).toContain('blocked shell pattern');
    });

    it('should block command substitution $()', async () => {
      const result = await shellExec.execute({ command: 'echo $(whoami)' });
      expect(result.error).toContain('blocked shell pattern');
    });

    it('should block backtick substitution', async () => {
      const result = await shellExec.execute({ command: 'echo `whoami`' });
      expect(result.error).toContain('blocked shell pattern');
    });

    it('should block pipe to shell', async () => {
      const result = await shellExec.execute({ command: 'echo "rm -rf /" | bash' });
      expect(result.error).toContain('blocked shell pattern');
    });

    it('should block eval (caught by allowlist)', async () => {
      const result = await shellExec.execute({ command: 'eval "rm -rf /"' });
      expect(result.error).toContain('not in the allowlist');
    });

    it('should block redirect to absolute path', async () => {
      const result = await shellExec.execute({ command: 'echo x > /etc/passwd' });
      expect(result.error).toContain('blocked shell pattern');
    });

    it('should block redirect to parent directory', async () => {
      const result = await shellExec.execute({ command: 'echo x > ../secret' });
      expect(result.error).toContain('blocked shell pattern');
    });
  });

  describe('path traversal protection', () => {
    it('should block access outside workspace directory', async () => {
      const result = await shellExec.execute({ command: 'ls', cwd: '../../../etc' });
      expect(result.error).toContain('outside workspace');
    });
  });

  describe('feature flags', () => {
    it('should respect SHELL_EXEC_ENABLED=false', async () => {
      const original = process.env.SHELL_EXEC_ENABLED;
      process.env.SHELL_EXEC_ENABLED = 'false';
      const result = await shellExec.execute({ command: 'echo hello' });
      expect(result.error).toContain('disabled');
      process.env.SHELL_EXEC_ENABLED = original || '';
    });
  });

  describe('safe commands', () => {
    it('should block node (removed from allowlist for security)', async () => {
      const result = await shellExec.execute({ command: 'node --version' });
      expect(result.error).toContain('not in the allowlist');
    });

    it('should block python3 (removed from allowlist for security)', async () => {
      const result = await shellExec.execute({ command: 'python3 --version' });
      expect(result.error).toContain('not in the allowlist');
    });

    it('should block curl (removed from allowlist for security)', async () => {
      const result = await shellExec.execute({ command: 'curl --version' });
      expect(result.error).toContain('not in the allowlist');
    });

    it('should execute git --version', async () => {
      const result = await shellExec.execute({ command: 'git --version' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('git version');
    });

    it('should handle commands with env var prefixes', async () => {
      const result = await shellExec.execute({ command: 'FOO=bar echo hello' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello');
    });
  });

  describe('output limits', () => {
    it('should cap stdout at 10000 characters', async () => {
      // Generate 20000+ chars using head + tr (node is no longer in the allowlist)
      const result = await shellExec.execute({ command: 'head -c 20000 /dev/zero | tr "\\0" "x"' });
      expect(result.stdout.length).toBeLessThanOrEqual(10000);
    });
  });
});
