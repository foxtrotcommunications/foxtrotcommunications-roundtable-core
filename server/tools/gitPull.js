// server/tools/gitPull.js — Pull latest changes from remote
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', 'workspace');

module.exports = {
  name: 'git_pull',
  description:
    'Pull latest changes from the remote repository. Supports merge (default) and rebase strategies. ' +
    'Use rebase to maintain a linear commit history when your local branch has diverged from remote.',
  parameters: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'The repository directory name inside the workspace',
      },
      rebase: {
        type: 'boolean',
        description: 'If true, use --rebase instead of merge (default: false)',
      },
      remote: {
        type: 'string',
        description: 'Remote name to pull from (default: "origin")',
      },
      branch: {
        type: 'string',
        description: 'Branch to pull. If omitted, pulls the current branch\'s upstream.',
      },
    },
    required: ['directory'],
  },
  async execute({ directory, rebase = false, remote = 'origin', branch }) {
    try {
      const repoPath = path.resolve(WORKSPACE_DIR, directory);
      if (!repoPath.startsWith(WORKSPACE_DIR)) {
        return { error: 'Access denied: path is outside workspace' };
      }
      if (!fs.existsSync(path.join(repoPath, '.git'))) {
        return { error: `${directory} is not a git repository` };
      }

      const opts = { cwd: repoPath, timeout: 60000, encoding: 'utf-8' };

      // Get current state before pull
      const currentBranch = execSync('git branch --show-current', opts).trim();
      const beforeHash = execSync('git rev-parse --short HEAD', opts).trim();

      // Fetch first to see what's coming
      execSync(`git fetch ${remote}`, opts);

      // Build pull command
      const rebaseFlag = rebase ? ' --rebase' : '';
      const branchArg = branch ? ` ${remote} ${branch}` : '';
      const pullCmd = `git pull${rebaseFlag}${branchArg}`;

      const output = execSync(pullCmd, opts).trim();

      // Get state after pull
      const afterHash = execSync('git rev-parse --short HEAD', opts).trim();
      const changed = beforeHash !== afterHash;

      // Count new commits if any
      let newCommits = 0;
      if (changed) {
        try {
          const log = execSync(
            `git log --oneline ${beforeHash}..${afterHash}`,
            opts,
          ).trim();
          newCommits = log ? log.split('\n').length : 0;
        } catch {
          // Ignore if commit range is invalid (force push, etc.)
        }
      }

      return {
        directory,
        branch: currentBranch,
        strategy: rebase ? 'rebase' : 'merge',
        beforeHash,
        afterHash,
        changed,
        newCommits,
        output: output.substring(0, 2000),
      };
    } catch (err) {
      // Check for rebase conflicts
      const stderr = (err.stderr || err.message || '').substring(0, 500);
      if (stderr.includes('CONFLICT') || stderr.includes('could not apply')) {
        return {
          error: 'Merge/rebase conflict detected. Resolve conflicts manually or abort with git_pull using abort=true.',
          conflicts: stderr,
        };
      }
      return { error: err.message.substring(0, 300) };
    }
  },
};
