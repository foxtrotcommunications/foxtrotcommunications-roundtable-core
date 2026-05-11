// server/tools/gitClone.js — Clone a git repository
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', 'workspace');

module.exports = {
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
  async execute({ url, directory }) {
    try {
      if (!fs.existsSync(WORKSPACE_DIR)) {
        fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      }

      const repoName = directory || url.split('/').pop().replace('.git', '');
      const targetPath = path.join(WORKSPACE_DIR, repoName);

      if (fs.existsSync(targetPath)) {
        // Pull instead of clone
        execSync('git pull', { cwd: targetPath, timeout: 30000 });
        return { success: true, path: targetPath, action: 'pulled' };
      }

      execSync(`git clone --depth 1 ${url} ${repoName}`, {
        cwd: WORKSPACE_DIR,
        timeout: 60000,
      });

      return { success: true, path: targetPath, action: 'cloned' };
    } catch (err) {
      return { error: err.message };
    }
  },
};
