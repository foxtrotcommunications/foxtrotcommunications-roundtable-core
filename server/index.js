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
  frameSrc: ["'self'", "blob:", "data:"],
  upgradeInsecureRequests: null,  // disable — not all deployments have TLS
};
if (config.embedMode) {
  // Allow iframing only from specific parent origins — NEVER use wildcard in production
  const allowedOrigins = (process.env.EMBED_ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  if (allowedOrigins.length === 0) {
    console.warn('[SECURITY] EMBED_MODE is enabled but EMBED_ALLOWED_ORIGINS is not set. No sites can embed this workspace.');
    cspDirectives.frameAncestors = ["'none'"];
  } else {
    cspDirectives.frameAncestors = allowedOrigins;
  }
}
app.use(helmet({
  contentSecurityPolicy: { directives: cspDirectives },
  hsts: false,                       // disable — only enable behind a real TLS terminator
  crossOriginEmbedderPolicy: false,  // Required for Socket.IO
}));


// Raw body capture (SIGNING_SPEC.md): v2 S2S signatures hash the request
// body exactly as sent, so the parser keeps the bytes on req.rawBody. The
// urlencoded parser captures too — otherwise a non-JSON body would verify
// against the empty-body hash.
const captureRawBody = (req, _res, buf) => { req.rawBody = buf; };
app.use(express.json({ verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, verify: captureRawBody }));

// Enforce secrets in production
const isProd = process.env.NODE_ENV === 'production';
if (isProd && (!config.sessionSecret || config.sessionSecret === 'roundtable-dev-secret-change-me')) {
  console.error('[FATAL] SESSION_SECRET must be set to a secure value in production');
  process.exit(1);
}
if (isProd && !config.demoMode && !process.env.API_KEY_ENCRYPTION_KEY) {
  console.error('[FATAL] API_KEY_ENCRYPTION_KEY must be set in production (64-char hex string)');
  console.error('  Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
// Ensure purpose-specific secrets are not sharing the same value in production.
// Falling back to SESSION_SECRET collapses three distinct security domains
// (session signing, bridge HMAC, cross-workspace SSO) onto one key — a single
// leak would then break all three. Fail closed in production.
// (Demo-mode pods are exempt, matching the API_KEY_ENCRYPTION_KEY check above —
// they hold no real user data and must not brick on sandbox secret hygiene.)
if (isProd && !config.demoMode && config.bridgeHmacSecret === config.sessionSecret) {
  console.error('[FATAL] BRIDGE_HMAC_SECRET must be set to a value distinct from SESSION_SECRET in production.');
  console.error('  Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
if (isProd && !config.demoMode && config.ssoJwtSecret === config.sessionSecret) {
  console.error('[FATAL] SSO_JWT_SECRET must be set to a value distinct from SESSION_SECRET in production.');
  console.error('  Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// ─── HMAC Verification Middleware for Server-to-Server Endpoints ─────────────
// Protects /api/sync, /api/demographics/seed, and other S2S routes. Shared
// with the pooled entrypoints (server/middleware/requireHmac.js): v1
// `<path>:<timestamp>` while RT_HMAC_ACCEPT_V1 !== 'false', v2
// `v2:<path>:<ts>:<nonce>:<sha256(body)>` with X-Rt-Sig-V: 2 (SIGNING_SPEC.md).
const crypto = require('crypto');
const { requireHmac, verifyS2sRequest } = require('./middleware/requireHmac');

// Session store: PostgreSQL when DATABASE_URL is set, in-memory for local dev
let sessionStore;
if (isPostgres()) {
  const pgSession = require('connect-pg-simple')(session);
  const { Pool } = require('pg');
  const sessionPool = new Pool({
    connectionString: config.databaseUrl,
    max: 2,                   // sessions are low-throughput — 2 connections is plenty
    idleTimeoutMillis: 60_000,
  });
  sessionStore = new pgSession({
    pool: sessionPool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
    ttl: config.sessionIdleMinutes * 60,  // match cookie idle timeout
    pruneSessionInterval: 60 * 60, // prune expired rows every hour
  });
} else {
  console.log('[Session] Using in-memory session store (dev mode — sessions lost on restart)');
}

const sessionIdleMs = config.sessionIdleMinutes * 60 * 1000;
const sessionMiddleware = session({
  store: sessionStore,              // undefined = express-session MemoryStore
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,                    // Reset maxAge on every request (idle timeout)
  cookie: {
    maxAge: sessionIdleMs,          // idle timeout (default 30 min)
    httpOnly: true,
    sameSite: config.embedMode ? 'none' : 'lax',
    secure: config.embedMode || (isProd && process.env.SECURE_COOKIES !== 'false'),
  },
});
app.use(sessionMiddleware);

if (config.embedMode) {
  const allowedOrigins = (process.env.EMBED_ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.removeHeader('X-Frame-Options');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });
}

// Health check (unauthenticated — used by k8s probes and load balancers)
app.get('/api/health', async (req, res) => {
  // 503 until the background boot chain (DB dial → registration → syncs)
  // completes: the onboarding arthur-ready gate and the dashboard both need
  // "listening" and "ready to serve" to be different answers.
  if (!global._bootReady) {
    return res.status(503).json({ status: 'starting', workspace: config.workspaceId, uptime: Math.floor(process.uptime()) });
  }
  try {
    const db = getAdapter();
    const version = require('../package.json').version || '1.0.0';
    // Include live provider/model so the dashboard can show actual state
    const ws = await db.getWorkspace(config.workspaceId);
    // Report connected users and last activity so the dashboard idle checker
    // can avoid scaling down workspaces with active users
    const connectedUsers = global._io ? global._io.sockets.sockets.size : 0;
    const { getLastActivityAt } = require('./sockets/workspaceHandler');
    res.json({
      status: 'ok',
      workspace: config.workspaceId,
      version,
      provider: ws?.ai_provider || undefined,
      model: ws?.ai_model || undefined,
      uptime: Math.floor(process.uptime()),
      connectedUsers,
      lastActivityAt: getLastActivityAt(),
      // Manifest freshness (1.1): degraded=true means this pod is serving
      // ZERO contracts/bridges because the control plane has been
      // unreachable longer than RT_MANIFEST_STALE_MAX_MS.
      manifest: require('./utils/fetchManifest').manifestHealth(),
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// Demo reset endpoint — clears all messages (token-authenticated)
app.post('/api/admin/reset', async (req, res) => {
  const token = req.headers['x-reset-token'];
  const expected = process.env.RESET_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Reset not configured' });
  if (!token || token !== expected) return res.status(401).json({ error: 'Invalid reset token' });

  try {
    const db = getAdapter();
    await db.clearMessages(config.workspaceId);
    if (global._io) {
      global._io.to(`ws:${config.workspaceId}`).emit('workspace-reset');
    }
    console.log('[Admin] Workspace reset by token auth');
    res.json({ success: true, message: 'Workspace reset complete' });
  } catch (err) {
    console.error('[Admin] Reset error:', err);
    res.status(500).json({ error: 'Reset failed' });
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

// React client catch-all (for client-side routing)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/') ||
      req.path.startsWith('/.well-known/') || req.path === '/a2a') {
    return next();
  }
  
  // NEVER cache index.html
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (hasReactBuild) {
    res.sendFile(reactIndexPath);
  } else {
    res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
  }
});

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

// Plaid data-sync endpoint — HMAC-authenticated (server-to-server from Pendragon).
// The route lives entirely in the application plugin. Core's old fallback route
// (server/routes/sync.ts) was removed 2026-08-05: it only ran when the plugin
// was absent, yet required the plugin internally to do any actual syncing, so
// it could never succeed. Warn LOUDLY when the route can't mount — a Pendragon
// image without it breaks provisioning (do-not-regress).
try {
  const { syncRoute } = require('@pendragon/tools-plaid');
  if (syncRoute) {
    app.use('/api/sync', requireHmac('sync'), syncRoute);
  } else {
    console.warn('[boot] @pendragon/tools-plaid has no syncRoute export — /api/sync NOT mounted');
  }
} catch {
  console.warn('[boot] No application plugin installed — /api/sync not mounted');
}

// Demographics seed endpoint — HMAC-authenticated (server-to-server from Pendragon)
try {
  const { demographicsSeedRoute } = require('@pendragon/tools-plaid');
  app.use('/api/demographics/seed', requireHmac('demographics/seed'), demographicsSeedRoute);
} catch {
  const demographicsSeedRoute = require('./routes/demographics-seed').default;
  app.use('/api/demographics/seed', requireHmac('demographics/seed'), demographicsSeedRoute);
}

// Household-goal story cards — read-only, HMAC-authenticated (server-to-server
// from Pendragon). Writes stay on the capability layer; this is a window.
try {
  const { goalsRoute } = require('@pendragon/tools-plaid');
  if (goalsRoute) app.use('/api/goals', requireHmac('goals'), goalsRoute);
} catch { /* plugin absent or pre-goals version — no route */ }

// Canonical snapshot — read-only, HMAC-authenticated. Same fetch+compute as
// the snapshot.get capability, so HTTP and ICE can never disagree.
try {
  const { snapshotRoute } = require('@pendragon/tools-plaid');
  if (snapshotRoute) app.use('/api/snapshot', requireHmac('snapshot'), snapshotRoute);
} catch { /* plugin absent or pre-snapshot version — no route */ }

// Relationship memory — read-only digest + list, HMAC-authenticated.
// Writes stay on the capability layer (consent invariant, forget tombstones).
try {
  const { memoryRoute } = require('@pendragon/tools-plaid');
  if (memoryRoute) app.use('/api/memory', requireHmac('memory'), memoryRoute);
} catch { /* plugin absent or pre-memory version — no route */ }

// Consent-grant ledger (Pendragon 4.2) — the API mints a grant on the user's
// tap and records it here so the capability layer's assertGrant can consume
// it. Mounted at /api/consent on dedicated pods to match the pooled service
// (server/pooled/index.js); the plugin's legacy /api/memory/consent-grants
// path keeps working through memoryRoute above.
try {
  const { consentRoute } = require('@pendragon/tools-plaid');
  if (typeof consentRoute === 'function') app.use('/api/consent', requireHmac('consent'), consentRoute);
} catch { /* plugin absent or pre-consent version — no route */ }

// Merchant knowledge — read-only window for the Memory page's merchant tab.
try {
  const { correctionsRoute } = require('@pendragon/tools-plaid');
  if (correctionsRoute) app.use('/api/corrections', requireHmac('corrections'), correctionsRoute);
} catch { /* plugin absent or older version — no route */ }

// Arthur's audit log — typed activity feed per domain, read-only.
try {
  const { activityRoute } = require('@pendragon/tools-plaid');
  if (activityRoute) app.use('/api/activity', requireHmac('activity'), activityRoute);
} catch { /* plugin absent or older version — no route */ }

// Decision briefs — read-only window for the Decisions page.
try {
  const { briefsRoute } = require('@pendragon/tools-plaid');
  if (briefsRoute) app.use('/api/briefs', requireHmac('briefs'), briefsRoute);
} catch { /* plugin absent or older version — no route */ }

// Household roster — attribution backbone for two-voice households.
// GET list + the join-flow upsert (consent recorded web-side at accept).
try {
  const { membersRoute } = require('@pendragon/tools-plaid');
  if (membersRoute) app.use('/api/household-members', requireHmac('household-members'), membersRoute);
} catch { /* plugin absent or older version — no route */ }

// Data export — this workspace's slice of the household's downloadable data.
try {
  const { exportRoute } = require('@pendragon/tools-plaid');
  if (exportRoute) app.use('/api/export', requireHmac('export'), exportRoute);
} catch { /* plugin absent or older version — no route */ }

// Watches — read-only window for the watch surface and the digest scheduler.
try {
  const { watchesRoute } = require('@pendragon/tools-plaid');
  if (watchesRoute) app.use('/api/watches', requireHmac('watches'), watchesRoute);
} catch { /* plugin absent or older version — no route */ }

// CSV import — parse/dedup/commit on the transaction domain that owns the
// ledger. HMAC-authenticated; the Pendragon API proxies file text and confirmed
// rows here (the raw file is discarded in the API tier — parse-and-discard).
try {
  const { importRoute } = require('@pendragon/tools-plaid');
  if (importRoute) app.use('/api/import', requireHmac('import'), importRoute);
} catch { /* plugin absent or older version — no route */ }

app.use('/api', requireAuth, fileRoutes);
app.use('/api/insights', requireAuth, insightRoutes);

// ─── Tool Execution API ────────────────────────────────────
// Allows control plane to invoke tools programmatically (e.g. financial_plan proxy).
// Authenticated via HMAC signature (same shared secret as bridge calls) — NOT
// session-based, since the control plane makes server-to-server requests.
app.post('/api/tools/execute', async (req, res) => {
  try {
    // ── Verify HMAC signature from control plane ──
    const signature = req.headers['x-control-plane-signature'];
    const timestamp = req.headers['x-control-plane-timestamp'];

    if (!signature || !timestamp) {
      return res.status(401).json({ error: 'Missing control-plane signature' });
    }

    const { tool, args } = req.body;
    const sigV = req.headers['x-rt-sig-v'];
    if (sigV !== undefined) {
      // v2 (SIGNING_SPEC.md): routePath 'tools/execute'; the body hash covers
      // tool AND args, which v1 never signed.
      const v = await verifyS2sRequest(req, 'tools/execute');
      if (!v.ok) return res.status(v.status || 401).json({ error: v.error });
    } else {
      // v1 (legacy, RT_HMAC_ACCEPT_V1): `tools/execute:<ts>:<tool>` — the
      // tool name is bound but the args are not.
      const { acceptV1, logV1Accepted } = require('./utils/s2sSig');
      if (!acceptV1()) return res.status(401).json({ error: 'HMAC v1 no longer accepted' });

      // Reject stale requests (5 min window)
      if (Math.abs(Date.now() - parseInt(timestamp)) > 5 * 60 * 1000) {
        return res.status(401).json({ error: 'Control-plane timestamp expired' });
      }

      const secret = config.bridgeHmacSecret;
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(`tools/execute:${timestamp}:${tool || ''}`)
        .digest('hex');

      try {
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
          return res.status(401).json({ error: 'Invalid control-plane signature' });
        }
      } catch {
        return res.status(401).json({ error: 'Invalid control-plane signature' });
      }
      logV1Accepted('tools/execute');
    }

    // ── Execute the tool ──
    if (!tool) return res.status(400).json({ error: 'tool name required' });

    const { executeTool } = require('./tools');
    const db = getAdapter();
    const ws = await db.getWorkspace(config.workspaceId);

    // Control-plane calls run under the workspace's own enabled_tools — the
    // CP's HMAC proves who is asking, not that the tool is enabled here.
    let enabledToolNames = null;
    if (ws && ws.enabled_tools) {
      try {
        const parsed = JSON.parse(ws.enabled_tools);
        if (Array.isArray(parsed) && parsed.length > 0) enabledToolNames = parsed;
      } catch { /* malformed row → default profile */ }
    }
    const result = await executeTool(tool, args || {}, {
      workspaceId: config.workspaceId,
      workspaceName: ws?.name,
      traceContext: { spanId: `api-${Date.now()}` },
    }, { enabledToolNames });

    res.json(result);
  } catch (err) {
    console.error('[tools/execute] Error:', err.message);
    res.status(err.code === 'TOOL_NOT_ENABLED' ? 403 : 500).json({ error: err.message });
  }
});

// ─── Protocol Integrations (MCP + A2A) ─────────────────────
if (config.mcpServerEnabled) {
  const mcpRoutes = require('./routes/mcp');
  app.use('/api/mcp', mcpRoutes);
  console.log('[MCP] Server enabled — POST /api/mcp, GET /api/mcp/info');
}
if (config.a2aServerEnabled) {
  const a2aRoutes = require('./routes/a2a');
  app.use('/', a2aRoutes);  // Mounts /.well-known/agent.json and /a2a
  console.log('[A2A] Server enabled — GET /.well-known/agent.json, POST /a2a');
}

// Download endpoint — serves in-memory files from download_query_results tool
// No auth required: download IDs are unguessable UUIDs with 30-min TTL
const { _downloads } = require('./tools/downloadQueryResults');
app.get('/api/downloads/:id', (req, res) => {
  const entry = _downloads.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Download not found or expired' });
  res.setHeader('Content-Type', entry.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
  res.send(entry.data);
});

// Workspace info
app.get('/api/workspace/info', requireAuth, async (req, res) => {
  try {
    const db = getAdapter();
    const ws = await db.getWorkspace(config.workspaceId);
    const version = require('../package.json').version || '1.0.0';
    res.json({ ...(ws || { id: config.workspaceId, name: config.workspaceName, status: 'active' }), version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bridge connections for this workspace (read from RT_BRIDGES env var)
app.get('/api/workspace/bridges', requireAuth, async (req, res) => {
  try {
    const { fetchManifest } = require('./utils/fetchManifest');
    const manifestData = await fetchManifest();
    res.json(manifestData.RT_BRIDGES || []);
  } catch {
    res.json([]);
  }
});

// Update workspace settings
app.patch('/api/workspace/info', requireAuth, async (req, res) => {
  try {
    const db = getAdapter();
    // Validate provider against allowed_providers restriction
    if (req.body.aiProvider) {
      const ws = await db.getWorkspace(config.workspaceId);
      if (ws?.allowed_providers) {
        try {
          const allowed = JSON.parse(ws.allowed_providers);
          if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(req.body.aiProvider)) {
            return res.status(403).json({ error: `Provider "${req.body.aiProvider}" is restricted. Allowed: ${allowed.join(', ')}` });
          }
        } catch { /* invalid JSON = unrestricted */ }
      }
    }
    const updated = await db.updateWorkspace(config.workspaceId, req.body);
    // Audit settings changes
    db.audit(config.workspaceId, req.session.userId, req.session.username, 'settings_change', 'workspace_update', {
      fields: Object.keys(req.body),
    }, req.ip).catch(() => {});
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Audit Log API ────────────────────────────────────────

app.get('/api/workspace/audit', requireAuth, async (req, res) => {
  try {
    const db = getAdapter();
    const result = await db.getAuditLog(config.workspaceId, {
      limit: parseInt(req.query.limit, 10) || 100,
      eventType: req.query.eventType || undefined,
      before: parseInt(req.query.before, 10) || undefined,
    });
    res.json(result);
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
app.post('/api/webhook/message', express.json({ verify: captureRawBody }), async (req, res) => {
  try {
    const { sourceWorkspaceId, content, timestamp, signature } = req.body;
    if (!sourceWorkspaceId || !content) return res.status(400).json({ error: 'sourceWorkspaceId and content required' });

    // Verify HMAC signature
    const secret = config.bridgeHmacSecret;
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
  // Listen FIRST, dial the database second (2026-07-19): TLS, ingress, and
  // sockets come up immediately while the DB chain runs behind them, and
  // /api/health answers 503 'starting' until the chain completes — so
  // "listening" never impersonates "ready", and a standby wake or first
  // boot serves its first request seconds sooner.
  const io = setupSockets(server, sessionMiddleware);
  global._io = io; // For webhook broadcasting
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

  // Retry DB init — the Cloud SQL proxy sidecar usually needs only a moment.
  // Exponential backoff from 250ms (capped at 3s): a fixed 3s sleep quantized
  // every wake to multiples of 3s even when the sidecar was ready in <1s,
  // which added seconds to every cold start.
  //
  // Budget: ~2 minutes, not ~36s. On a BRAND-NEW org's first boot the
  // cloud-sql-proxy sidecar is still dialing the instance while we retry;
  // 12 attempts died at 49s, crashed the container, and the kubelet restart
  // added ~25s to the very first user message (observed 2026-07-19 on a
  // fresh signup). Patience here is strictly cheaper than a crash loop.
  const maxRetries = 40;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await initAdapter();
      break;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delayMs = Math.min(250 * 2 ** (attempt - 1), 3000);
      console.log(`[DB] Connection failed (attempt ${attempt}/${maxRetries}): ${err.code || err.message}. Retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Register this workspace in the shared DB
  const db = getAdapter();
  await db.registerWorkspace(config.workspaceId, config.workspaceName, config.workspaceUrl, null);

  // Seed the provisioned system prompt into our DB row — ONCE. Self-
  // registration creates the row with an empty prompt and the chat paths
  // read the row; without this seed the workspace runs as a promptless
  // generic assistant.
  //
  // The DB row is the runtime source of truth, NOT the env. The env value is
  // frozen into the Deployment at provisioning/deploy time, while prompt
  // pushes update the DB (and Firestore) without touching the Deployment —
  // so the old overwrite-on-boot behavior meant ANY pod bounce (kubectl
  // restart, node drain, eviction, crash) silently reverted every pushed
  // prompt to whatever the env held. Observed live 2026-08-03: three
  // freshly-pushed Arthur prompts reverted to a weeks-old version minutes
  // later because a fleet restart followed the push. Boot now seeds only an
  // EMPTY row and logs drift loudly instead of "fixing" it.
  if (config.systemPrompt) {
    const ws = await db.getWorkspace(config.workspaceId);
    if (ws && !ws.system_prompt) {
      await db.updateWorkspace(config.workspaceId, { systemPrompt: config.systemPrompt });
      console.log(`[Config] Seeded system prompt from env (${config.systemPrompt.length} chars)`);
    } else if (ws && ws.system_prompt !== config.systemPrompt) {
      console.warn(
        `[Config] System prompt drift: env has ${config.systemPrompt.length} chars, ` +
        `DB row has ${ws.system_prompt.length} chars. DB wins (env is a provisioning seed); ` +
        `redeploy the workspace if the env copy matters.`,
      );
    }
  }

  // Sync provisioned AI settings if present
  if (config.aiProvider || config.aiModel) {
    const ws = await db.getWorkspace(config.workspaceId);
    if ((config.aiProvider && ws.ai_provider !== config.aiProvider) || 
        (config.aiModel && ws.ai_model !== config.aiModel)) {
      await db.updateWorkspace(config.workspaceId, {
        aiProvider: config.aiProvider || ws.ai_provider,
        aiModel: config.aiModel || ws.ai_model
      });
      console.log(`[Config] Synced AI settings from env: ${config.aiProvider || ws.ai_provider} / ${config.aiModel || ws.ai_model}`);
    }
  }

  // Apply infra-level provider restriction from env
  if (config.allowedProviders) {
    await db.updateWorkspace(config.workspaceId, { allowedProviders: config.allowedProviders });
    console.log(`[Security] Provider restriction applied: ${config.allowedProviders}`);
  }


  // Heartbeat every 60s
  heartbeatInterval = setInterval(async () => {
    try { await db.updateWorkspaceHeartbeat(config.workspaceId); } catch { /* intentionally empty */ }
  }, 60000);

  global._bootReady = true;
  console.log(`[Boot] Ready — DB connected and workspace registered (${Math.floor(process.uptime())}s after start)`);

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
  } catch { /* intentionally empty */ }
  // Close all domain database pools
  try {
    const { endPool } = require('./tools/utils/domainDb');
    if (typeof endPool === 'function') await endPool();
  } catch { /* domainDb may not be loaded */ }
  try {
    // Resolve via the package main so we close the SAME module instance the
    // tools loaded at runtime — a deep path into dist/ is a different module
    // graph under tsx, whose pool cache is always empty.
    const { endAllPools } = require('@pendragon/tools-plaid');
    if (typeof endAllPools === 'function') await endAllPools();
  } catch { /* pendragon plugin not installed */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.once('SIGUSR2', () => {
  shutdown('SIGUSR2').then(() => process.kill(process.pid, 'SIGUSR2'));
});

module.exports = app;
