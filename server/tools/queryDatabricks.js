// server/tools/queryDatabricks.js — Execute read-only SQL against Databricks SQL Warehouse
//
// Required env vars:
//   DATABRICKS_HOST        — e.g. "adb-1234567890.12.azuredatabricks.net"
//   DATABRICKS_TOKEN       — Personal access token
//   DATABRICKS_HTTP_PATH   — SQL warehouse HTTP path (e.g. "/sql/1.0/warehouses/abc123")
//   DATABRICKS_CATALOG     — optional default catalog (Unity Catalog)
//   DATABRICKS_SCHEMA      — optional default schema

// Blocked keywords to prevent data modification
const BLOCKED_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|MERGE|GRANT|REVOKE)\b/i,
  /\bINTO\s+/i,
];

module.exports = {
  name: 'query_databricks',
  description: 'Execute a read-only SQL query against a Databricks SQL Warehouse. Returns rows as JSON. Use fully qualified table names: catalog.schema.table. Limited to SELECT/WITH statements. Max 1000 rows returned.',
  parameters: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'The SQL query to execute (SELECT only)',
      },
      catalog: {
        type: 'string',
        description: 'Optional: Databricks Unity Catalog name (overrides default)',
      },
      schema: {
        type: 'string',
        description: 'Optional: Databricks schema name (overrides default)',
      },
    },
    required: ['sql'],
  },
  async execute({ sql, catalog, schema }) {
    try {
      if (!process.env.DATABRICKS_HOST || !process.env.DATABRICKS_TOKEN) {
        return { error: 'Databricks not configured. Set DATABRICKS_HOST, DATABRICKS_TOKEN, and DATABRICKS_HTTP_PATH environment variables.' };
      }

      // Safety: block write operations
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(sql)) {
          return { error: 'Only read-only queries (SELECT/WITH) are allowed.' };
        }
      }

      const { DBSQLClient } = require('@databricks/sql');
      const client = new DBSQLClient();

      await client.connect({
        host: process.env.DATABRICKS_HOST,
        path: process.env.DATABRICKS_HTTP_PATH,
        token: process.env.DATABRICKS_TOKEN,
      });

      const session = await client.openSession({
        initialCatalog: catalog || process.env.DATABRICKS_CATALOG || undefined,
        initialSchema: schema || process.env.DATABRICKS_SCHEMA || undefined,
      });

      try {
        const operation = await session.executeStatement(sql, {
          maxRows: 1000,
          runAsync: true,
        });

        const result = await operation.fetchAll();
        const columns = (await operation.getSchema())?.columns?.map((c) => c.columnName) || [];
        await operation.close();

        // Cap output
        const maxRows = 1000;
        const truncated = result.length > maxRows;
        const resultRows = truncated ? result.slice(0, maxRows) : result;

        return {
          sql,
          rows: resultRows,
          totalRows: result.length,
          truncated,
          columns,
        };
      } finally {
        await session.close();
        await client.close();
      }
    } catch (err) {
      return {
        error: err.message,
        sql,
        code: err.code || null,
      };
    }
  },
};
