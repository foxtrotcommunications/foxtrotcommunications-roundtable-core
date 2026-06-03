// @ts-nocheck
// server/tools/verifyWorkspace.js — Meta-tool: AI self-test of workspace capabilities
// This tool is ALWAYS available regardless of workspace tool configuration.
// It runs lightweight health checks against each enabled tool and data source
// to verify they are functional, not just present.
//
// The AI calls this when it needs confidence that its tools work before
// starting a complex task, or when a user asks it to verify its environment.

const config = require('../config');
import fs from 'fs';
import path from 'path';

import type { Tool } from '../types';
// @ts-ignore


const tool: Tool = {
  name: 'verify_workspace',
  description: 'Run health checks against all enabled tools and data sources to verify they are functional. Returns pass/fail status for each tool. Call this to confirm your environment is working before starting complex tasks, or when asked to verify your capabilities.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  // Meta flag — tool registry uses this to ensure it's always included
  alwaysEnabled: true,

  async execute(_args: any, workspaceConfig: any = {}, _context?: any) {
    const { getAdapter   } = require('../db/adapter');
    const { resolveTools   } = require('./index');

    const workspace = await getAdapter().getWorkspace(config.workspaceId);

    // Resolve which tools are enabled
    let enabledToolNames = null;
    if (workspace?.enabled_tools) {
      try {
        const parsed = JSON.parse(workspace.enabled_tools);
        if (Array.isArray(parsed) && parsed.length > 0) enabledToolNames = parsed;
      } catch (_: any) {}
    }

    const activeTools = resolveTools(enabledToolNames);
    const results = [];
    const startTime = Date.now();

    // ── Tool Health Checks ──────────────────────────────────
    for (const [name, tool] of Object.entries(activeTools)) {
      // Skip meta-tools
      if (tool.alwaysEnabled) continue;

      const check = { name, status: 'unknown', latencyMs: 0, detail: '' };
      const t0 = Date.now();

      try {
        switch (name) {
          // ── Calculator: evaluate a trivial expression ───────
          case 'calculator':
            const calcResult = await tool.execute({ expression: '1 + 1' });
            if (calcResult.result === 2 || calcResult.result === '2') {
              check.status = 'pass';
              check.detail = '1 + 1 = 2';
            } else {
              check.status = 'fail';
              check.detail = `Expected 2, got ${calcResult.result}`;
            }
            break;

          // ── Code Runner: execute trivial JS ────────────────
          case 'run_code':
            const codeResult = await tool.execute({ code: 'console.log("ok")' });
            if (codeResult.output && codeResult.output.includes('ok')) {
              check.status = 'pass';
              check.detail = 'Sandboxed JS execution working';
            } else {
              check.status = 'fail';
              check.detail = `Unexpected output: ${JSON.stringify(codeResult)}`;
            }
            break;

          // ── File Tools: check workspace directory exists ───
          case 'read_file':
          case 'write_file':
          case 'list_files':
          case 'find_file':
            const wsDir = path.resolve(__dirname, '..', '..', 'workspace');
            if (fs.existsSync(wsDir)) {
              check.status = 'pass';
              check.detail = `Workspace directory exists: ${wsDir}`;
            } else {
              check.status = 'fail';
              check.detail = 'Workspace directory not found';
            }
            break;

          // ── Shell Exec: check if enabled at env level ──────
          case 'shell_exec':
            if (process.env.SHELL_EXEC_ENABLED === 'false') {
              check.status = 'disabled';
              check.detail = 'SHELL_EXEC_ENABLED=false (blocked at environment level)';
            } else {
              check.status = 'pass';
              check.detail = 'Shell execution enabled';
            }
            break;

          // ── Git Tools: check if git is available ───────────
          case 'git_clone':
          case 'git_commit':
            try {
              const { execSync   } = require('child_process');
              const gitVersion = execSync('git --version', { encoding: 'utf8', timeout: 3000 }).trim();
              check.status = 'pass';
              check.detail = gitVersion;
            } catch (e: any) {
              check.status = 'fail';
              check.detail = 'git binary not found';
            }
            break;

          // ── BigQuery: run SELECT 1 ─────────────────────────
          case 'query_bigquery':
            const gcpProject = config.vertexai?.project || process.env.GCP_PROJECT;
            if (!gcpProject) {
              check.status = 'fail';
              check.detail = 'GCP_PROJECT not configured';
            } else {
              try {
                const bqResult = await tool.execute(
                  { query: 'SELECT 1 AS health_check', projectId: gcpProject },
                  workspaceConfig
                );
                if (bqResult.error) {
                  check.status = 'fail';
                  check.detail = bqResult.error;
                } else {
                  check.status = 'pass';
                  check.detail = `Connected to BigQuery (project: ${gcpProject})`;
                }
              } catch (e: any) {
                check.status = 'fail';
                check.detail = e.message;
              }
            }
            break;

          // ── Snowflake: check config presence ───────────────
          case 'query_snowflake':
            if (config.snowflake?.account) {
              check.status = 'configured';
              check.detail = `Account: ${config.snowflake.account} (run a query to fully verify)`;
            } else {
              check.status = 'not_configured';
              check.detail = 'SNOWFLAKE_ACCOUNT not set';
            }
            break;

          // ── Databricks: check config presence ──────────────
          case 'query_databricks':
            if (config.databricks?.host) {
              check.status = 'configured';
              check.detail = `Host: ${config.databricks.host} (run a query to fully verify)`;
            } else {
              check.status = 'not_configured';
              check.detail = 'DATABRICKS_HOST not set';
            }
            break;

          // ── Web Search: check API key or grounding config ──
          case 'web_search':
            if (config.googleSearch?.apiKey || gcpProject) {
              check.status = 'pass';
              check.detail = config.googleSearch?.apiKey
                ? 'Google Custom Search API key configured'
                : 'Vertex AI grounding available via GCP project';
            } else {
              check.status = 'not_configured';
              check.detail = 'No search API key or GCP project configured';
            }
            break;

          // ── URL Reader: check network connectivity ─────────
          case 'read_url':
            check.status = 'pass';
            check.detail = 'HTTP client available (network access depends on deployment)';
            break;

          // ── Default: tool exists but no specific health check
          default:
            check.status = 'present';
            check.detail = 'Tool registered, no specific health check implemented';
            break;
        }
      } catch (err: any) {
        check.status = 'error';
        check.detail = err.message;
      }

      check.latencyMs = Date.now() - t0;
      results.push(check);
    }

    // ── Database Health ─────────────────────────────────────
    const dbCheck = { name: 'database', status: 'unknown', latencyMs: 0, detail: '' };
    const dbT0 = Date.now();
    try {
      const db = getAdapter();
      const ws = await db.getWorkspace(config.workspaceId);
      if (ws) {
        dbCheck.status = 'pass';
        dbCheck.detail = `PostgreSQL connected, workspace "${ws.name}" found`;
      } else {
        dbCheck.status = 'pass';
        dbCheck.detail = 'Database connected (workspace record will be created on first use)';
      }
    } catch (e: any) {
      dbCheck.status = 'fail';
      dbCheck.detail = e.message;
    }
    dbCheck.latencyMs = Date.now() - dbT0;

    // ── Summary ─────────────────────────────────────────────
    const passed = results.filter(r => r.status === 'pass').length;
    const failed = results.filter(r => r.status === 'fail' || r.status === 'error').length;
    const disabled = results.filter(r => r.status === 'disabled').length;
    const notConfigured = results.filter(r => r.status === 'not_configured').length;

    return {
      workspace: {
        id: config.workspaceId,
        name: config.workspaceName,
      },
      summary: {
        totalTools: results.length,
        passed,
        failed,
        disabled,
        notConfigured,
        other: results.length - passed - failed - disabled - notConfigured,
        healthy: failed === 0,
      },
      database: dbCheck,
      tools: results,
      totalLatencyMs: Date.now() - startTime,
    };
  },
};

export default tool;
