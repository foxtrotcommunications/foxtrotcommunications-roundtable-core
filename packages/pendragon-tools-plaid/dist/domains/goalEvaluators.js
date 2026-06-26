// src/domains/goalEvaluators.ts — Per-domain goal progress evaluators
// Each domain type has specialized logic for computing progress toward goals.
// Uses OBSERVED data (actual balances, actual payments) — not user-stated amounts.
const DEFAULT_GROWTH_RATE = 0.07; // 7% annual
const MONTHS_FOR_AVERAGE = 3; // Use 3-month rolling average
/**
 * Compute a resource_request block for a goal.
 *
 * The urgency_score (0.0–1.0) drives cross-domain budget arbitration:
 *   - Debt: APR-weighted  →  0.3 + 0.7 × min(apr/30, 1)
 *   - Checking/Savings (emergency fund): below target → 0.8, above → 0.0
 *   - Retirement: 0.6 base, adjusted by shortfall ratio
 *   - Investments: 0.5 base
 *   - Real Estate: equity_ratio < 0.2 → 0.7, else 0.4
 *   - Taxes: seasonal (Q4/Q1 → 0.6, Q2/Q3 → 0.3)
 *   - Default: 0.5
 *
 * @param goal         The raw goal row from domain_goals
 * @param progress     Partial GoalProgress computed so far (needs monthly_required, monthly_current, gap, on_track)
 * @param domainType   Which domain this goal belongs to
 * @param extras       Domain-specific parameters for urgency tuning
 */
