// server/pooled/index.js — pooled domain-service entrypoint.
//
// One process per DOMAIN TYPE (POOLED_DOMAIN_TYPE=checking|debt|...), serving
// a2a consults and tenant-scoped S2S routes for MANY logical workspaces.
// Started via `npm run start:pooled`; server/index.js (the dedicated pod
// entrypoint) is untouched and remains the default.
//
// Deliberately absent relative to server/index.js — a pooled domain service
// has no users, no browser, no per-workspace boot machinery:
//   sessions/auth/SPA/embed CORS, sockets (and the A2A_API_KEY room bypass),
//   /api/bridge chat-push, the shared workspace/ filesystem routes,
//   /api/tools/execute, MCP routes, the unauthenticated /api/downloads store,
//   workspace register/prompt-seed/AI-settings-sync boot writes, heartbeat.
// The full mount-by-mount rationale lives in
// pendragon/docs/pooled-entrypoint-plan.md §Q3.

const express = require('express');
const helmet = require('helmet');
const config = require('../config');
const { initAdapter } = require('../db/adapter');
const { requireHmac } = require('../middleware/requireHmac');
const { credentialCacheStats } = require('../tenantCredentials');

if (!config.pooledDomainType) {
  console.error('[pooled] POOLED_DOMAIN_TYPE is not set — this entrypoint only runs pooled services.');
  process.exit(1);
}
if (!config.databaseUrl) {
  console.error('[pooled] DATABASE_URL is not set — must be the pooled NOBYPASSRLS service role.');
  process.exit(1);
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10mb' }));

// ─── Health ─────────────────────────────────────────────────────────────────
const bootedAt = Date.now();
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    mode: 'pooled',
    domainType: config.pooledDomainType,
    uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
    credentialCache: credentialCacheStats(),
  });
});

// ─── A2A (consults; tenant per request) ─────────────────────────────────────
// Requiring the router transitively loads server/tools, whose pooled branch
// registers this domain type's capabilities exactly once.
const a2aRoutes = require('../routes/a2a');
app.use('/', a2aRoutes);

// ─── S2S plugin routes (tenant REQUIRED on every mount) ─────────────────────
// Same route exports and mount paths as the dedicated pod, but every request
// must carry X-Rt-Workspace bound into its HMAC. NOTE: the plugin's route
// handlers must read req.rtTenant (tools-plaid follow-up) before these routes
// can serve pooled traffic; until then they'd act on env identity, which is
// absent here — fail, not leak.
const S2S_ROUTES = [
  ['/api/sync', 'sync', 'syncRoute'],
  ['/api/goals', 'goals', 'goalsRoute'],
  ['/api/snapshot', 'snapshot', 'snapshotRoute'],
  ['/api/memory', 'memory', 'memoryRoute'],
  ['/api/corrections', 'corrections', 'correctionsRoute'],
  ['/api/activity', 'activity', 'activityRoute'],
  ['/api/briefs', 'briefs', 'briefsRoute'],
  ['/api/household-members', 'household-members', 'membersRoute'],
  ['/api/export', 'export', 'exportRoute'],
  ['/api/watches', 'watches', 'watchesRoute'],
  ['/api/import', 'import', 'importRoute'],
];
try {
  const plugin = require('@pendragon/tools-plaid');
  for (const [mountPath, hmacPath, exportName] of S2S_ROUTES) {
    if (plugin[exportName]) {
      app.use(mountPath, requireHmac(hmacPath, { tenantRequired: true }), plugin[exportName]);
    }
  }
  // Demographics seeding only exists on the demographics service.
  if (config.pooledDomainType === 'demographics' && plugin.demographicsSeedRoute) {
    app.use('/api/demographics/seed',
      requireHmac('demographics/seed', { tenantRequired: true }), plugin.demographicsSeedRoute);
  }
} catch (err) {
  console.warn(`[pooled] Plugin routes not mounted: ${err.message}`);
}

// ─── Boot ───────────────────────────────────────────────────────────────────
async function start() {
  // Same patient retry loop as the dedicated pod: the Cloud SQL proxy sidecar
  // may still be dialing; a crash loop is strictly worse than waiting.
  const maxRetries = 40;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await initAdapter();
      break;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delayMs = Math.min(250 * 2 ** (attempt - 1), 3000);
      console.log(`[pooled:DB] Connection failed (attempt ${attempt}/${maxRetries}): ${err.code || err.message}. Retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  // No registerWorkspace, no prompt seeding, no heartbeat — the registry
  // owns workspace rows; service health IS pooled health.

  const server = app.listen(config.port, () => {
    console.log(`[pooled] ${config.pooledDomainType} service listening on :${config.port}`);
  });

  const shutdown = async (signal) => {
    console.log(`[pooled] ${signal} — shutting down`);
    server.close();
    try {
      const { endAllPools } = require('@pendragon/tools-plaid/src/db/pool.js');
      await endAllPools();
    } catch { /* plugin absent or path shape differs — pools die with the process */ }
    try {
      const { getAdapter } = require('../db/adapter');
      await getAdapter().close?.();
    } catch { /* already closed */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[pooled] Fatal boot error:', err);
  process.exit(1);
});
