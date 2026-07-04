// routes/demographics-seed.js — Seed demographics data from Pendragon onboarding
// POST /api/demographics/seed { profile, household }
// Inserts user_profile + household_members rows.
// Idempotent — clears existing data before insert.

const { Router } = require('express');
const { getAdapter } = require('../../../../server/db/adapter');

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { profile, household } = req.body;
    if (!profile?.displayName) {
      return res.status(400).json({ error: 'profile.displayName is required' });
    }

    const adapter = getAdapter();
    const pool = adapter.pool || adapter.db;
    if (!pool) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    // Clear existing data (idempotent)
    await pool.query('DELETE FROM household_members');
    await pool.query('DELETE FROM investment_preferences');
    await pool.query('DELETE FROM user_profile');

    // Insert user profile
    const profileResult = await pool.query(
      `INSERT INTO user_profile (workspace_id, display_name, date_of_birth, state_of_residence, filing_status, employment_status)
       VALUES (CURRENT_USER, $1, $2, $3, $4, $5)
       RETURNING id`,
      [
        profile.displayName,
        profile.dateOfBirth || null,
        profile.stateOfResidence || null,
        profile.filingStatus || null,
        profile.employmentStatus || null,
      ],
    );
    const userId = profileResult.rows[0].id;

    // Insert household members
    let memberCount = 0;
    if (Array.isArray(household)) {
      for (const member of household) {
        await pool.query(
          `INSERT INTO household_members (workspace_id, user_id, relationship, name, age_years)
           VALUES (CURRENT_USER, $1, $2, $3, $4)`,
          [
            userId,
            member.relationship || 'other',
            member.name || null,
            member.age || null,
          ],
        );
        memberCount++;
      }
    }

    console.log(`[demographics-seed] Seeded profile (id=${userId}) + ${memberCount} household members`);
    res.json({ success: true, profileId: userId, householdMembers: memberCount });
  } catch (err) {
    console.error('[demographics-seed] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { default: router };