function computeResourceRequest(goal, progress, domainType, extras) {
    const monthlyRequired = progress.monthly_required ?? 0;
    const monthlyCurrent = progress.monthly_current ?? 0;
    const monthlyRequested = Math.max(monthlyRequired - monthlyCurrent, 0);
    // ── Urgency score by domain ──────────────────────────────────────────────
    let urgencyScore;
    const urgencyFactors = [];
    switch (domainType) {
        case 'debt': {
            const apr = extras?.apr ?? 0;
            urgencyScore = 0.3 + 0.7 * Math.min(apr / 30, 1);
            if (apr > 0)
                urgencyFactors.push(`${apr.toFixed(1)}% APR`);
            break;
        }
        case 'checking':
        case 'savings': {
            // Emergency-fund style: high urgency when below target
            const belowTarget = (progress.progress_pct ?? 0) < 100;
            urgencyScore = belowTarget ? 0.8 : 0.0;
            if (belowTarget)
                urgencyFactors.push('Below emergency-fund target');
            break;
        }
        case 'retirement': {
            // 0.6 base, scaled up by shortfall ratio (gap / required)
            const shortfallRatio = monthlyRequired > 0 ? Math.min((progress.gap ?? 0) / monthlyRequired, 1) : 0;
            urgencyScore = 0.6 + 0.3 * shortfallRatio;
            if (shortfallRatio > 0.3)
                urgencyFactors.push(`${(shortfallRatio * 100).toFixed(0)}% contribution shortfall`);
            break;
        }
        case 'investments': {
            urgencyScore = 0.5;
            break;
        }
        case 'realestate': {
            const eqRatio = extras?.equity_ratio ?? 1;
            urgencyScore = eqRatio < 0.2 ? 0.7 : 0.4;
            if (eqRatio < 0.2)
                urgencyFactors.push(`Equity ratio ${(eqRatio * 100).toFixed(0)}% (< 20%)`);
            break;
        }
        case 'taxes': {
            // Seasonal: Q4 (Oct-Dec) and Q1 (Jan-Mar) are higher urgency
            const month = new Date().getMonth(); // 0-indexed
            const highSeason = month >= 9 || month <= 2; // Oct–Mar
            urgencyScore = highSeason ? 0.6 : 0.3;
            urgencyFactors.push(highSeason ? 'Tax season (Q4/Q1)' : 'Off-season (Q2/Q3)');
            break;
        }
        default:
            urgencyScore = 0.5;
            break;
    }
    // Deadline pressure: boost urgency when close to target_date
    if (extras?.deadline_months !== undefined && extras.deadline_months > 0) {
        const deadlinePressure = Math.min(12 / extras.deadline_months, 0.3);
        urgencyScore = Math.min(urgencyScore + deadlinePressure, 1.0);
        if (extras.deadline_months <= 12) {
            urgencyFactors.push(`${extras.deadline_months} months to deadline`);
        }
    }
    // Clamp
    urgencyScore = Math.round(Math.min(Math.max(urgencyScore, 0), 1) * 100) / 100;
    // ── Opportunity cost ─────────────────────────────────────────────────────
    let opportunityCost;
    if (domainType === 'debt') {
        // Monthly interest cost of NOT paying this down
        const apr = extras?.apr ?? 0;
        const gap = progress.gap ?? 0;
        opportunityCost = Math.round(gap * (apr / 100 / 12) * 100) / 100;
    }
    else {
        // Estimated lost growth at default rate
        opportunityCost = Math.round(monthlyRequested * (DEFAULT_GROWTH_RATE / 12) * 100) / 100;
    }
    return {
        monthly_requested: Math.round(monthlyRequested),
        urgency_score: urgencyScore,
        urgency_factors: urgencyFactors,
        deferrable: urgencyScore < 0.5,
        opportunity_cost: opportunityCost,
    };
}
export async function evaluateGoalProgress(pool, goalId, domainType) {
    // Read the goal
    const goalResult = await pool.query(`SELECT * FROM domain_goals WHERE id = $1`, [goalId]);
    if (goalResult.rows.length === 0) {
        return {
            goal_id: goalId,
            goal_name: 'Unknown',
            goal_type: 'unknown',
            target_amount: null,
            target_date: null,
            current_value: 0,
            progress_pct: 0,
            on_track: false,
            projected_date: null,
            monthly_required: null,
            monthly_current: null,
            gap: null,
            recommendation: 'Goal not found',
            details: {},
            resource_request: null,
            error: 'Goal not found',
        };
    }
    const goal = goalResult.rows[0];
    // ── Snapshot-first strategy ──────────────────────────────────────────────
    // When multiple goals share a domain (e.g., 3 college funds + retirement
    // in the retirement domain), the domain-level aggregate query would apply
    // the TOTAL portfolio balance to every goal. Check for a recent snapshot
    // first and use per-goal values when available.
    const snapshotResult = await pool.query(`SELECT * FROM goal_snapshots
     WHERE goal_id = $1
       AND snapshot_at >= NOW() - INTERVAL '7 days'
     ORDER BY snapshot_at DESC
     LIMIT 1`, [goalId]);
    if (snapshotResult.rows.length > 0) {
        const snap = snapshotResult.rows[0];
        const targetAmount = goal.target_amount ?? 0;
        const currentValue = parseFloat(snap.current_value) || 0;
        const progressPct = parseFloat(snap.progress_pct) || 0;
        const onTrack = snap.on_track ?? false;
        const projectedDate = snap.projected_date || null;
        const details = snap.details || {};
        // Compute monthly gap if we have a target date
        let monthlyRequired = null;
        let gap = null;
        const monthlyContrib = goal.monthly_contribution || 0;
        if (goal.target_date && targetAmount > 0) {
            const targetDate = new Date(goal.target_date);
            const now = new Date();
            const monthsRemaining = Math.max((targetDate.getFullYear() - now.getFullYear()) * 12 +
                (targetDate.getMonth() - now.getMonth()), 1);
            const remaining = Math.max(targetAmount - currentValue, 0);
            monthlyRequired = Math.round(remaining / monthsRemaining);
            gap = Math.max(monthlyRequired - monthlyContrib, 0);
        }
        let recommendation = '';
        if (progressPct >= 100) {
            recommendation = 'Goal achieved! 🎉';
        }
        else if (onTrack) {
            recommendation = `On track at $${currentValue.toLocaleString()} of $${targetAmount.toLocaleString()} target.`;
        }
        else if (gap !== null && gap > 0) {
            recommendation = `Behind target. Increase contributions by $${gap}/mo to stay on track.`;
        }
        else {
            recommendation = `$${currentValue.toLocaleString()} of $${targetAmount.toLocaleString()} target (${progressPct.toFixed(1)}%).`;
        }
        return {
            goal_id: goalId,
            goal_name: goal.name,
            goal_type: goal.goal_type,
            target_amount: targetAmount,
            target_date: goal.target_date,
            current_value: currentValue,
            progress_pct: Math.round(progressPct * 10) / 10,
            on_track: onTrack,
            projected_date: projectedDate,
            monthly_required: monthlyRequired,
            monthly_current: monthlyContrib ? Math.round(monthlyContrib) : null,
            gap,
            recommendation,
            details: { ...details, source: 'goal_snapshot' },
            resource_request: null, // Snapshots don't store resource_request — it's computed live
        };
    }
    // ────────────────────────────────────────────────────────────────────────
    // No recent snapshot — fall back to domain-specific evaluator
    switch (domainType) {
        case 'checking':
        case 'savings':
            return evaluateSavingsGoal(pool, goal);
        case 'debt':
            return evaluateDebtGoal(pool, goal);
        case 'investments':
            return evaluateInvestmentGoal(pool, goal, DEFAULT_GROWTH_RATE);
        case 'retirement':
            return evaluateRetirementGoal(pool, goal, DEFAULT_GROWTH_RATE);
        case 'realestate':
            return evaluateRealEstateGoal(pool, goal);
        case 'taxes':
            return evaluateTaxGoal(pool, goal);
        default:
            return evaluateGenericGoal(pool, goal);
    }
}
// ─── Checking / Savings Goals ───────────────────────────────────────────────
async function evaluateSavingsGoal(pool, goal) {
    // Get current total balance
    const balanceResult = await pool.query(`SELECT COALESCE(SUM(balance_current), 0) as total_balance FROM plaid_accounts`);
    const currentBalance = parseFloat(balanceResult.rows[0].total_balance) || 0;
    // Get monthly savings rate from recent transactions (income - expenses)
    const savingsResult = await pool.query(`SELECT
       COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) as total_income,
       COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as total_expenses,
       COUNT(DISTINCT date_trunc('month', date)) as months_counted
     FROM plaid_transactions
     WHERE date >= NOW() - INTERVAL '${MONTHS_FOR_AVERAGE} months'
       AND pending = false`);
    const { total_income, total_expenses, months_counted } = savingsResult.rows[0];
    const monthsCounted = Math.max(parseFloat(months_counted) || 1, 1);
    const monthlyIncome = parseFloat(total_income) / monthsCounted;
    const monthlyExpenses = parseFloat(total_expenses) / monthsCounted;
    const monthlySavings = monthlyIncome - monthlyExpenses;
    const targetAmount = goal.target_amount || 0;
    const remaining = Math.max(targetAmount - currentBalance, 0);
    const progressPct = targetAmount > 0 ? Math.min((currentBalance / targetAmount) * 100, 100) : 0;
    // Project when target will be reached
    let projectedDate = null;
    let monthsToTarget = null;
    if (monthlySavings > 0 && remaining > 0) {
        monthsToTarget = Math.ceil(remaining / monthlySavings);
        const projected = new Date();
        projected.setMonth(projected.getMonth() + monthsToTarget);
        projectedDate = projected.toISOString().split('T')[0];
    }
    // Determine if on track
    let onTrack = false;
    let monthlyRequired = null;
    if (goal.target_date) {
        const targetDate = new Date(goal.target_date);
        const now = new Date();
        const monthsRemaining = Math.max((targetDate.getFullYear() - now.getFullYear()) * 12 + (targetDate.getMonth() - now.getMonth()), 1);
        monthlyRequired = remaining / monthsRemaining;
        onTrack = monthlySavings >= monthlyRequired;
    }
    else if (remaining <= 0) {
        onTrack = true;
    }
    const gap = monthlyRequired !== null ? Math.max(monthlyRequired - monthlySavings, 0) : null;
    let recommendation = '';
    if (remaining <= 0) {
        recommendation = 'Goal achieved! Consider setting a new target.';
    }
    else if (onTrack) {
        recommendation = `On track. At your current savings rate of $${monthlySavings.toFixed(0)}/mo, you'll reach your target${projectedDate ? ' by ' + projectedDate : ''}.`;
    }
    else if (gap !== null && gap > 0) {
        recommendation = `Behind target. Increase monthly savings by $${gap.toFixed(0)} to stay on track for ${goal.target_date}.`;
    }
    else {
        recommendation = `Saving $${monthlySavings.toFixed(0)}/mo toward $${targetAmount.toLocaleString()} target.`;
    }
    // Compute resource request with urgency scoring
    const deadlineMonths = goal.target_date
        ? Math.max((new Date(goal.target_date).getFullYear() - new Date().getFullYear()) * 12 +
            (new Date(goal.target_date).getMonth() - new Date().getMonth()), 1)
        : undefined;
    const partialProgress = {
        monthly_required: monthlyRequired ? Math.round(monthlyRequired) : null,
        monthly_current: Math.round(monthlySavings),
        gap: gap !== null ? Math.round(gap) : null,
        progress_pct: Math.round(progressPct * 10) / 10,
        on_track: onTrack,
    };
    const resource_request = computeResourceRequest(goal, partialProgress, goal.goal_type === 'emergency_fund' ? 'savings' : 'checking', { deadline_months: deadlineMonths });
    return {
        goal_id: goal.id,
        goal_name: goal.name,
        goal_type: goal.goal_type,
        target_amount: targetAmount,
        target_date: goal.target_date,
        current_value: currentBalance,
        progress_pct: Math.round(progressPct * 10) / 10,
        on_track: onTrack,
        projected_date: projectedDate,
        monthly_required: monthlyRequired ? Math.round(monthlyRequired) : null,
        monthly_current: Math.round(monthlySavings),
        gap: gap !== null ? Math.round(gap) : null,
        recommendation,
        details: { monthlyIncome: Math.round(monthlyIncome), monthlyExpenses: Math.round(monthlyExpenses), monthsCounted },
        resource_request,
    };
}
// ─── Debt Goals ─────────────────────────────────────────────────────────────
async function evaluateDebtGoal(pool, goal) {
    // Get current total debt
    const debtResult = await pool.query(`SELECT
       COALESCE(SUM(a.balance_current), 0) as total_debt,
       COALESCE(SUM(l.minimum_payment_amount), 0) as total_minimum,
       COALESCE(AVG(l.interest_rate), 0) as avg_rate
     FROM plaid_liabilities l
     LEFT JOIN plaid_accounts a ON a.account_id = l.account_id`);
    const totalDebt = Math.abs(parseFloat(debtResult.rows[0].total_debt) || 0);
    const totalMinimum = parseFloat(debtResult.rows[0].total_minimum) || 0;
    const avgRate = parseFloat(debtResult.rows[0].avg_rate) || 0;
    // Observe actual monthly payments from transactions (last 3 months)
    const paymentResult = await pool.query(`SELECT
       COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) as total_payments,
       COUNT(DISTINCT date_trunc('month', date)) as months_counted
     FROM plaid_transactions
     WHERE date >= NOW() - INTERVAL '${MONTHS_FOR_AVERAGE} months'
       AND pending = false
       AND amount < 0`);
    const monthsCounted = Math.max(parseFloat(paymentResult.rows[0].months_counted) || 1, 1);
    const monthlyPayment = parseFloat(paymentResult.rows[0].total_payments) / monthsCounted;
    // For debt goals, target_amount is typically 0 (debt-free) or a reduced balance
    const targetAmount = goal.target_amount ?? 0;
    const remaining = Math.max(totalDebt - targetAmount, 0);
    // Progress: how much of the original debt has been paid toward target
    // If we have snapshots, use the first snapshot as baseline
    const baselineResult = await pool.query(`SELECT current_value FROM goal_snapshots WHERE goal_id = $1 ORDER BY snapshot_at ASC LIMIT 1`, [goal.id]);
    const baseline = baselineResult.rows.length > 0 ? parseFloat(baselineResult.rows[0].current_value) : totalDebt;
    const totalReduction = Math.max(baseline - targetAmount, 1);
    const progressPct = Math.min(((baseline - totalDebt) / totalReduction) * 100, 100);
    // Simple payoff projection (monthly payment - monthly interest)
    const monthlyRate = avgRate / 100 / 12;
    const monthlyInterest = totalDebt * monthlyRate;
    const principalPayment = Math.max(monthlyPayment - monthlyInterest, 0);
    let projectedDate = null;
    let monthsToPayoff = null;
    if (principalPayment > 0 && remaining > 0) {
        // Amortization: n = -log(1 - r*PV/PMT) / log(1+r)
        if (monthlyRate > 0 && monthlyPayment > monthlyInterest) {
            monthsToPayoff = Math.ceil(-Math.log(1 - (monthlyRate * remaining) / monthlyPayment) / Math.log(1 + monthlyRate));
        }
        else {
            monthsToPayoff = Math.ceil(remaining / principalPayment);
        }
        const projected = new Date();
        projected.setMonth(projected.getMonth() + monthsToPayoff);
        projectedDate = projected.toISOString().split('T')[0];
    }
    let onTrack = false;
    let monthlyRequired = null;
    if (goal.target_date) {
        const targetDate = new Date(goal.target_date);
        const now = new Date();
        const monthsRemaining = Math.max((targetDate.getFullYear() - now.getFullYear()) * 12 + (targetDate.getMonth() - now.getMonth()), 1);
        // Required payment to hit target date (simplified — ignores compounding for estimate)
        if (monthlyRate > 0) {
            monthlyRequired = (remaining * monthlyRate * Math.pow(1 + monthlyRate, monthsRemaining)) /
                (Math.pow(1 + monthlyRate, monthsRemaining) - 1);
        }
        else {
            monthlyRequired = remaining / monthsRemaining;
        }
        onTrack = monthlyPayment >= monthlyRequired;
    }
    else if (remaining <= 0) {
        onTrack = true;
    }
    const gap = monthlyRequired !== null ? Math.max(monthlyRequired - monthlyPayment, 0) : null;
    let recommendation = '';
    if (remaining <= 0) {
        recommendation = 'Debt goal achieved! 🎉';
    }
    else if (onTrack) {
        recommendation = `On track. At $${monthlyPayment.toFixed(0)}/mo, debt will be paid off${projectedDate ? ' by ' + projectedDate : ''}.`;
    }
    else if (gap !== null && gap > 0) {
        recommendation = `Increase monthly payments by $${gap.toFixed(0)} to hit your ${goal.target_date} target.`;
    }
    else {
        recommendation = `Paying $${monthlyPayment.toFixed(0)}/mo against $${totalDebt.toLocaleString()} total debt (avg ${avgRate.toFixed(1)}% APR).`;
    }
    // Compute resource request with APR-weighted urgency
    const debtDeadlineMonths = goal.target_date
        ? Math.max((new Date(goal.target_date).getFullYear() - new Date().getFullYear()) * 12 +
            (new Date(goal.target_date).getMonth() - new Date().getMonth()), 1)
        : undefined;
    const resource_request = computeResourceRequest(goal, {
        monthly_required: monthlyRequired ? Math.round(monthlyRequired) : null,
        monthly_current: Math.round(monthlyPayment),
        gap: gap !== null ? Math.round(gap) : null,
        progress_pct: Math.round(Math.max(progressPct, 0) * 10) / 10,
        on_track: onTrack,
    }, 'debt', { apr: avgRate, deadline_months: debtDeadlineMonths });
    return {
        goal_id: goal.id,
        goal_name: goal.name,
        goal_type: goal.goal_type,
        target_amount: targetAmount,
        target_date: goal.target_date,
        current_value: totalDebt,
        progress_pct: Math.round(Math.max(progressPct, 0) * 10) / 10,
        on_track: onTrack,
        projected_date: projectedDate,
        monthly_required: monthlyRequired ? Math.round(monthlyRequired) : null,
        monthly_current: Math.round(monthlyPayment),
        gap: gap !== null ? Math.round(gap) : null,
        recommendation,
        details: { totalDebt, avgRate, monthlyInterest: Math.round(monthlyInterest), principalPayment: Math.round(principalPayment), totalMinimum },
        resource_request,
    };
}
// ─── Investment Goals ───────────────────────────────────────────────────────
async function evaluateInvestmentGoal(pool, goal, growthRate) {
    // Get current portfolio value
    const holdingsResult = await pool.query(`SELECT COALESCE(SUM(institution_value), 0) as total_value FROM plaid_holdings`);
    const currentValue = parseFloat(holdingsResult.rows[0].total_value) || 0;
    const targetAmount = goal.target_amount || 0;
    const progressPct = targetAmount > 0 ? Math.min((currentValue / targetAmount) * 100, 100) : 0;
    // Estimate monthly contributions from recent snapshots or use stated
    const monthlyContrib = goal.monthly_contribution || 0;
    const monthlyRate = growthRate / 12;
    // Project future value: FV = PV(1+r)^n + PMT*((1+r)^n - 1)/r
    let projectedDate = null;
    let onTrack = false;
    let monthlyRequired = null;
    if (goal.target_date) {
        const targetDate = new Date(goal.target_date);
        const now = new Date();
        const monthsRemaining = Math.max((targetDate.getFullYear() - now.getFullYear()) * 12 + (targetDate.getMonth() - now.getMonth()), 1);
        // Project what we'll have at target date
        const projectedValue = currentValue * Math.pow(1 + monthlyRate, monthsRemaining) +
            monthlyContrib * ((Math.pow(1 + monthlyRate, monthsRemaining) - 1) / monthlyRate);
        onTrack = projectedValue >= targetAmount;
        // What monthly contribution would be needed?
        const growthFactor = Math.pow(1 + monthlyRate, monthsRemaining);
        const futureGap = Math.max(targetAmount - currentValue * growthFactor, 0);
        monthlyRequired = futureGap > 0 ? futureGap / ((growthFactor - 1) / monthlyRate) : 0;
    }
    // When will we reach target at current rate?
    if (currentValue < targetAmount && monthlyContrib > 0) {
        // Solve: targetAmount = currentValue*(1+r)^n + PMT*((1+r)^n - 1)/r
        // Iterative approximation
        let months = 0;
        let projected = currentValue;
        while (projected < targetAmount && months < 600) {
            projected = projected * (1 + monthlyRate) + monthlyContrib;
            months++;
        }
        if (months < 600) {
            const d = new Date();
            d.setMonth(d.getMonth() + months);
            projectedDate = d.toISOString().split('T')[0];
        }
    }
    else if (currentValue >= targetAmount) {
        onTrack = true;
        projectedDate = new Date().toISOString().split('T')[0];
    }
    const gap = monthlyRequired !== null ? Math.max(monthlyRequired - monthlyContrib, 0) : null;
    let recommendation = '';
    if (currentValue >= targetAmount) {
        recommendation = 'Goal achieved! Portfolio has reached target value.';
    }
    else if (onTrack) {
        recommendation = `On track. At $${monthlyContrib.toFixed(0)}/mo with ${(growthRate * 100).toFixed(0)}% assumed growth, you'll hit your target${projectedDate ? ' by ' + projectedDate : ''}.`;
    }
    else if (gap !== null && gap > 0) {
        recommendation = `Increase monthly contributions by $${gap.toFixed(0)} to reach $${targetAmount.toLocaleString()} by ${goal.target_date}.`;
    }
    else {
        recommendation = `Portfolio at $${currentValue.toLocaleString()} of $${targetAmount.toLocaleString()} target.`;
    }
    // Compute resource request — domain type is 'investments' (retirement delegates here too)
    const investDeadlineMonths = goal.target_date
        ? Math.max((new Date(goal.target_date).getFullYear() - new Date().getFullYear()) * 12 +
            (new Date(goal.target_date).getMonth() - new Date().getMonth()), 1)
        : undefined;
    const resource_request = computeResourceRequest(goal, {
        monthly_required: monthlyRequired ? Math.round(monthlyRequired) : null,
        monthly_current: Math.round(monthlyContrib),
        gap: gap !== null ? Math.round(gap) : null,
        progress_pct: Math.round(progressPct * 10) / 10,
        on_track: onTrack,
    }, 'investments', { deadline_months: investDeadlineMonths });
    return {
        goal_id: goal.id,
        goal_name: goal.name,
        goal_type: goal.goal_type,
        target_amount: targetAmount,
        target_date: goal.target_date,
        current_value: currentValue,
        progress_pct: Math.round(progressPct * 10) / 10,
        on_track: onTrack,
        projected_date: projectedDate,
        monthly_required: monthlyRequired ? Math.round(monthlyRequired) : null,
        monthly_current: Math.round(monthlyContrib),
        gap: gap !== null ? Math.round(gap) : null,
        recommendation,
        details: { growthRateAssumption: growthRate, currentValue },
        resource_request,
    };
}
// ─── Retirement Goals ───────────────────────────────────────────────────────
async function evaluateRetirementGoal(pool, goal, growthRate) {
    // Retirement goals use the same math as investment but may use target_age from parameters
    return evaluateInvestmentGoal(pool, goal, growthRate);
}
// ─── Real Estate Goals ──────────────────────────────────────────────────────
async function evaluateRealEstateGoal(pool, goal) {
    // Get current equity from accounts (value - mortgage)
    const equityResult = await pool.query(`SELECT
       COALESCE(SUM(CASE WHEN a.type != 'loan' THEN a.balance_current ELSE 0 END), 0) as asset_value,
       COALESCE(SUM(CASE WHEN a.type = 'loan' THEN ABS(a.balance_current) ELSE 0 END), 0) as loan_balance
     FROM plaid_accounts a`);
    const assetValue = parseFloat(equityResult.rows[0].asset_value) || 0;
    const loanBalance = parseFloat(equityResult.rows[0].loan_balance) || 0;
    const equity = assetValue - loanBalance;
    const targetAmount = goal.target_amount || 0;
    const progressPct = targetAmount > 0 ? Math.min((equity / targetAmount) * 100, 100) : 0;
    // Compute resource request with equity-ratio urgency
    const equityRatio = assetValue > 0 ? equity / assetValue : 1;
    const resource_request = computeResourceRequest(goal, {
        monthly_required: null,
        monthly_current: null,
        gap: null,
        progress_pct: Math.round(progressPct * 10) / 10,
        on_track: equity >= targetAmount,
    }, 'realestate', { equity_ratio: equityRatio });
    return {
        goal_id: goal.id,
        goal_name: goal.name,
        goal_type: goal.goal_type,
        target_amount: targetAmount,
        target_date: goal.target_date,
        current_value: equity,
        progress_pct: Math.round(progressPct * 10) / 10,
        on_track: equity >= targetAmount,
        projected_date: null,
        monthly_required: null,
        monthly_current: null,
        gap: null,
        recommendation: equity >= targetAmount
            ? `Equity target met. Current equity: $${equity.toLocaleString()}`
            : `Equity at $${equity.toLocaleString()} of $${targetAmount.toLocaleString()} target.`,
        details: { assetValue, loanBalance, equity },
        resource_request,
    };
}
// ─── Tax Goals ──────────────────────────────────────────────────────────────
async function evaluateTaxGoal(pool, goal) {
    // Tax goals use generic balance logic but with seasonal urgency scoring
    const balanceResult = await pool.query(`SELECT COALESCE(SUM(balance_current), 0) as total FROM plaid_accounts`);
    const currentValue = parseFloat(balanceResult.rows[0].total) || 0;
    const targetAmount = goal.target_amount || 0;
    const progressPct = targetAmount > 0 ? Math.min((currentValue / targetAmount) * 100, 100) : 0;
    const resource_request = computeResourceRequest(goal, {
        monthly_required: null,
        monthly_current: null,
        gap: null,
        progress_pct: Math.round(progressPct * 10) / 10,
        on_track: currentValue >= targetAmount,
    }, 'taxes');
    return {
        goal_id: goal.id,
        goal_name: goal.name,
        goal_type: goal.goal_type,
        target_amount: targetAmount,
        target_date: goal.target_date,
        current_value: currentValue,
        progress_pct: Math.round(progressPct * 10) / 10,
        on_track: currentValue >= targetAmount,
        projected_date: null,
        monthly_required: null,
        monthly_current: null,
        gap: null,
        recommendation: `Current value: $${currentValue.toLocaleString()} of $${targetAmount.toLocaleString()} target.`,
        details: {},
        resource_request,
    };
}
// ─── Generic Fallback ───────────────────────────────────────────────────────
async function evaluateGenericGoal(pool, goal) {
    const balanceResult = await pool.query(`SELECT COALESCE(SUM(balance_current), 0) as total FROM plaid_accounts`);
    const currentValue = parseFloat(balanceResult.rows[0].total) || 0;
    const targetAmount = goal.target_amount || 0;
    const progressPct = targetAmount > 0 ? Math.min((currentValue / targetAmount) * 100, 100) : 0;
    const resource_request = computeResourceRequest(goal, {
        monthly_required: null,
        monthly_current: null,
        gap: null,
        progress_pct: Math.round(progressPct * 10) / 10,
        on_track: currentValue >= targetAmount,
    }, 'demographics');
    return {
        goal_id: goal.id,
        goal_name: goal.name,
        goal_type: goal.goal_type,
        target_amount: targetAmount,
        target_date: goal.target_date,
        current_value: currentValue,
        progress_pct: Math.round(progressPct * 10) / 10,
        on_track: currentValue >= targetAmount,
        projected_date: null,
        monthly_required: null,
        monthly_current: null,
        gap: null,
        recommendation: `Current value: $${currentValue.toLocaleString()} of $${targetAmount.toLocaleString()} target.`,
        details: {},
        resource_request,
    };
}
//# sourceMappingURL=goalEvaluators.js.map