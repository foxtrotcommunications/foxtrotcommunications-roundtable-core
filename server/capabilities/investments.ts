// DEPRECATED: This file has been replaced by @pendragon/tools-plaid
// It will be removed in a future release.
// server/capabilities/investments.ts — ICE capabilities for investment domains
// Exposes plaid.getHoldings, plaid.getSecurities, plaid.getPortfolioSummary
// as typed workspace capabilities backed by the local plaid_* tables.

import pg from 'pg';
import type { CapabilityRegistry, CapabilityHandler } from '../protocols/capabilityRegistry.js';

const { Pool } = pg;

// ─── Helpers ────────────────────────────────────────────────────────────────

function createPool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  return new Pool({ connectionString: databaseUrl });
}

// ─── plaid.getHoldings ──────────────────────────────────────────────────────

const getHoldingsHandler: CapabilityHandler = async (_input, _ctx) => {
  const pool = createPool();
  try {
    const { rows } = await pool.query(
      `SELECT h.holding_id, h.account_id, h.security_id,
              h.quantity, h.institution_price, h.institution_value,
              h.cost_basis, h.synced_at,
              s.ticker_symbol, s.name AS security_name,
              s.type AS security_type, s.close_price, s.currency
       FROM plaid_holdings h
       LEFT JOIN plaid_securities s ON s.security_id = h.security_id
       ORDER BY h.institution_value DESC`,
    );
    return { holdings: rows };
  } finally {
    await pool.end();
  }
};

// ─── plaid.getSecurities ────────────────────────────────────────────────────

const getSecuritiesHandler: CapabilityHandler = async (input, _ctx) => {
  const pool = createPool();
  try {
    const ticker = input.ticker as string | undefined;

    let sql: string;
    let params: unknown[];

    if (ticker) {
      sql = `SELECT security_id, ticker_symbol, name, type,
                    close_price, currency, synced_at
             FROM plaid_securities
             WHERE ticker_symbol = $1
             ORDER BY name`;
      params = [ticker.toUpperCase()];
    } else {
      sql = `SELECT security_id, ticker_symbol, name, type,
                    close_price, currency, synced_at
             FROM plaid_securities
             ORDER BY name`;
      params = [];
    }

    const { rows } = await pool.query(sql, params);
    return { securities: rows };
  } finally {
    await pool.end();
  }
};

// ─── plaid.getPortfolioSummary ──────────────────────────────────────────────

const getPortfolioSummaryHandler: CapabilityHandler = async (_input, _ctx) => {
  const pool = createPool();
  try {
    // Total value and holdings count
    const totalsResult = await pool.query(
      `SELECT COALESCE(SUM(institution_value), 0) AS total_value,
              COUNT(*) AS holdings_count
       FROM plaid_holdings`,
    );
    const { total_value, holdings_count } = totalsResult.rows[0];

    // Breakdown by security type
    const breakdownResult = await pool.query(
      `SELECT s.type,
              COALESCE(SUM(h.institution_value), 0) AS value,
              COUNT(*) AS count
       FROM plaid_holdings h
       LEFT JOIN plaid_securities s ON s.security_id = h.security_id
       GROUP BY s.type
       ORDER BY value DESC`,
    );

    return {
      totalValue: parseFloat(total_value) || 0,
      holdingsCount: parseInt(holdings_count, 10) || 0,
      byType: breakdownResult.rows.map((row) => ({
        type: row.type || 'unknown',
        value: parseFloat(row.value) || 0,
        count: parseInt(row.count, 10) || 0,
      })),
    };
  } finally {
    await pool.end();
  }
};

// ─── Registration ───────────────────────────────────────────────────────────

export function registerInvestmentCapabilities(registry: CapabilityRegistry): void {
  // 1. Get holdings
  registry.register(
    {
      name: 'plaid.getHoldings',
      description: 'Get investment holdings with current values',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: {
        type: 'object',
        properties: {
          holdings: {
            type: 'array',
            description: 'Holdings enriched with security details',
          },
        },
      },
    },
    getHoldingsHandler,
  );

  // 2. Get securities
  registry.register(
    {
      name: 'plaid.getSecurities',
      description: 'Get security details for all held investments',
      inputSchema: {
        type: 'object',
        properties: {
          ticker: { type: 'string', description: 'Filter by ticker symbol' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          securities: { type: 'array' },
        },
      },
    },
    getSecuritiesHandler,
  );

  // 3. Portfolio summary
  registry.register(
    {
      name: 'plaid.getPortfolioSummary',
      description: 'Get aggregate portfolio summary with total value and allocation breakdown',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: {
        type: 'object',
        properties: {
          totalValue: { type: 'number' },
          holdingsCount: { type: 'number' },
          byType: {
            type: 'array',
            description: 'Breakdown by security type with value and count',
          },
        },
      },
    },
    getPortfolioSummaryHandler,
  );
}
