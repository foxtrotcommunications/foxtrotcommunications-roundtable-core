// tests/tools/queryWarehouse.test.js — Data warehouse tool tests
// Tests the safety layer (SQL injection prevention, config validation)
// without requiring actual warehouse connections.

import queryBigQuery from '../../server/tools/queryBigQuery';
import querySnowflake from '../../server/tools/querySnowflake';
import queryDatabricks from '../../server/tools/queryDatabricks';

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
      // Safety check runs before config — blocked even without warehouse credentials
      const result = await tool.execute({ sql });
      expect(result.error).toContain('read-only');
    });

    it('should allow basic SELECT', async () => {
      const result = await tool.execute({ sql: 'SELECT 1 AS test' });
      // Should not be blocked by safety — may fail at config/connection level
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
