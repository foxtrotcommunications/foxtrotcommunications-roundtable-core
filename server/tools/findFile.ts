// @ts-nocheck
// server/tools/findFile.js — Search for files by name in the workspace
import path from 'path';
import fs from 'fs';

const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', 'workspace');

import type { Tool } from '../types';
// @ts-ignore


const tool: Tool = {
  name: 'find_file',
  description: 'Search for files by name (or partial name) across all repos in the workspace. Returns matching file paths. Use this when you need to locate a file.',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'File name or partial name to search for (case-insensitive)' },
      directory: { type: 'string', description: 'Optional: limit search to a specific repo or subdirectory' },
    },
    required: ['filename'],
  },
  async execute(args: any, _workspaceConfig: any = {}, _context?: any) {
    const { filename, directory = '.' } = args;
    try {
      const searchDir = path.resolve(WORKSPACE_DIR, directory);
      if (!searchDir.startsWith(WORKSPACE_DIR)) {
        return { error: 'Access denied: path is outside workspace' };
      }
      if (!fs.existsSync(searchDir)) {
        return { error: `Directory not found: ${directory}` };
      }

      const matches = [];
      const maxResults = 50;
      const query = filename.toLowerCase();

      function scan(dir, prefix = '') {
        if (matches.length >= maxResults) return;
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const item of items) {
          if (matches.length >= maxResults) return;
          if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === '__pycache__' || item.name === 'lost+found') continue;

          const rel = prefix ? `${prefix}/${item.name}` : item.name;
          if (item.isDirectory()) {
            scan(path.join(dir, item.name), rel);
          } else if (item.name.toLowerCase().includes(query)) {
            matches.push(rel);
          }
        }
      }

      scan(searchDir);
      return { query: filename, directory, matches, total: matches.length };
    } catch (err: any) {
      return { error: err.message };
    }
  },
};

export default tool;
