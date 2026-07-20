// demo/seed-demo-transactions.js — regenerate the demo household's transactions
// with dates RELATIVE TO TODAY, so the demo never goes stale again.
//
// Run inside any demo workspace pod (needs DATABASE_URL):
//   cat demo/seed-demo-transactions.js | kubectl exec -i deploy/rt-ws-narv6objpk50 \
//     -n rt-pendragon-demo -c workspace -- node
//
// Deterministic (seeded RNG keyed to the anchor date) and idempotent: wipes and
// rewrites only rows whose transaction_id starts with 'demo_' (plus the legacy
// 'tx_' seed ids). Sign convention: positive = money in, negative = money out.
//
// The household story is deliberate — three signals exist for Arthur's gap
// detection and watches to find:
//   1. "CITI AUTOPAY" monthly — a credit card that is NOT connected (gap)
//   2. "Online Transfer to Ally Bank" monthly — savings NOT connected (gap)
//   3. Biweekly Gusto payroll — income cadence for income_stream_stopped watches

const { Pool } = require('pg');

const CHECKING_WS = 'Narv6OBjpk50aJla6eED';
const DEBT_WS = 'jmdsbwMzZqelAnliJcGQ';
const DAYS = 95;

// Mulberry32 — deterministic across runs on the same anchor date
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const anchor = new Date(); anchor.setUTCHours(0, 0, 0, 0);
const rand = rng(anchor.getUTCFullYear() * 10000 + (anchor.getUTCMonth() + 1) * 100 + anchor.getUTCDate());
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(anchor); d.setUTCDate(d.getUTCDate() - n); return d; };
const between = (lo, hi) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;

let seq = 0;
const rows = [];
function tx(ws, account, date, name, merchant, amount, category) {
  rows.push({
    transaction_id: `demo_${String(++seq).padStart(4, '0')}`,
    account_id: account, date: iso(date), name, merchant_name: merchant,
    amount: Math.round(amount * 100) / 100, category, workspace_id: ws,
  });
}

// ── Checking & Savings ──────────────────────────────────────────────────────
for (let n = DAYS; n >= 0; n--) {
  const d = daysAgo(n);
  const dow = d.getUTCDay(); // 0 Sun
  const dom = d.getUTCDate();

  // Biweekly payroll — Fridays, every other ISO week
  if (dow === 5 && Math.floor(n / 7) % 2 === 0) {
    tx(CHECKING_WS, 'acct_chk_001', d, 'Payroll - GUSTO PAY', 'Gusto', 4317.29, 'Income');
  }
  // Monthly fixed obligations
  if (dom === 1) tx(CHECKING_WS, 'acct_chk_001', d, 'Wells Fargo Home Mtg', 'Wells Fargo', -2315.00, 'Mortgage');
  if (dom === 5) {
    tx(CHECKING_WS, 'acct_chk_001', d, 'Bright Horizons Tuition', 'Bright Horizons', -1150.00, 'Childcare');
    tx(CHECKING_WS, 'acct_chk_001', d, 'Planet Fitness', 'Planet Fitness', -24.99, 'Subscriptions & Streaming');
  }
  if (dom === 8) tx(CHECKING_WS, 'acct_chk_001', d, 'ConEd Electric', 'ConEdison', -between(135, 225), 'Utilities');
  if (dom === 13) tx(CHECKING_WS, 'acct_chk_001', d, 'Spotify', 'Spotify', -11.99, 'Subscriptions & Streaming');
  if (dom === 15) tx(CHECKING_WS, 'acct_chk_001', d, 'Xfinity Internet', 'Comcast', -89.99, 'Utilities');
  if (dom === 18) tx(CHECKING_WS, 'acct_chk_001', d, 'Netflix', 'Netflix', -15.99, 'Subscriptions & Streaming');
  if (dom === 20) tx(CHECKING_WS, 'acct_chk_001', d, 'T-Mobile', 'T-Mobile', -95.00, 'Utilities');
  if (dom === 28) tx(CHECKING_WS, 'acct_chk_001', d, 'Apple iCloud', 'Apple', -2.99, 'Subscriptions & Streaming');

  // Debt service + transfers (the gap signals live here)
  if (dom === 3) tx(CHECKING_WS, 'acct_chk_001', d, 'CITI AUTOPAY PAYMENT', 'Citi', -420.00, 'Credit Card Payment');
  if (dom === 10) tx(CHECKING_WS, 'acct_chk_001', d, 'NAVIENT E-PAY', 'Navient', -310.00, 'Loan Payment');
  if (dom === 16) tx(CHECKING_WS, 'acct_chk_001', d, 'CHASE CREDIT CRD AUTOPAY', 'Chase', -1850.00, 'Credit Card Payment');
  if (dom === 17) tx(CHECKING_WS, 'acct_chk_001', d, 'AMEX EPAYMENT ACH PMT', 'American Express', -650.00, 'Credit Card Payment');
  if (dom === 22) tx(CHECKING_WS, 'acct_chk_001', d, 'Online Transfer to Ally Bank x8912', 'Ally Bank', -500.00, 'Transfer');
  if (dom === 26) tx(CHECKING_WS, 'acct_chk_001', d, 'Transfer to High-Yield Savings', 'Internal Transfer', -800.00, 'Transfer');
  if (dom === 26) tx(CHECKING_WS, 'acct_sav_001', d, 'Transfer from Checking', 'Internal Transfer', 800.00, 'Transfer');
  if (dom === 27) tx(CHECKING_WS, 'acct_sav_001', d, 'Interest Payment', 'Marcus', between(140, 165), 'Income');

  // Weekly-ish variable spending
  if (dow === 6) tx(CHECKING_WS, 'acct_chk_001', d, 'Whole Foods Market', 'Whole Foods', -between(85, 165), 'Groceries');
  if (dow === 3) tx(CHECKING_WS, 'acct_chk_001', d, 'Trader Joes', 'Trader Joes', -between(55, 110), 'Groceries');
  if (dow === 1) tx(CHECKING_WS, 'acct_chk_001', d, 'Shell Gas Station', 'Shell', -between(42, 68), 'Transportation');
  if (dow === 2 && rand() < 0.7) tx(CHECKING_WS, 'acct_chk_001', d, 'Starbucks', 'Starbucks', -between(5.5, 9.5), 'Restaurants & Dining');
  if (dow === 4 && rand() < 0.6) tx(CHECKING_WS, 'acct_chk_001', d, 'Chipotle', 'Chipotle', -between(11, 28), 'Restaurants & Dining');
  if (dow === 0 && rand() < 0.5) tx(CHECKING_WS, 'acct_chk_001', d, 'Amazon.com', 'Amazon', -between(20, 160), 'Shopping');
  if (dom === 11 || dom === 24) tx(CHECKING_WS, 'acct_chk_001', d, 'Target', 'Target', -between(45, 120), 'Shopping');
  if (dom === 9) tx(CHECKING_WS, 'acct_chk_001', d, 'CVS Pharmacy', 'CVS', -between(15, 55), 'Health & Medical');
}

