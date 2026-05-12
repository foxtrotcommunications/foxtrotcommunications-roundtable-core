// server/tools/queryBigQuery.js — Execute read-only SQL against Google BigQuery
const config = require('../config');

// Lazy-loaded client (only initialized when first used)
let bqClient = null;

function getClient() {
  if (!bqClient) {
    const { BigQuery } = require('@google-cloud/bigquery');
    bqClient = new BigQuery({
      projectId: config.vertexai.project || process.env.BQ_PROJECT,
      location: process.env.BQ_LOCATION || config.vertexai.location || 'us-central1',
    });
  }
  return bqClient;
}

// Blocked keywords to prevent data modification
const BLOCKED_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|MERGE|GRANT|REVOKE)\b/i,
  /\bINTO\s+/i,
];

module.exports = {
  name: 'query_bigquery',
  description: 'Execute a read-only SQL query against Google BigQuery. Returns rows as JSON. Use fully qualified table names: `project.dataset.table`. Limited to SELECT/WITH statements. Max 1000 rows returned.',
  parameters: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'The SQL query to execute (SELECT only)',
      },
      project: {
        type: 'string',
        description: 'Optional: GCP project ID (defaults to workspace GCP_PROJECT)',
      },
    },
    required: ['sql'],
  },
  async execute({ sql, project }) {
    try {
      if (!config.vertexai.project && !project && !process.env.BQ_PROJECT) {
        return { error: 'BigQuery not configured. Set GCP_PROJECT or BQ_PROJECT environment variable.' };
      }

      // Safety: block write operations
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(sql)) {
          return { error: 'Only read-only queries (SELECT/WITH) are allowed.' };
        }
      }

      const client = getClient();
      const options = {
        query: sql,
        location: process.env.BQ_LOCATION || config.vertexai.location || 'us-central1',
        maximumBytesBilled: process.env.BQ_MAX_BYTES || '1073741824', // 1GB default
      };
      if (project) options.projectId = project;

      const [rows] = await client.query(options);

      // Cap output
      const maxRows = 1000;
      const truncated = rows.length > maxRows;
      const resultRows = truncated ? rows.slice(0, maxRows) : rows;

      return {
        sql,
        rows: resultRows,
        totalRows: rows.length,
        truncated,
        columns: resultRows.length > 0 ? Object.keys(resultRows[0]) : [],
      };
    } catch (err) {
      return {
        error: err.message,
        sql,
        code: err.code || null,
      };
    }
  },
};
