// src/domains/demographics.ts — Demographics domain module
// Contains tools and capabilities for the demographics domain.
// Unlike other domains, Demographics does NOT use Plaid — it queries
// PostgreSQL directly for user profile, household, goals, and preferences.
import { withPool } from '../db/pool.js';
// ─── Capability Handlers ────────────────────────────────────────────────────
function createGetUserProfileHandler(config) {
    return async (_input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            const { rows } = await pool.query(`SELECT id, display_name, date_of_birth, gender,
                state_of_residence, filing_status, education,
                employment_status, annual_income_estimate, created_at
         FROM user_profile
         ORDER BY id LIMIT 1`);
            if (rows.length === 0)
                return { error: 'No user profile found' };
            const profile = rows[0];
            // Calculate age from date_of_birth
            if (profile.date_of_birth) {
                const dob = new Date(profile.date_of_birth);
                const today = new Date();
                let age = today.getFullYear() - dob.getFullYear();
                const monthDiff = today.getMonth() - dob.getMonth();
                if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
                    age--;
                }
                profile.age_years = age;
            }
            return { profile };
        });
    };
}
function createGetHouseholdHandler(config) {
    return async (_input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            const { rows } = await pool.query(`SELECT id, user_id, relationship, name,
                date_of_birth, age_years, created_at
         FROM household_members
         ORDER BY date_of_birth ASC`);
            return { members: rows, count: rows.length };
        });
    };
}
function createGetFinancialGoalsHandler(config) {
    return async (_input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            const { rows } = await pool.query(`SELECT id, user_id, goal_type, description,
                target_age, target_amount, priority, status, created_at
         FROM financial_goals
         WHERE status = 'active'
         ORDER BY priority DESC`);
            return { goals: rows, count: rows.length };
        });
    };
}
function createGetInvestmentPreferencesHandler(config) {
    return async (_input, _ctx) => {
        return withPool(config.databaseUrl, async (pool) => {
            const { rows } = await pool.query(`SELECT id, user_id, risk_tolerance, liquidity_preference,
                time_horizon, preferred_asset_classes,
                avoided_asset_classes, notes, created_at
         FROM investment_preferences
         ORDER BY id LIMIT 1`);
            if (rows.length === 0)
                return { error: 'No investment preferences found' };
            return { preferences: rows[0] };
        });
    };
}
// ─── Tool Registration ──────────────────────────────────────────────────────
export function registerDemographicsTools(registry, config) {
    // No sync tool for demographics — data is managed through the UI
    const handler = {
        userProfile: createGetUserProfileHandler(config),
        household: createGetHouseholdHandler(config),
        financialGoals: createGetFinancialGoalsHandler(config),
        investmentPreferences: createGetInvestmentPreferencesHandler(config),
    };
    registry.register('get_user_profile', {
        name: 'get_user_profile',
        description: "Get the primary user's demographic profile including name, date of birth, calculated age, " +
            'gender, state of residence, education, employment status, filing status, and estimated annual income.',
        parameters: { type: 'object', properties: {}, required: [] },
        alwaysEnabled: true,
        async execute() {
            return handler.userProfile({}, null);
        },
    });
    registry.register('get_household', {
        name: 'get_household',
        description: 'Get all household members including spouse and children with their names, ' +
            'ages, relationships, and dates of birth.',
        parameters: { type: 'object', properties: {}, required: [] },
        alwaysEnabled: true,
        async execute() {
            return handler.household({}, null);
        },
    });
    registry.register('get_financial_goals', {
        name: 'get_financial_goals',
        description: 'Get all active financial goals including retirement targets, education funding plans (529s), ' +
            'savings goals, and their priorities, target ages, and target amounts.',
        parameters: { type: 'object', properties: {}, required: [] },
        alwaysEnabled: true,
        async execute() {
            return handler.financialGoals({}, null);
        },
    });
    registry.register('get_investment_preferences', {
        name: 'get_investment_preferences',
        description: 'Get investment preferences including risk tolerance, liquidity preference, time horizon, ' +
            'preferred asset classes, avoided asset classes, and notes.',
        parameters: { type: 'object', properties: {}, required: [] },
        alwaysEnabled: true,
        async execute() {
            return handler.investmentPreferences({}, null);
        },
    });
    console.log('[demographics] Registered 4 domain tools: get_user_profile, get_household, get_financial_goals, get_investment_preferences');
}
// ─── Capability Registration ────────────────────────────────────────────────
export function registerDemographicsCapabilities(registry, config) {
    // 1. User profile
    registry.register({
        name: 'demographics.getUserProfile',
        description: "Get the primary user's demographic profile including age, employment, filing status, and income estimate",
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
            type: 'object',
            properties: {
                profile: {
                    type: 'object',
                    description: 'User profile with display_name, date_of_birth, age_years, gender, state_of_residence, filing_status, education, employment_status, annual_income_estimate',
                },
            },
        },
        handler: createGetUserProfileHandler(config),
    });
    // 2. Household members
    registry.register({
        name: 'demographics.getHousehold',
        description: 'Get all household members including spouse and children with ages and relationships',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
            type: 'object',
            properties: {
                members: { type: 'array', description: 'Household members with name, relationship, date_of_birth, age_years' },
                count: { type: 'number' },
            },
        },
        handler: createGetHouseholdHandler(config),
    });
    // 3. Financial goals
    registry.register({
        name: 'demographics.getFinancialGoals',
        description: 'Get active financial goals including retirement targets, education 529 plans, and priorities',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
            type: 'object',
            properties: {
                goals: { type: 'array', description: 'Financial goals with goal_type, description, target_age, target_amount, priority, status' },
                count: { type: 'number' },
            },
        },
        handler: createGetFinancialGoalsHandler(config),
    });
    // 4. Investment preferences
    registry.register({
        name: 'demographics.getInvestmentPreferences',
        description: 'Get investment preferences including risk tolerance, liquidity preference, time horizon, and asset class preferences/exclusions',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
            type: 'object',
            properties: {
                preferences: {
                    type: 'object',
                    description: 'Investment preferences with risk_tolerance, liquidity_preference, time_horizon, preferred_asset_classes, avoided_asset_classes',
                },
            },
        },
        handler: createGetInvestmentPreferencesHandler(config),
    });
    console.log('[demographics] Registered 4 capabilities: demographics.getUserProfile, demographics.getHousehold, demographics.getFinancialGoals, demographics.getInvestmentPreferences');
}
//# sourceMappingURL=demographics.js.map