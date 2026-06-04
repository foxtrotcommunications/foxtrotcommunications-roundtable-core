// @ts-nocheck
/**
 * download_query_results — Stores query results in memory and returns a
 * time-limited download URL.  Data is held for 30 minutes then auto-purged.
 *
 * The AI calls this tool after running a query when the user asks to
 * "save", "download", or "export" results.
 */

const crypto = require('crypto');

// In-memory store: id → { data, filename, contentType, createdAt }
const downloads = new Map();

// Auto-purge expired entries every 5 minutes
const TTL_MS = 30 * 60 * 1000; // 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of downloads) {
    if (now - entry.createdAt > TTL_MS) downloads.delete(id);
  }
}, 5 * 60 * 1000);

/**
 * Convert an array of row objects to CSV string
 */
function rowsToCsv(rows, columns) {
  if (!rows || rows.length === 0) return '';
  const cols = columns || Object.keys(rows[0]);
  const escape = (val) => {
    if (val == null) return '';
    const s = String(val);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const header = cols.map(escape).join(',');
  const body = rows.map(row => cols.map(c => escape(row[c])).join(',')).join('\n');
  return header + '\n' + body;
}

import type { Tool } from '../types';
// @ts-ignore


const tool: Tool = {
  name: 'download_query_results',
  description:
    'Save query results (or any tabular data) as a downloadable CSV file. ' +
    'Returns a temporary download link valid for 30 minutes. ' +
    'Use this when a user asks to save, download, or export query results.',
  parameters: {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        description: 'Array of row objects (each object is a key-value map of column→value)',
        items: { type: 'object' },
      },
      columns: {
        type: 'array',
        description: 'Ordered list of column names. If omitted, keys from the first row are used.',
        items: { type: 'string' },
      },
      filename: {
        type: 'string',
        description: 'Suggested filename for the download (e.g. "top_conditions.csv"). Defaults to "query_results.csv".',
      },
    },
    required: ['rows'],
  },

  async execute(args: any, _workspaceConfig: any = {}, _context?: any) {
    const { rows, columns, filename } = args;
    if (!Array.isArray(rows) || rows.length === 0) {
      return { error: 'No data to export — rows array is empty.' };
    }

    const id = crypto.randomUUID();
    const fname = (filename || 'query_results.csv').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const csv = rowsToCsv(rows, columns);

    downloads.set(id, {
      data: Buffer.from(csv, 'utf-8'),
      filename: fname,
      contentType: 'text/csv',
      createdAt: Date.now(),
    });

    return {
      success: true,
      downloadUrl: `/api/downloads/${id}`,
      filename: fname,
      rowCount: rows.length,
      expiresIn: '30 minutes',
    };
  },

  // Expose the store so the Express route can access it
  _downloads: downloads,
};

export default tool;
