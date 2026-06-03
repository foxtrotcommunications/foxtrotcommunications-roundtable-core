// @ts-nocheck
// server/tools/querySnowflake.js — Execute read-only SQL against Snowflake
//
// Required env vars:
//   SNOWFLAKE_ACCOUNT   — e.g. "abc12345.us-east-1"
//   SNOWFLAKE_USERNAME  — Snowflake user
//   SNOWFLAKE_PASSWORD  — Snowflake password
//   SNOWFLAKE_WAREHOUSE — optional (e.g. "COMPUTE_WH")
//   SNOWFLAKE_DATABASE  — optional default database
//   SNOWFLAKE_SCHEMA    — optional default schema
//   SNOWFLAKE_ROLE      — optional role

// Blocked keywords to prevent data modification
const BLOCKED_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|MERGE|GRANT|REVOKE)\b/i,
  /\bINTO\s+/i,
];

function createConnection(overrides = {}) {
  const snowflake = require('snowflake-sdk');
  return snowflake.createConnection({
    account: overrides.account || process.env.SNOWFLAKE_ACCOUNT,
    username: overrides.username || process.env.SNOWFLAKE_USERNAME,
    password: overrides.password || process.env.SNOWFLAKE_PASSWORD,
    warehouse: overrides.warehouse || process.env.SNOWFLAKE_WAREHOUSE || '',
    database: overrides.database || process.env.SNOWFLAKE_DATABASE || '',
    schema: overrides.schema || process.env.SNOWFLAKE_SCHEMA || '',
    role: overrides.role || process.env.SNOWFLAKE_ROLE || '',
    application: 'Roundtable',
  });
}

function executeQuery(connection: any, sql: any): Promise<{rows: any[], columns: string[]}> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: sql,
      complete: (err: any, stmt: any, rows: any) => {
        if (err) return reject(err);
        resolve({ rows, columns: stmt.getColumns().map((c: any) => c.getName()) });
      },
    });
  });
}

function connectAsync(connection: any) {
  return new Promise((resolve, reject) => {
    connection.connect((err: any, conn: any) => {
      if (err) return reject(err);
      resolve(conn);
    });
  });
}

import type { Tool } from '../types';
// @ts-ignore


const tool: Tool = {
  name: 'query_snowflake',
  description: 'Execute a read-only SQL query against Snowflake. Returns rows as JSON. Use fully qualified table names: DATABASE.SCHEMA.TABLE. Limited to SELECT/WITH statements. Max 1000 rows returned.',
  parameters: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'The SQL query to execute (SELECT only)',
      },
      database: {
        type: 'string',
        description: 'Optional: Snowflake database name (overrides default)',
      },
      schema: {
        type: 'string',
        description: 'Optional: Snowflake schema name (overrides default)',
      },
      warehouse: {
        type: 'string',
        description: 'Optional: Snowflake warehouse name (overrides default)',
      },
    },
    required: ['sql'],
  },
  async execute(args: any, workspaceConfig: any = {}, _context?: any) {
    const { sql, database, schema, warehouse } = args;
    const sfCfg = workspaceConfig?.dataSources?.snowflake || {};
    try {
      // Safety: block write operations (checked first, before config)
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(sql)) {
          return { error: 'Only read-only queries (SELECT/WITH) are allowed.' };
        }
      }

      const account = sfCfg.account || process.env.SNOWFLAKE_ACCOUNT;
      if (!account) {
        return { error: 'Snowflake not configured. Add a Snowflake connection in workspace Data Sources settings.' };
      }

      const conn = createConnection({
        account,
        username: sfCfg.username || process.env.SNOWFLAKE_USERNAME,
        password: sfCfg.password || process.env.SNOWFLAKE_PASSWORD,
        warehouse: warehouse || sfCfg.warehouse || process.env.SNOWFLAKE_WAREHOUSE || '',
        database: database || sfCfg.database || process.env.SNOWFLAKE_DATABASE || '',
        schema: schema || sfCfg.schema || process.env.SNOWFLAKE_SCHEMA || '',
        role: sfCfg.role || process.env.SNOWFLAKE_ROLE || '',
      });
      await connectAsync(conn);

      try {
        const { rows, columns } = await executeQuery(conn, sql);

        // Cap output
        const maxRows = 1000;
        const truncated = rows.length > maxRows;
        const resultRows = truncated ? rows.slice(0, maxRows) : rows;

        return {
          sql,
          rows: resultRows,
          totalRows: rows.length,
          truncated,
          columns,
        };
      } finally {
        conn.destroy(() => {});
      }
    } catch (err: any) {
      return {
        error: err.message,
        sql,
        code: err.code || null,
      };
    }
  },
};

export default tool;
