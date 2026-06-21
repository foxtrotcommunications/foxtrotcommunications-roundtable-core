import { withPool } from '../db/pool.js';
import type {
  PlaidPluginConfig,
  ToolRegistry,
  CapabilityRegistry,
} from '../types.js';

export function registerRealEstateTools(registry: ToolRegistry, config: PlaidPluginConfig): void {
  // Real Estate currently relies on the global financial tools (get_financial_snapshot)
  // No specific legacy tool is added here.
}

export function registerRealEstateCapabilities(registry: CapabilityRegistry, config: PlaidPluginConfig): void {
  registry.register({
    name: 'property.getPropertySummary',
    description: 'Get a summary of all real estate properties',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { properties: { type: 'array' } } },
    handler: async () => {
      return withPool(config.databaseUrl, async (pool) => {
        try {
          const { rows } = await pool.query('SELECT * FROM properties ORDER BY purchase_date DESC');
          return { properties: rows, count: rows.length };
        } catch (e: any) { return { error: e.message, properties: [] }; }
      });
    },
  });

  registry.register({
    name: 'property.getMortgageDetails',
    description: 'Get details of all mortgages attached to properties',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { mortgages: { type: 'array' } } },
    handler: async () => {
      return withPool(config.databaseUrl, async (pool) => {
        try {
          const { rows } = await pool.query('SELECT * FROM mortgages ORDER BY current_balance DESC');
          return { mortgages: rows, count: rows.length };
        } catch (e: any) { return { error: e.message, mortgages: [] }; }
      });
    },
  });

  registry.register({
    name: 'property.getEquityAnalysis',
    description: 'Get total estimated value, mortgage debt, and net equity',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: {} },
    handler: async () => {
      return withPool(config.databaseUrl, async (pool) => {
        try {
          const propResult = await pool.query('SELECT COALESCE(SUM(current_value), 0) AS val FROM properties');
          const mortResult = await pool.query('SELECT COALESCE(SUM(current_balance), 0) AS bal FROM mortgages');
          const value = parseFloat(propResult.rows[0]?.val) || 0;
          const debt = parseFloat(mortResult.rows[0]?.bal) || 0;
          return { total_value: value, total_mortgage_debt: debt, net_equity: value - debt };
        } catch (e: any) { return { error: e.message }; }
      });
    },
  });
}
