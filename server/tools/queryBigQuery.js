// server/tools/queryBigQuery.js — Execute read-only SQL against Google BigQuery
const config = require('../config');

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
        description: 'Optional: GCP billing project ID override (defaults to workspace BigQuery project setting)',
      },
    },
    required: ['sql'],
  },
  async execute({ sql, project }, workspaceConfig = {}) {
    try {
      // Safety: block write operations
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(sql)) {
          return { error: 'Only read-only queries (SELECT/WITH) are allowed.' };
        }
      }

      // Resolve billing project: arg > workspace data_sources > env > config
      const billingProject =
        project ||
        workspaceConfig?.dataSources?.bigquery?.project ||
        process.env.BQ_PROJECT ||
        config.vertexai?.project;

      if (!billingProject) {
        return { error: 'BigQuery not configured. Set a BigQuery project in workspace Data Sources settings or ensure GCP_PROJECT is set.' };
      }

      // Build a fresh client per call so workspace-level project overrides work cleanly
      const { BigQuery } = require('@google-cloud/bigquery');
      const client = new BigQuery({
        projectId: billingProject,
        location: workspaceConfig?.dataSources?.bigquery?.location ||
                  process.env.BQ_LOCATION ||
                  config.vertexai?.location ||
                  'US',
      });

      const options = {
        query: sql,
        maximumBytesBilled: process.env.BQ_MAX_BYTES || '1073741824', // 1 GB default
      };

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
        billingProject,
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
