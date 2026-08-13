// server/pooled/arthur.js — pooled Arthur entrypoint.
//
// ONE always-warm chat service for every pooled household. The tenant binds
// at the socket/session (SSO claim or tenant-bound s2s HMAC) and rides every
// downstream call; per-household Arthur pods disappear.
//
// Deliberately absent relative to server/index.js (rationale per mount in
// pendragon/docs/pooled-arthur-plan.md §Q6): admin/reset (cross-tenant wipe
// primitive), fileRoutes (shared workspace/ tree), /api/tools/execute (no
// tenant in its signature, no live caller), MCP routes + dynamic tools
// (cross-tenant leakage class), /api/downloads (unauthenticated global
// store), /api/workspaces listing (cross-tenant disclosure), /api/webhook/
// message (tenant-less signature), domain S2S plugin routes (domain
// services own those), and every boot write (registerWorkspace, prompt
// seed, AI-settings sync — the registry owns rows) plus the per-pod
// heartbeat (per-tenant activity touches replace it).

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const config = require('../config');
const { initAdapter, getAdapter, isPostgres } = require('../db/adapter');
const { requireAuth } = require('../middleware/auth');
const { credentialCacheStats } = require('../tenantCredentials');

if (!config.pooledArthur) {
  console.error('[pooled-arthur] POOLED_ARTHUR is not set — this entrypoint only runs pooled Arthur.');
  process.exit(1);
}
if (!config.databaseUrl) {
  console.error('[pooled-arthur] DATABASE_URL is not set — must be the pooled NOBYPASSRLS service role.');
  process.exit(1);
}
if (!process.env.SSO_JWT_SECRET) {
  console.error('[pooled-arthur] SSO_JWT_SECRET is not set — pooled Arthur has no other login path.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1);

// Security headers — same CSP as the dedicated pod, no embed branch.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc: ["'self'", "data:", "https:"],
      frameSrc: ["'self'", "blob:", "data:"],
      upgradeInsecureRequests: null,
    },
  },
  hsts: false,
  crossOriginEmbedderPolicy: false, // Socket.IO
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Sessions (global table; tenant lives INSIDE the session record) ────────
let sessionStore;
if (isPostgres()) {
  const pgSession = require('connect-pg-simple')(session);
  const { Pool } = require('pg');
  const sessionPool = new Pool({
    connectionString: config.databaseUrl,
    max: 2,
    idleTimeoutMillis: 60_000,
  });
  sessionStore = new pgSession({
    pool: sessionPool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
    ttl: config.sessionIdleMinutes * 60,
    pruneSessionInterval: 60 * 60,
  });
}
const sessionMiddleware = session({
  store: sessionStore,
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: config.sessionIdleMinutes * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.SECURE_COOKIES !== 'false',
  },
});
app.use(sessionMiddleware);

// ─── Health ─────────────────────────────────────────────────────────────────
const bootedAt = Date.now();
let dbReady = false;
app.get('/api/health', (_req, res) => {
  if (!dbReady) return res.status(503).json({ status: 'starting', mode: 'pooled-arthur' });
  const { getLastActivityAt } = require('../sockets/workspaceHandler');
  res.json({
    status: 'ok',
    mode: 'pooled-arthur',
    version: require('../../package.json').version || '1.0.0',
    uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
    credentialCache: credentialCacheStats(),
    lastActivityAt: getLastActivityAt() || null,
  });
});

// ─── Rate limiters ──────────────────────────────────────────────────────────
app.use('/api/auth/login', rateLimit({
  windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a minute.' },
}));
app.use('/api', rateLimit({
  windowMs: 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please slow down.' },
}));

// ─── Auth (SSO binds session.workspaceId; password/demo are 403 pooled) ─────
app.use('/api/auth', require('../routes/auth'));

// ─── Bridge receive (tenant-bound HMAC; watch results, delegations) ─────────
app.use('/api/bridge', require('../routes/bridgeReceive'));

// ─── A2A (chat ingress + planning; tenant per request) ──────────────────────
app.use('/', require('../routes/a2a'));

// ─── Tenant-scoped session middleware ───────────────────────────────────────
// requireAuth + the session must carry a workspace binding: a pooled session
// without a claim has no tenant and can read NOTHING.
function requireTenantSession(req, res, next) {
  requireAuth(req, res, () => {
    const wsId = req.session?.workspaceId;
    if (typeof wsId !== 'string' || !wsId.trim()) {
      return res.status(403).json({ error: 'Session has no workspace binding — sign in via SSO' });
    }
    req.rtSessionWsId = wsId;
    next();
  });
}

