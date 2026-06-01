// server/routes/mcp.ts — MCP protocol routes
import type { Request, Response, NextFunction } from 'express';

const express = require('express');
const config = require('../config');
const { createMcpRequestHandler } = require('../mcp/server');

const router = express.Router();

// ─── Bearer Token Auth Middleware ──────────────────────────

function requireMcpApiKey(req: Request, res: Response, next: NextFunction): void {
  const mcpApiKey = (config as any).mcpApiKey;

  // If no MCP API key is configured, reject all requests
  if (!mcpApiKey) {
    res.status(403).json({ error: 'MCP endpoint not configured — set MCP_API_KEY to enable' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  // Constant-time comparison to prevent timing attacks
  const crypto = require('crypto');
  const expected = Buffer.from(mcpApiKey, 'utf8');
  const received = Buffer.from(token, 'utf8');

  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  next();
}

// ─── POST / — MCP JSON-RPC Endpoint ───────────────────────

const mcpHandler = createMcpRequestHandler(null);
router.post('/', requireMcpApiKey, mcpHandler);

// ─── GET /info — Server Discovery (no auth) ───────────────

router.get('/info', (_req: Request, res: Response) => {
  res.json({
    name: `roundtable-${config.workspaceId}`,
    version: '1.0.0',
    protocol: 'mcp',
    capabilities: ['tools'],
    description: 'Roundtable workspace MCP server',
  });
});

module.exports = router;
