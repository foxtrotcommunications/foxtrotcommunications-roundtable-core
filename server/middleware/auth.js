// server/middleware/auth.js — Session authentication middleware
const config = require('../config');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }

  // In embed mode, auto-create a stateless guest identity so iframes work
  // even when third-party cookies are blocked (e.g. Chrome incognito).
  if (config.embedMode) {
    const crypto = require('crypto');
    const adjectives = ['swift', 'bright', 'calm', 'bold', 'keen', 'warm', 'wise', 'fair', 'kind', 'glad'];
    const animals = ['fox', 'owl', 'elk', 'jay', 'bee', 'ant', 'ram', 'cod', 'emu', 'yak'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    const suffix = crypto.randomBytes(2).toString('hex');
    const guestName = `${adj}-${animal}-${suffix}`;

    // Attach guest identity to the request (not saved to session/DB)
    req.session.userId = -1;
    req.session.username = guestName;
    req.guestUser = { id: -1, username: guestName, displayName: guestName };
    return next();
  }

  return res.status(401).json({ error: 'Authentication required' });
}

module.exports = { requireAuth };
