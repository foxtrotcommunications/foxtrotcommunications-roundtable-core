// server/tools/listFiles.js — List files in a workspace directory
const path = require('path');
const fs = require('fs');

const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', 'workspace');

module.exports = {
  name: 'list_files',
  description: 'List files and directories in a workspace path. Returns names, types, and sizes.',
  parameters: {
    type: 'object',
    properties: {
      directory: { type: 'string', description: 'Relative path within the workspace (default: root)' },
      recursive: { type: 'boolean', description: 'If true, list files recursively (max 200 entries)' },
    },
    required: [],
  },
  async execute({ directory = '.', recursive = false }) {
    try {
      const fullPath = path.resolve(WORKSPACE_DIR, directory);
      if (!fullPath.startsWith(WORKSPACE_DIR)) {
        return { error: 'Access denied: path is outside workspace' };
      }
      if (!fs.existsSync(fullPath)) {
        return { error: `Directory not found: ${directory}` };
      }

      const entries = [];
      const maxEntries = 200;

      function scan(dir, prefix = '') {
        if (entries.length >= maxEntries) return;
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (entries.length >= maxEntries) return;
          if (item.name.startsWith('.') || item.name === 'node_modules') continue;

          const rel = prefix ? `${prefix}/${item.name}` : item.name;
          if (item.isDirectory()) {
            entries.push({ name: rel, type: 'directory' });
            if (recursive) scan(path.join(dir, item.name), rel);
          } else {
            const stat = fs.statSync(path.join(dir, item.name));
            entries.push({ name: rel, type: 'file', size: stat.size });
          }
        }
      }

      scan(fullPath);
      return { directory, entries, total: entries.length };
    } catch (err) {
      return { error: err.message };
    }
  },
};
