// @ts-nocheck
// server/tools/gitClone.js — Clone a git repository
import {  execFileSync  } from 'child_process';
import path from 'path';
import fs from 'fs';

const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', 'workspace');

// Validate URL format to prevent injection via crafted URLs
function isValidGitUrl(url) {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:', 'ssh:'].includes(parsed.protocol);
  } catch {
    // Also allow scp-style git URLs like git@github.com:user/repo.git
    return /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(url);
  }
}

// Sanitize directory/repo name — alphanumeric, hyphens, underscores, dots only
function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '');
}

import type { Tool } from '../types';
// @ts-ignore


const tool: Tool = {
  name: 'git_clone',
  description: 'Clone a git repository into the workspace. Returns the path to the cloned repo.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The git repository URL to clone (HTTPS)' },
      directory: { type: 'string', description: 'Optional directory name for the clone' },
    },
    required: ['url'],
  },
  async execute(args: any, _workspaceConfig: any = {}, _context?: any) {
    const { url, directory } = args;
    try {
      if (!isValidGitUrl(url)) {
        return { error: 'Invalid git URL. Only HTTPS, HTTP, and SSH URLs are allowed.' };
      }

      if (!fs.existsSync(WORKSPACE_DIR)) {
        fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      }

      const rawName = directory || url.split('/').pop().replace('.git', '');
      const repoName = sanitizeName(rawName);
      if (!repoName) {
        return { error: 'Invalid repository name' };
      }

      const targetPath = path.join(WORKSPACE_DIR, repoName);

      // Ensure target is within workspace
      if (!targetPath.startsWith(WORKSPACE_DIR)) {
        return { error: 'Access denied: path is outside workspace' };
      }

      if (fs.existsSync(targetPath)) {
        // Pull instead of clone — use execFileSync with array args
        execFileSync('git', ['pull'], { cwd: targetPath, timeout: 30000 });
        return { success: true, path: targetPath, action: 'pulled' };
      }

      // Use execFileSync to prevent command injection — args are never shell-interpreted
      execFileSync('git', ['clone', '--depth', '1', url, repoName], {
        cwd: WORKSPACE_DIR,
        timeout: 60000,
      });

      return { success: true, path: targetPath, action: 'cloned' };
    } catch (err: any) {
      return { error: err.message };
    }
  },
};

export default tool;