// ─── Frontend surface, tenant-scoped ────────────────────────────────────────
app.get('/api/workspace/info', requireTenantSession, async (req, res) => {
  try {
    const ws = await getAdapter().getWorkspace(req.rtSessionWsId);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    res.json({ ...ws, version: require('../../package.json').version || '1.0.0' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspace/bridges', requireTenantSession, async (req, res) => {
  try {
    const { fetchManifest } = require('../utils/fetchManifest');
    const manifestData = await fetchManifest(req.rtSessionWsId);
    res.json(manifestData.RT_BRIDGES || []);
  } catch {
    res.json([]);
  }
});

app.patch('/api/workspace/info', requireTenantSession, async (req, res) => {
  try {
    const db = getAdapter();
    if (req.body.aiProvider) {
      const ws = await db.getWorkspace(req.rtSessionWsId);
      if (ws?.allowed_providers) {
        try {
          const allowed = JSON.parse(ws.allowed_providers);
          if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(req.body.aiProvider)) {
            return res.status(403).json({ error: `Provider "${req.body.aiProvider}" is restricted. Allowed: ${allowed.join(', ')}` });
          }
        } catch { /* invalid JSON = unrestricted */ }
      }
    }
    const updated = await db.updateWorkspace(req.rtSessionWsId, req.body);
    db.audit(req.rtSessionWsId, req.session.userId, req.session.username, 'settings_change', 'workspace_update', {
      fields: Object.keys(req.body),
    }, req.ip).catch(() => {});
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspace/audit', requireTenantSession, async (req, res) => {
  try {
    const result = await getAdapter().getAuditLog(req.rtSessionWsId, {
      limit: parseInt(req.query.limit, 10) || 100,
      eventType: req.query.eventType || undefined,
      before: parseInt(req.query.before, 10) || undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspace/usage', requireTenantSession, async (req, res) => {
  try {
    const db = getAdapter();
    const days = parseInt(req.query.days, 10) || 30;
    const summary = await db.getUsageSummary(req.rtSessionWsId, days);
    const byUser = await db.getUsageByUser(req.rtSessionWsId, days);
    const byModel = await db.getUsageByModel(req.rtSessionWsId, days);
    res.json({ period: `${days} days`, summary, byUser, byModel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages', requireTenantSession, async (req, res) => {
  try {
    const options = { limit: parseInt(req.query.limit, 10) || 50 };
    if (req.query.before) options.before = parseInt(req.query.before, 10);
    res.json(await getAdapter().getMessages(req.rtSessionWsId, options));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API keys are per-user (global table) — session auth only.
app.get('/api/keys', requireAuth, async (req, res) => {
  res.json(await getAdapter().getApiKeys(req.session.userId));
});
app.post('/api/keys', requireAuth, async (req, res) => {
  const { provider, apiKey } = req.body;
  if (!provider || !apiKey) return res.status(400).json({ error: 'Provider and API key are required' });
  await getAdapter().saveApiKey(req.session.userId, provider, apiKey);
  res.json({ success: true });
});
app.delete('/api/keys/:id', requireAuth, async (req, res) => {
  await getAdapter().deleteApiKey(parseInt(req.params.id), req.session.userId);
  res.json({ success: true });
});

// ─── SPA (one UI; tenant comes from the session, never the URL) ─────────────
const clientDistPath = path.join(__dirname, '..', '..', 'client', 'dist');
const reactIndexPath = path.join(clientDistPath, 'index.html');
const hasReactBuild = fs.existsSync(reactIndexPath);
if (hasReactBuild) {
  app.use(express.static(clientDistPath, {
    maxAge: '7d',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
}
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/') ||
      req.path.startsWith('/.well-known/') || req.path === '/a2a') {
    return next();
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (hasReactBuild) return res.sendFile(reactIndexPath);
  res.status(503).send('Client build missing');
});

// ─── Boot ───────────────────────────────────────────────────────────────────
async function start() {
  // Listen first, dial the database second — health answers 'starting' until
  // the chain completes (same doctrine as the dedicated pod).
  const { setupSockets } = require('../sockets');
  const io = setupSockets(server, sessionMiddleware);
  global._io = io;
  server.listen(config.port, () => {
    console.log(`[pooled-arthur] listening on :${config.port} (tenants per request)`);
  });

  const maxRetries = 40;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await initAdapter();
      break;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delayMs = Math.min(250 * 2 ** (attempt - 1), 3000);
      console.log(`[pooled-arthur:DB] Connection failed (attempt ${attempt}/${maxRetries}): ${err.code || err.message}. Retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  dbReady = true;
  console.log('[pooled-arthur] ready — adapter tenant-pinned, no boot writes, no heartbeat');
}

const shutdown = async (signal) => {
  console.log(`[pooled-arthur] ${signal} — shutting down`);
  server.close();
  try { await getAdapter().close?.(); } catch { /* already closed */ }
  try {
    const { endAllPools } = require('@pendragon/tools-plaid/src/db/pool.js');
    await endAllPools();
  } catch { /* plugin absent — pools die with the process */ }
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('[pooled-arthur] Fatal boot error:', err);
  process.exit(1);
});