// ── Debt Management (card purchases + payments received) ────────────────────
for (let n = DAYS; n >= 0; n--) {
  const d = daysAgo(n);
  const dow = d.getUTCDay();
  const dom = d.getUTCDate();

  // Chase Sapphire — dining & travel card
  if (dow === 5) tx(DEBT_WS, 'acct_cc_001', d, 'The Osprey Restaurant', 'The Osprey', -between(65, 140), 'Restaurants & Dining');
  if (dow === 2 && rand() < 0.8) tx(DEBT_WS, 'acct_cc_001', d, 'DoorDash', 'DoorDash', -between(28, 62), 'Restaurants & Dining');
  if (dow === 0 && rand() < 0.4) tx(DEBT_WS, 'acct_cc_001', d, 'Uber', 'Uber', -between(14, 38), 'Transportation');
  if (dom === 12 && n > 30) tx(DEBT_WS, 'acct_cc_001', d, 'Delta Air Lines', 'Delta', -between(280, 540), 'Travel');
  if (dom === 16) tx(DEBT_WS, 'acct_cc_001', d, 'Payment Thank You - AutoPay', 'Chase', 1850.00, 'Credit Card Payment');

  // Amex Gold — groceries & everyday
  if (dow === 4) tx(DEBT_WS, 'acct_cc_002', d, 'Whole Foods Market', 'Whole Foods', -between(40, 95), 'Groceries');
  if (dow === 6 && rand() < 0.5) tx(DEBT_WS, 'acct_cc_002', d, 'Sweetgreen', 'Sweetgreen', -between(14, 24), 'Restaurants & Dining');
  if (dom === 17) tx(DEBT_WS, 'acct_cc_002', d, 'AMEX AUTOPAY PYMT RECD', 'American Express', 650.00, 'Credit Card Payment');

  // Navient student loan — payment posts
  if (dom === 10) tx(DEBT_WS, 'acct_loan_001', d, 'Payment Received - Web', 'Navient', 310.00, 'Loan Payment');
}

// ── Write ───────────────────────────────────────────────────────────────────
// RLS scopes every pod's DB role to its own workspace_id, so this script only
// writes the rows belonging to the pod it runs in — run it once in the
// checking pod and once in the debt pod to seed both.
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const who = (await pool.query('SELECT current_user')).rows[0].current_user.toLowerCase();
  const mine = [CHECKING_WS, DEBT_WS].filter((w) => who.includes(w.toLowerCase()));
  if (mine.length !== 1) { console.error(`cannot map role ${who} to one demo workspace`); process.exit(1); }
  const myRows = rows.filter((r) => r.workspace_id === mine[0]);
  const del = await pool.query(
    `DELETE FROM plaid_transactions WHERE workspace_id = $1 AND (transaction_id LIKE 'demo_%' OR transaction_id LIKE 'tx_%' OR transaction_id LIKE 'dtx_%')`,
    [mine[0]]
  );
  let hasSource = true;
  try { await pool.query('SELECT category_source FROM plaid_transactions LIMIT 0'); }
  catch { hasSource = false; }
  for (const r of myRows) {
    if (hasSource) {
      await pool.query(
        `INSERT INTO plaid_transactions (transaction_id, account_id, date, name, merchant_name, amount, category, category_source, workspace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'arthur',$8) ON CONFLICT (transaction_id) DO NOTHING`,
        [r.transaction_id, r.account_id, r.date, r.name, r.merchant_name, r.amount, r.category, r.workspace_id]
      );
    } else {
      await pool.query(
        `INSERT INTO plaid_transactions (transaction_id, account_id, date, name, merchant_name, amount, category, workspace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (transaction_id) DO NOTHING`,
        [r.transaction_id, r.account_id, r.date, r.name, r.merchant_name, r.amount, r.category, r.workspace_id]
      );
    }
  }
  // Fresh data should read as freshly synced — a stale synced_at makes Arthur
  // honestly report "last synced N days ago" about data seeded minutes ago.
  await pool.query('UPDATE plaid_accounts SET synced_at = NOW()');
  const counts = await pool.query(
    `SELECT workspace_id, COUNT(*) n, MIN(date) oldest, MAX(date) newest FROM plaid_transactions WHERE workspace_id = $1 GROUP BY workspace_id`,
    [mine[0]]
  );
  console.log('deleted:', del.rowCount, '| inserted:', myRows.length);
  console.log(JSON.stringify(counts.rows, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
