// server/tools/readFile.js — Read a file from the workspace
const path = require('path');
const fs = require('fs');

const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', 'workspace');

module.exports = {
  name: 'read_file',
  description: 'Read the contents of a file from the workspace. Returns the file content with line numbers.',
  parameters: {
    type: 'object',
    properties: {
      filepath: { type: 'string', description: 'Relative path to the file within the workspace' },
      startLine: { type: 'integer', description: 'Optional start line (1-indexed)' },
      endLine: { type: 'integer', description: 'Optional end line (1-indexed, inclusive)' },
    },
    required: ['filepath'],
  },
  async execute({ filepath, startLine, endLine }) {
    try {
      const fullPath = path.resolve(WORKSPACE_DIR, filepath);
      // Security: ensure path is within workspace
      if (!fullPath.startsWith(WORKSPACE_DIR)) {
        return { error: 'Access denied: path is outside workspace' };
      }
      if (!fs.existsSync(fullPath)) {
        return { error: `File not found: ${filepath}` };
      }

      const stat = fs.statSync(fullPath);
      if (stat.size > 500000) {
        return { error: 'File too large (>500KB). Use startLine/endLine to read a portion.' };
      }

      let content = fs.readFileSync(fullPath, 'utf-8');
      const ext = path.extname(filepath).slice(1);

      if (startLine || endLine) {
        const lines = content.split('\n');
        const start = (startLine || 1) - 1;
        const end = endLine || lines.length;
        content = lines.slice(start, end).join('\n');
      }

      return { filepath, content, language: ext, lines: content.split('\n').length };
    } catch (err) {
      return { error: err.message };
    }
  },
};
