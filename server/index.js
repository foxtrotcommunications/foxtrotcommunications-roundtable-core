// server/index.js — Roundtable server entry point (workspace-per-container)

// Sentry error tracking — set SENTRY_DSN env var to enable
let Sentry = null;
if (process.env.SENTRY_DSN) {
  Sentry = require('@sentry/node');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1, // 10% of transactions for performance monitoring
    release: `roundtable@${require('../package.json').version || '1.0.0'}`,
  });
  console.log('[Sentry] Error tracking enabled');
}

const express = require('express');
const http = require('http');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { initAdapter, getAdapter, isPostgres } = require('./db/adapter');
const { setupSockets } = require('./sockets');

const authRoutes = require('./routes/auth');
const fileRoutes = require('./routes/fileRoutes');
const bridgeReceive = require('./routes/bridgeReceive');
const insightRoutes = require('./routes/insightRoutes');
const { requireAuth } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);

// Trust proxy (required behind Cloud Run, GKE Ingress, or any LB)
app.set('trust proxy', 1);

// Security headers
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io", "https://cdnjs.cloudflare.com"],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com"],
  connectSrc: ["'self'", "ws:", "wss:"],
  imgSrc: ["'self'", "data:", "https:"],
  upgradeInsecureRequests: null,  // disable — not all deployments have TLS
};
if (config.embedMode) {
  // Allow iframing from any parent when embed mode is enabled
  cspDirectives.frameAncestors = ["*"];
}
app.use(helmet({
  contentSecurityPolicy: { directives: cspDirectives },
  hsts: false,                       // disable — only enable behind a real TLS terminator
  crossOriginEmbedderPolicy: false,  // Required for Socket.IO
}));


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enforce SESSION_SECRET in production
const isProd = process.env.NODE_ENV === 'production';
if (isProd && (!config.sessionSecret || config.sessionSecret === 'roundtable-dev-secret-change-me')) {
  console.error('[FATAL] SESSION_SECRET must be set to a secure value in production');
  process.exit(1);
}

// Session store: PostgreSQL when DATABASE_URL is set, in-memory for local dev
let sessionStore;
if (isPostgres()) {
  const pgSession = require('connect-pg-simple')(session);
  const { Pool } = require('pg');
  const sessionPool = new Pool({ connectionString: config.databaseUrl });
  sessionStore = new pgSession({
    pool: sessionPool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
    ttl: 7 * 24 * 60 * 60,       // 7 days in seconds
    pruneSessionInterval: 60 * 60, // prune expired rows every hour
  });
} else {
  console.log('[Session] Using in-memory session store (dev mode — sessions lost on restart)');
}

const sessionMiddleware = session({
  store: sessionStore,              // undefined = express-session MemoryStore
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: config.embedMode ? 'none' : 'lax',
    secure: config.embedMode || (isProd && process.env.SECURE_COOKIES === 'true'),
  },
});
app.use(sessionMiddleware);

if (config.embedMode) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.removeHeader('X-Frame-Options');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });
}

