// server/routes/auth.js — Authentication routes
const express = require('express');
const bcrypt = require('bcryptjs');
const { getAdapter } = require('../db/adapter');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    if (username.length < 3 || username.length > 30) return res.status(400).json({ error: 'Username must be 3-30 characters' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const db = getAdapter();
    const existing = await db.getUserByUsername(username.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 12);
    const user = await db.createUser(username.toLowerCase(), displayName || username, hash);

    req.session.userId = user.id;
    req.session.username = user.username;
    res.status(201).json({ id: user.id, username: user.username, displayName: user.display_name });
  } catch (err) {
    console.error('[Auth] Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    const db = getAdapter();
    const user = await db.getUserByUsername(username.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ id: user.id, username: user.username, displayName: user.display_name });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Failed to logout' });
    res.json({ success: true });
  });
});

router.get('/me', requireAuth, async (req, res) => {
  const db = getAdapter();
  const user = await db.getUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, displayName: user.display_name });
});

module.exports = router;
