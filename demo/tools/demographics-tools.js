// demographics-tools.js — Domain tools for the Demographics workspace
// Mounted as a ConfigMap and loaded by the workspace's custom tools system.
// These tools query the local Postgres database for user demographics data.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 30000,
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

const get_user_profile = {
  name: 'get_user_profile',
  description: 'Get the primary user\'s demographic profile including name, date of birth, gender, education, employment status, and filing status.',
  parameters: { type: 'object', properties: {}, required: [] },
  alwaysEnabled: true,
  async execute() {
    const rows = await query('SELECT * FROM user_profile ORDER BY id LIMIT 1');
    if (rows.length === 0) return { error: 'No user profile found' };
    return rows[0];
  },
};

const get_household = {
  name: 'get_household',
  description: 'Get all household members including spouse and children with their ages and relationships.',
  parameters: { type: 'object', properties: {}, required: [] },
  alwaysEnabled: true,
  async execute() {
    const rows = await query('SELECT * FROM household_members ORDER BY date_of_birth ASC');
    return { members: rows, count: rows.length };
  },
};

const get_financial_goals = {
  name: 'get_financial_goals',
  description: 'Get all financial goals including retirement targets, education funding plans, and their priorities.',
  parameters: { type: 'object', properties: {}, required: [] },
  alwaysEnabled: true,
  async execute() {
    const rows = await query('SELECT * FROM financial_goals WHERE status = $1 ORDER BY priority DESC', ['active']);
    return { goals: rows, count: rows.length };
  },
};

const get_investment_preferences = {
  name: 'get_investment_preferences',
  description: 'Get investment preferences including risk tolerance, liquidity preference, time horizon, and asset class preferences/exclusions.',
  parameters: { type: 'object', properties: {}, required: [] },
  alwaysEnabled: true,
  async execute() {
    const rows = await query('SELECT * FROM investment_preferences ORDER BY id LIMIT 1');
    if (rows.length === 0) return { error: 'No investment preferences found' };
    return rows[0];
  },
};

module.exports = {
  tools: [get_user_profile, get_household, get_financial_goals, get_investment_preferences],
};
