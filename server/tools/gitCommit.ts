// @ts-nocheck
// server/tools/gitCommit.js — Git commit, push, and PR creation
import {  execSync  } from 'child_process';
import path from 'path';
import fs from 'fs';

const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', 'workspace');

import type { Tool } from '../types';
// @ts-ignore


const tool: Tool = {
  name: 'git_commit',
  description:
    'Stage all changes, commit, and optionally push to remote or open a pull request. ' +
    'Use this after making file changes to save them to git.',
  parameters: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'The repository directory name inside the workspace',
      },
      message: {
        type: 'string',
        description: 'The commit message',
      },
      push: {
        type: 'boolean',
        description: 'If true, push the commit to the remote after committing (default: false)',
      },
      create_pr: {
        type: 'boolean',
        description:
          'If true, create a new branch, push, and open a pull request. Requires push=true.',
      },
      pr_title: {
        type: 'string',
        description: 'Title for the pull request (required when create_pr is true)',
      },
      pr_body: {
        type: 'string',
        description: 'Description body for the pull request',
      },
    },
    required: ['directory', 'message'],
  },
  async execute(args: any, workspaceConfig: any = {}, _context?: any) {
    const { directory, message, push, create_pr, pr_title, pr_body } = args;
    try {
      const repoPath = path.resolve(WORKSPACE_DIR, directory);
      if (!repoPath.startsWith(WORKSPACE_DIR)) {
        return { error: 'Access denied: path is outside workspace' };
      }
      if (!fs.existsSync(path.join(repoPath, '.git'))) {
        return { error: `${directory} is not a git repository` };
      }

      const opts = { cwd: repoPath, timeout: 30000, encoding: 'utf-8' };

      // Check for changes
      const status = execSync('git status --porcelain', opts).trim();
      if (!status) {
        return { message: 'No changes to commit', directory };
      }

      // If creating a PR, make a new branch first
      let branchName = null;
      if (create_pr) {
        branchName = `ai/${message
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .substring(0, 50)}-${Date.now().toString(36)}`;
        execSync(`git checkout -b ${branchName}`, opts);
      }

      // Stage all + commit
      execSync('git add -A', opts);
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, opts);

      const commitHash = execSync('git rev-parse --short HEAD', opts).trim();
      const filesChanged = status.split('\n').length;

      const result = {
        directory,
        commitHash,
        message,
        filesChanged,
        branch: branchName || execSync('git branch --show-current', opts).trim(),
      };

      // Push if requested
      if (push || create_pr) {
        try {
          const branch = branchName || execSync('git branch --show-current', opts).trim();
          execSync(`git push origin ${branch}`, { ...opts, timeout: 60000 });
          result.pushed = true;
        } catch (pushErr: any) {
          result.pushError = pushErr.message.substring(0, 200);
        }
      }

      // Create PR via gh CLI
      if (create_pr && result.pushed) {
        try {
          const title = pr_title || message;
          const body = pr_body || `Automated changes by Roundtable AI:\n\n${message}`;
          const prOutput = execSync(
            `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"`,
            { ...opts, timeout: 30000 },
          ).trim();
          // gh pr create outputs the PR URL
          result.prUrl = prOutput;
        } catch (prErr: any) {
          result.prError = prErr.message.substring(0, 200);
        }
      }

      return result;
    } catch (err: any) {
      return { error: err.message.substring(0, 300) };
    }
  },
};

export default tool;
