// @ts-nocheck
// server/tools/shellExec.js — Execute a shell command in the workspace (allowlist-based)
import {  execSync  } from 'child_process';
import path from 'path';
import fs from 'fs';

const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', 'workspace');

// Allowed base commands — only these can be executed
// SECURITY: Network tools (curl, wget) and shells (bash, sh) are excluded.
// python3 is allowed because run_code already permits arbitrary Python execution.
const ALLOWED_COMMANDS = new Set([
  'npm', 'npx', 'git', 'python3',
  'cat', 'head', 'tail', 'grep', 'find', 'ls', 'wc',
  'diff', 'echo', 'pwd', 'which', 'env', 'printenv',
  'make', 'test', 'true', 'false',
  'sort', 'uniq', 'tr', 'cut', 'sed', 'awk',
  'mkdir', 'cp', 'mv', 'touch', 'rm',
  'tar', 'gzip', 'gunzip',
]);

// Shell metacharacters that enable chaining / escapes
const DANGEROUS_PATTERNS = [
  /;\s*/,          // command chaining
  /\|\|/,          // OR chaining
  /&&/,            // AND chaining
  /\$\(/,          // command substitution
  /`/,             // backtick substitution
  />\s*\//,        // redirect to absolute path
  />\s*\.\./,      // redirect to parent directory
  /\|\s*bash/,     // pipe to bash
  /\|\s*sh\b/,     // pipe to sh
  /\|\s*zsh/,      // pipe to zsh
  /eval\s/,        // eval command
  /source\s/,      // source command
  /\bexec\s/,      // exec command
];

// Commands that should never run regardless
const BLOCKED_COMMANDS = new Set([
  'bash', 'sh', 'zsh', 'csh', 'fish',
  'sudo', 'su', 'chmod', 'chown', 'chgrp',
  'kill', 'killall', 'pkill',
  'shutdown', 'reboot', 'halt',
  'mkfs', 'fdisk', 'mount', 'umount',
  'dd', 'nc', 'ncat', 'netcat',
  'ssh', 'scp', 'sftp', 'rsync',
  'systemctl', 'service',
]);

function extractBaseCommand(command) {
  // Strip leading env vars like "FOO=bar command ..."
  const cleaned = command.replace(/^(\w+=\S+\s+)*/, '').trim();
  const parts = cleaned.split(/\s+/);
  return parts[0] || '';
}

import type { Tool } from '../types';
// @ts-ignore


const tool: Tool = {
  name: 'shell_exec',
  description: 'Execute a shell command in the workspace directory. Allowed commands include: python3, npm, npx, git, grep, find, ls, cat, diff, sed, awk, and common unix utilities. Returns stdout and stderr.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      cwd: { type: 'string', description: 'Working directory relative to workspace (default: workspace root)' },
    },
    required: ['command'],
  },
  async execute(args: any, _workspaceConfig: any = {}, _context?: any) {
    const { command, cwd = '.' } = args;
    try {
      // Check if shell_exec is disabled
      if (process.env.SHELL_EXEC_ENABLED === 'false') {
        return { error: 'Shell execution is disabled on this server' };
      }

      if (!fs.existsSync(WORKSPACE_DIR)) {
        fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      }

      const workDir = path.resolve(WORKSPACE_DIR, cwd);
      if (!workDir.startsWith(WORKSPACE_DIR)) {
        return { error: 'Access denied: path is outside workspace' };
      }

      // Extract and validate the base command
      const baseCmd = extractBaseCommand(command);
      if (!baseCmd) {
        return { error: 'Empty command' };
      }

      if (BLOCKED_COMMANDS.has(baseCmd)) {
        return { error: `Command '${baseCmd}' is blocked for security` };
      }

      if (!ALLOWED_COMMANDS.has(baseCmd)) {
        return { error: `Command '${baseCmd}' is not in the allowlist. Allowed: ${[...ALLOWED_COMMANDS].sort().join(', ')}` };
      }

      // Check for dangerous shell patterns
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
          return { error: `Command contains blocked shell pattern: ${pattern.source}` };
        }
      }

      // Allow safe piping (e.g., grep | head, npm test | cat)
      // But block pipe to shells (already caught above)
      // SECURITY: Only pass safe env vars — strip API keys, secrets, database URLs
      const safeEnv = {
        PATH: process.env.PATH,
        HOME: WORKSPACE_DIR,
        LANG: process.env.LANG || 'en_US.UTF-8',
        TERM: process.env.TERM || 'xterm',
        NODE_ENV: process.env.NODE_ENV || 'production',
        USER: process.env.USER || 'roundtable',
        TMPDIR: WORKSPACE_DIR,
      };
      const output = execSync(command, {
        cwd: workDir,
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024, // 2MB
        encoding: 'utf-8',
        env: safeEnv,
      });

      return {
        command,
        cwd: workDir,
        stdout: output.substring(0, 10000), // Cap output
        exitCode: 0,
      };
    } catch (err: any) {
      return {
        command,
        error: err.message,
        stdout: (err.stdout || '').substring(0, 5000),
        stderr: (err.stderr || '').substring(0, 5000),
        exitCode: err.status || 1,
      };
    }
  },
};

export default tool;