// Health check (unauthenticated — used by k8s probes and load balancers)
app.get('/api/health', async (req, res) => {
  try {
    const db = getAdapter();
    res.json({ status: 'ok', workspace: config.workspaceId, uptime: Math.floor(process.uptime()) });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// React SPA — serve from client/dist if available
const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
const fs = require('fs');
const reactIndexPath = path.join(clientDistPath, 'index.html');
const hasReactBuild = fs.existsSync(reactIndexPath);
if (hasReactBuild) {
  console.log('[Server] React client build found at client/dist/');
}

// SPA routes MUST come before express.static to override public/index.html
app.get('/', (req, res, next) => {
  if (hasReactBuild) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(reactIndexPath);
  }
  next();
});

app.get('/app', (req, res) => {
  if (hasReactBuild) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(reactIndexPath);
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

// React client static assets (JS/CSS bundles)
if (hasReactBuild) {
  app.use(express.static(clientDistPath, {
    maxAge: '7d', // Vite hashes filenames — safe to cache long-term
    setHeaders(res, filePath) {
      // HTML entry point must always be revalidated
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));
}

// Versioned static assets — long cache (CSS/JS have ?vN busters)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 5,               // 5 attempts per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a minute.' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,               // 3 registrations per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created. Please try again later.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,             // 100 general API requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please slow down.' },
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', registerLimiter);
app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/bridge', bridgeReceive);  // HMAC-authed, no user session needed
app.use('/api', requireAuth, fileRoutes);
app.use('/api/insights', requireAuth, insightRoutes);

// Workspace info
app.get('/api/workspace/info', requireAuth, async (req, res) => {
  try {
    const db = getAdapter();
    const ws = await db.getWorkspace(config.workspaceId);
    res.json(ws || { id: config.workspaceId, name: config.workspaceName, status: 'active' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bridge connections for this workspace (read from RT_BRIDGES env var)
app.get('/api/workspace/bridges', requireAuth, (req, res) => {
  try {
    const manifest = process.env.RT_BRIDGES;
    if (!manifest) return res.json([]);
    const bridges = JSON.parse(manifest);
    res.json(bridges);
  } catch {
    res.json([]);
  }
});

// Update workspace settings
app.patch('/api/workspace/info', requireAuth, async (req, res) => {
  try {
    const db = getAdapter();
    const updated = await db.updateWorkspace(config.workspaceId, req.body);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Usage Tracking API ──────────────────────────────────

// Usage summary for the workspace (default: last 30 days)
app.get('/api/workspace/usage', requireAuth, async (req, res) => {
  try {
    const db = getAdapter();
    const days = parseInt(req.query.days, 10) || 30;
    const summary = await db.getUsageSummary(config.workspaceId, days);
    const byUser = await db.getUsageByUser(config.workspaceId, days);
    const byModel = await db.getUsageByModel(config.workspaceId, days);
    res.json({ period: `${days} days`, summary, byUser, byModel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    const db = getAdapter();
    const options = { limit: parseInt(req.query.limit, 10) || 50 };
    if (req.query.before) options.before = parseInt(req.query.before, 10);
    res.json(await db.getMessages(config.workspaceId, options));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cross-workspace: list all workspaces
app.get('/api/workspaces', requireAuth, async (req, res) => {
  try {
    const db = getAdapter();
    res.json(await db.getActiveWorkspaces());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cross-workspace: read another workspace's messages
// DISABLED — no authorization check exists to verify the requesting user
// has access to the target workspace. Re-enable once workspace membership
// verification is implemented.
// app.get('/api/workspaces/:id/messages', requireAuth, async (req, res) => { ... });

// Cross-workspace: receive a message from another workspace (webhook)
// Requires HMAC signature verification (same pattern as bridge receive)
app.post('/api/webhook/message', express.json(), async (req, res) => {
  try {
    const { sourceWorkspaceId, content, timestamp, signature } = req.body;
    if (!sourceWorkspaceId || !content) return res.status(400).json({ error: 'sourceWorkspaceId and content required' });

    // Verify HMAC signature
    const secret = config.sessionSecret;
    if (!signature || !timestamp) {
      return res.status(401).json({ error: 'Missing webhook signature' });
    }
    const crypto = require('crypto');
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${sourceWorkspaceId}:${timestamp}`)
      .digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    // Check timestamp freshness (5 min window)
    if (Math.abs(Date.now() - parseInt(timestamp)) > 5 * 60 * 1000) {
      return res.status(401).json({ error: 'Webhook timestamp expired' });
    }

    const db = getAdapter();
    const msg = await db.saveMessage(config.workspaceId, null, 'user', content, null, null, sourceWorkspaceId);
    // Broadcast to connected users via Socket.IO
    if (global._io) {
      global._io.to(`ws:${config.workspaceId}`).emit('new-message', { ...msg, crossWorkspace: true, sourceWorkspace: sourceWorkspaceId });
    }
    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API key routes
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



// Heartbeat interval
let heartbeatInterval;

async function start() {
  // Retry DB init — Cloud SQL proxy sidecar may take 15-20s to be ready
  const maxRetries = 10;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await initAdapter();
      break;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.log(`[DB] Connection failed (attempt ${attempt}/${maxRetries}): ${err.code || err.message}. Retrying in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Register this workspace in the shared DB
  const db = getAdapter();
  await db.registerWorkspace(config.workspaceId, config.workspaceName, config.workspaceUrl, null);

  const io = setupSockets(server, sessionMiddleware);
  global._io = io; // For webhook broadcasting

  // Heartbeat every 60s
  heartbeatInterval = setInterval(async () => {
    try { await db.updateWorkspaceHeartbeat(config.workspaceId); } catch (_) {}
  }, 60000);

  server.listen(config.port, () => {
    console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║                                                   ║
  ║   🎙️  Roundtable is live!                         ║
  ║                                                   ║
  ║   Local:  http://localhost:${config.port}                ║
  ║   Workspace: ${config.workspaceId.padEnd(36)}║
  ║   DB:     ${(isPostgres() ? 'PostgreSQL' : 'SQLite (dev)').padEnd(38)}║
  ║                                                   ║
  ╚═══════════════════════════════════════════════════╝
    `);
  });
}

start().catch((err) => { console.error('Failed to start:', err); process.exit(1); });

// ─── Global Error Handling ────────────────────────────────

// Sentry error handler (must be before other error handlers)
if (Sentry) {
  app.use(Sentry.expressErrorHandler());
}

// Express error-handling middleware (must be after all routes)
app.use((err, req, res, _next) => {
  console.error('[Express] Unhandled error:', err.stack || err);
  res.status(err.status || 500).json({ error: 'Internal server error' });
});

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Catch uncaught exceptions — log and exit cleanly
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
  shutdown('uncaughtException').catch(() => process.exit(1));
});

// Graceful shutdown
async function shutdown(signal) {
  console.log(`\n[Server] ${signal} received, shutting down...`);
  try {
    clearInterval(heartbeatInterval);
    const db = getAdapter();
    await db.updateWorkspaceStatus(config.workspaceId, 'stopped');
    if (typeof db.close === 'function') await db.close();
  } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.once('SIGUSR2', () => {
  shutdown('SIGUSR2').then(() => process.kill(process.pid, 'SIGUSR2'));
});

module.exports = app;
