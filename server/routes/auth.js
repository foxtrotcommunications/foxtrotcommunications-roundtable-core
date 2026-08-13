// server/routes/auth.js — Authentication routes
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getAdapter } = require('../db/adapter');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');


const router = express.Router();

router.post('/register', async (req, res) => {
  // Pooled Arthur: sessions must carry a workspace binding minted by the
  // control plane's SSO token — password/demo auth has no workspace claim.
  if (config.pooledArthur) {
    return res.status(403).json({ error: 'SSO required' });
  }
  // Registration is disabled by default — set ALLOW_REGISTRATION=true to enable
  if (process.env.ALLOW_REGISTRATION !== 'true') {
    return res.status(403).json({ error: 'Registration is currently closed. Use the demo account to try Roundtable.' });
  }
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
  if (config.pooledArthur) {
    return res.status(403).json({ error: 'SSO required' });
  }
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    const db = getAdapter();
    const user = await db.getUserByUsername(username.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      // Audit: failed login
      db.audit(config.workspaceId, null, username.toLowerCase(), 'auth_failure', 'login', {
        reason: 'invalid_password',
      }, req.ip).catch(() => {});
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    // Audit: successful login
    db.audit(config.workspaceId, user.id, user.username, 'auth_login', 'login', {}, req.ip).catch(() => {});
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

// ── Demo auto-login: assign random guest identity, no credentials needed ──
const ADJECTIVES = ['brave','swift','clever','bright','bold','calm','keen','wise','warm','vivid'];
const NOUNS = ['falcon','otter','panda','tiger','whale','raven','fox','lynx','wolf','bear'];

function randomGuestName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const tag = crypto.randomBytes(2).toString('hex');
  return `${adj}-${noun}-${tag}`;
}

router.post('/demo', async (req, res) => {
  if (config.pooledArthur) {
    return res.status(403).json({ error: 'SSO required' });
  }
  if (process.env.DEMO_MODE !== 'true') {
    return res.status(403).json({ error: 'Demo mode is not enabled' });
  }

  try {
    const guestName = randomGuestName();
    const dummyHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
    const db = getAdapter();
    const user = await db.createUser(guestName, guestName, dummyHash);

    req.session.userId = user.id;
    req.session.username = user.username;
    res.status(201).json({ id: user.id, username: user.username, displayName: user.display_name });
  } catch (err) {
    console.error('[Auth] Demo login error:', err);
    res.status(500).json({ error: 'Failed to create demo session' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  // In embed mode, guest users have id=-1 and aren't in the DB
  if (req.guestUser) {
    return res.json(req.guestUser);
  }
  const db = getAdapter();
  const user = await db.getUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, displayName: user.display_name });
});

/**
 * GET /api/auth/sso?token=<jwt>
 *
 * Single sign-on endpoint. Validates a short-lived JWT issued by the
 * Roundtable control plane, upserts the user locally, sets a session,
 * and redirects to the workspace root.
 *
 * JWT payload: { sub, email, name, workspace_id, workspace_role, org_id, exp }
 * Signature: HMAC-SHA256 using SSO_JWT_SECRET (falls back to SESSION_SECRET)
 */
router.get('/sso', async (req, res) => {
  try {
    const { token, redirect = '/' } = req.query;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const secret = config.ssoJwtSecret;
    if (!secret) return res.status(500).json({ error: 'SSO not configured' });

    // Decode the JWT (header.payload.signature — all base64url)
    const parts = token.split('.');
    if (parts.length !== 3) return res.status(400).json({ error: 'Invalid token format' });

    const [headerB64, payloadB64, sigB64] = parts;

    // Verify signature: HMAC-SHA256(header.payload, secret)
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    if (!crypto.timingSafeEqual(Buffer.from(sigB64), Buffer.from(expectedSig))) {
      return res.status(401).json({ error: 'Invalid token signature' });
    }

    // Decode payload
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

    // Check expiry
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      return res.status(401).json({ error: 'Token expired' });
    }

    if (config.pooledArthur) {
      // Pooled Arthur: ONE service serves many workspaces, so the claim IS the
      // tenant binding. Fail closed: the claim must be present and must name a
      // workspace this service actually knows (registry-owned row) — an
      // unknown or absent claim never falls back to a default workspace.
      const claim = payload.workspace_id;
      if (!claim || typeof claim !== 'string') {
        return res.status(403).json({ error: 'Token missing workspace claim' });
      }
      const claimedWorkspace = await getAdapter().getWorkspace(claim);
      if (!claimedWorkspace) {
        console.warn(`[Auth] SSO workspace claim '${claim}' has no workspace row — rejecting`);
        return res.status(403).json({ error: 'Token not valid for this workspace' });
      }
    } else if (payload.workspace_id !== config.workspaceId) {
      // Bind the token to THIS workspace. The control plane mints a distinct token
      // per workspace (payload.workspace_id) after checking the user's access to
      // that workspace. Without this check, a token minted for one workspace would
      // be accepted by any other pod sharing the SSO secret — a cross-workspace
      // privilege boundary bypass. Fail closed: reject if the claim is missing or
      // does not match our own workspace id.
      console.warn(
        `[Auth] SSO workspace mismatch: token for '${payload.workspace_id}' presented to '${config.workspaceId}'`
      );
      return res.status(403).json({ error: 'Token not valid for this workspace' });
    }

    const { sub: ssoId, email: rawEmail, name: displayName } = payload;
    if (!ssoId) return res.status(400).json({ error: 'Invalid token payload' });
    const email = rawEmail || `${ssoId}@sso`;

    // Upsert user and set session
    const db = getAdapter();
    const user = await db.upsertUserBySsoId(ssoId, email, displayName || email.split('@')[0]);

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.ssoRole = payload.workspace_role || 'viewer';
    // Pooled Arthur: the session carries its tenant — sockets and routes read
    // req.session.workspaceId instead of config.workspaceId.
    if (config.pooledArthur) {
      req.session.workspaceId = payload.workspace_id;
    }

    // Redirect to workspace
    const dest = redirect.startsWith('/') ? redirect : '/';
    res.redirect(dest);
  } catch (err) {
    console.error('[Auth] SSO error:', err);
    res.status(500).json({ error: 'SSO authentication failed' });
  }
});

module.exports = router;

