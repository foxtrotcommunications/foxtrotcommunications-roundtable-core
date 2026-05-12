// tests/tools/queryWarehouse.test.js — Data warehouse tool tests
// Tests the safety layer (SQL injection prevention, config validation)
// without requiring actual warehouse connections.

const queryBigQuery = require('../../server/tools/queryBigQuery');
const querySnowflake = require('../../server/tools/querySnowflake');
const queryDatabricks = require('../../server/tools/queryDatabricks');

const warehouseTools = [
  { name: 'query_bigquery', tool: queryBigQuery, configVar: 'GCP_PROJECT' },
  { name: 'query_snowflake', tool: querySnowflake, configVar: 'SNOWFLAKE_ACCOUNT' },
  { name: 'query_databricks', tool: queryDatabricks, configVar: 'DATABRICKS_HOST' },
];

describe.each(warehouseTools)('$name tool', ({ name, tool, configVar }) => {
  it('should have correct tool metadata', () => {
    expect(tool.name).toBe(name);
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters.required).toContain('sql');
    expect(typeof tool.execute).toBe('function');
  });

  it('should return error when not configured or unreachable', async () => {
    const originalVal = process.env[configVar];
    delete process.env[configVar];

    const result = await tool.execute({ sql: 'SELECT 1' });
    // Should get either a config error or a connection error — never actual data
    expect(result.error).toBeDefined();

    if (originalVal) process.env[configVar] = originalVal;
  });

  describe('SQL safety', () => {
    // Need to temporarily set config so it gets past the config check
    const configOverrides = {
      GCP_PROJECT: 'test-project',
      SNOWFLAKE_ACCOUNT: 'test.us-east-1',
      SNOWFLAKE_USERNAME: 'test',
      SNOWFLAKE_PASSWORD: 'test',
      DATABRICKS_HOST: 'test.databricks.net',
      DATABRICKS_TOKEN: 'dapi-test',
      DATABRICKS_HTTP_PATH: '/sql/test',
    };

    let originalEnv;
    beforeAll(() => {
      originalEnv = { ...process.env };
      Object.assign(process.env, configOverrides);
    });
    afterAll(() => {
      // Restore only the keys we changed
      for (const key of Object.keys(configOverrides)) {
        if (originalEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnv[key];
        }
      }
    });

    const dangerousStatements = [
      { label: 'INSERT', sql: "INSERT INTO users VALUES (1, 'hacked')" },
      { label: 'UPDATE', sql: "UPDATE users SET admin = true WHERE id = 1" },
      { label: 'DELETE', sql: "DELETE FROM users WHERE id = 1" },
      { label: 'DROP TABLE', sql: "DROP TABLE users" },
      { label: 'TRUNCATE', sql: "TRUNCATE TABLE users" },
      { label: 'ALTER TABLE', sql: "ALTER TABLE users ADD COLUMN hack TEXT" },
      { label: 'CREATE TABLE', sql: "CREATE TABLE hack (id INT)" },
      { label: 'GRANT', sql: "GRANT ALL ON users TO hacker" },
      { label: 'MERGE', sql: "MERGE INTO t USING s ON t.id=s.id WHEN MATCHED THEN UPDATE SET t.x=s.x" },
      { label: 'SELECT INTO', sql: "SELECT * INTO backup FROM users" },
    ];

    it.each(dangerousStatements)('should block $label statements', async ({ sql }) => {
      const result = await tool.execute({ sql });
      expect(result.error).toContain('read-only');
    });

    it('should allow basic SELECT', async () => {
      // This will fail at the connection level but should NOT be blocked by safety
      const result = await tool.execute({ sql: 'SELECT 1 AS test' });
      // Should not have a "read-only" error — it should fail at connection, not safety
      if (result.error) {
        expect(result.error).not.toContain('read-only');
      }
    });

    it('should allow WITH (CTE) queries', async () => {
      const result = await tool.execute({
        sql: 'WITH cte AS (SELECT 1 AS x) SELECT * FROM cte',
      });
      if (result.error) {
        expect(result.error).not.toContain('read-only');
      }
    });
  });
});
