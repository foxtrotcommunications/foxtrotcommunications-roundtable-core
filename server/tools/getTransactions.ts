// @ts-nocheck
// server/tools/getTransactions.ts — Unified transaction search & filter
// Dynamic WHERE clause builder with ILIKE search, pagination, and sorting
import { query } from './utils/domainDb';
import type { Tool } from '../types';
import { buildProvenance } from './utils/buildProvenance';

const tool: Tool = {
  name: 'get_transactions',
  description:
    'Search and filter transactions with flexible criteria. Supports filtering by account, date range, amount range, category, and free-text search across name/merchant/category. Returns transactions with total count, total amount, and applied filters.',
  parameters: {
    type: 'object',
    properties: {
      account_id: {
        type: 'string',
        description: 'Optional. Filter to a specific account.',
      },
      start_date: {
        type: 'string',
        description: 'Optional. Start date (YYYY-MM-DD). Inclusive.',
      },
      end_date: {
        type: 'string',
        description: 'Optional. End date (YYYY-MM-DD). Inclusive.',
      },
      min_amount: {
        type: 'number',
        description: 'Optional. Minimum transaction amount (Plaid convention: positive = debit).',
      },
      max_amount: {
        type: 'number',
        description: 'Optional. Maximum transaction amount.',
      },
      category: {
        type: 'string',
        description: 'Optional. Filter by category (exact match, case-insensitive).',
      },
      search: {
        type: 'string',
        description: 'Optional. Free-text search across transaction name, merchant_name, and category (ILIKE).',
      },
      limit: {
        type: 'integer',
        description: 'Optional. Max results to return. Default 50, max 500.',
      },
      sort: {
        type: 'string',
        enum: ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'],
        description: 'Optional. Sort order. Default: date_desc.',
      },
    },
    required: [],
  },
  async execute(args: any, _workspaceConfig: any = {}) {
    const start = Date.now();
    try {
      const filters: Record<string, any> = {};
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIdx = 1;

      // ── Build dynamic WHERE clause ──────────────────────────────
      if (args.account_id) {
        conditions.push(`account_id = $${paramIdx++}`);
        params.push(args.account_id);
        filters.account_id = args.account_id;
      }

      if (args.start_date) {
        conditions.push(`date >= $${paramIdx++}::date`);
        params.push(args.start_date);
        filters.start_date = args.start_date;
      }

      if (args.end_date) {
        conditions.push(`date <= $${paramIdx++}::date`);
        params.push(args.end_date);
        filters.end_date = args.end_date;
      }

      if (args.min_amount != null) {
        conditions.push(`amount >= $${paramIdx++}`);
        params.push(args.min_amount);
        filters.min_amount = args.min_amount;
      }

      if (args.max_amount != null) {
        conditions.push(`amount <= $${paramIdx++}`);
        params.push(args.max_amount);
        filters.max_amount = args.max_amount;
      }

      if (args.category) {
        conditions.push(`LOWER(category) = LOWER($${paramIdx++})`);
        params.push(args.category);
        filters.category = args.category;
      }

      if (args.search) {
        const searchParam = `%${args.search}%`;
        conditions.push(`(name ILIKE $${paramIdx} OR merchant_name ILIKE $${paramIdx} OR category ILIKE $${paramIdx})`);
        params.push(searchParam);
        paramIdx++;
        filters.search = args.search;
      }

      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

      // ── Sort ────────────────────────────────────────────────────
      const sortMap: Record<string, string> = {
        date_desc: 'date DESC, transaction_id DESC',
        date_asc: 'date ASC, transaction_id ASC',
        amount_desc: 'amount DESC',
        amount_asc: 'amount ASC',
      };
      const sort = args.sort || 'date_desc';
      const orderBy = sortMap[sort] || sortMap.date_desc;
      filters.sort = sort;

      // ── Limit ───────────────────────────────────────────────────
      const limit = Math.min(Math.max(parseInt(args.limit) || 50, 1), 500);
      filters.limit = limit;

      // ── Count + aggregate query ─────────────────────────────────
      const countSql = `
        SELECT
          COUNT(*)::int AS total_count,
          COALESCE(SUM(amount), 0) AS total_amount
        FROM plaid_transactions
        ${whereClause}
      `;

      // ── Data query ──────────────────────────────────────────────
      const dataSql = `
        SELECT
          transaction_id,
          account_id,
          amount,
          date,
          name,
          merchant_name,
          category,
          payment_channel,
          pending
        FROM plaid_transactions
        ${whereClause}
        ORDER BY ${orderBy}
        LIMIT ${limit}
      `;

      // Run both queries with the same params
      const [countResult, dataResult] = await Promise.all([
        query(countSql, params),
        query(dataSql, params),
      ]);

      const totalCount = countResult.rows[0]?.total_count || 0;

      // Provenance metadata
      const acctCountResult = await query('SELECT COUNT(*)::int AS cnt FROM plaid_accounts');
      const accountsAnalyzed = acctCountResult.rows[0]?.cnt || 0;
      const totalAmount = parseFloat(countResult.rows[0]?.total_amount) || 0;

      const transactions = dataResult.rows.map((row: any) => ({
        transaction_id: row.transaction_id,
        account_id: row.account_id,
        amount: parseFloat(row.amount),
        date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date,
        name: row.name,
        merchant_name: row.merchant_name,
        category: row.category,
        payment_channel: row.payment_channel,
        pending: row.pending,
      }));

      const connections = JSON.parse(process.env.RT_CONNECTIONS || '[]');
      const coverageGaps: string[] = [];
      if (connections.length <= 1) coverageGaps.push('Only 1 institution connected — results may be incomplete');

      const provenance = await buildProvenance(true, true);

      return {
        provenance,
        transactions,
        total_count: totalCount,
        total_amount: Math.round(totalAmount * 100) / 100,
        returned_count: transactions.length,
        filters_applied: filters,
        metadata: {
          accounts_analyzed: accountsAnalyzed,
          transactions_scanned: totalCount,
        },
        coverage: {
          institutions_connected: connections.length,
          gaps: coverageGaps,
        },
        executionMs: Date.now() - start,
      };
    } catch (err: any) {
      return { error: `Transaction query failed: ${err.message}`, executionMs: Date.now() - start };
    }
  },
};

export default tool;
