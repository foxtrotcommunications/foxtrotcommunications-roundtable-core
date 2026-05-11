// server/tools/writeFile.js — Write or update a file in the workspace
const path = require('path');
const fs = require('fs');

const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', 'workspace');

module.exports = {
  name: 'write_file',
  description: 'Write content to a file in the workspace. Creates parent directories if needed. Returns the filepath and line count.',
  parameters: {
    type: 'object',
    properties: {
      filepath: { type: 'string', description: 'Relative path to the file within the workspace' },
      content: { type: 'string', description: 'The full file content to write' },
    },
    required: ['filepath', 'content'],
  },
  async execute({ filepath, content }) {
    try {
      const fullPath = path.resolve(WORKSPACE_DIR, filepath);
      if (!fullPath.startsWith(WORKSPACE_DIR)) {
        return { error: 'Access denied: path is outside workspace' };
      }

      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const existed = fs.existsSync(fullPath);
      fs.writeFileSync(fullPath, content, 'utf-8');

      return {
        filepath,
        action: existed ? 'updated' : 'created',
        lines: content.split('\n').length,
        bytes: Buffer.byteLength(content),
      };
    } catch (err) {
      return { error: err.message };
    }
  },
};
