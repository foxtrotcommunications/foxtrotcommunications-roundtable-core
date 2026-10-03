// scripts/verify-claims.ts — doc-vs-code: every promise we make is a predicate.
//
// Doctrine §10/§11: the README, the pooled README and the doctrine's pooled
// invariants are checked against code each release; a promise we cannot
// enforce in code or expose to verification is a promise we do not make.
// This script is that check for the runtime. Each entry pairs a sentence
// someone might say about Roundtable with a predicate over this repository
// that is true exactly when the sentence is. CI runs it after the test
// suites (`npm run verify:claims`); one false claim fails the build and the
// output names it.
//
// Adding a claim: write the sentence as a reader of the docs would hear it,
// then the smallest predicate that would go false if the code regressed.
// Prefer executing the code (loading the registry, running the middleware)
// over grepping its source; grep only when the promise IS the text (a
// manifest, a migration).
//
// Claims that need a different process-wide config (pooled vs dedicated)
// run in a child `tsx` process via inChild(); everything else runs here.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// Deterministic env for the in-process claims (dedicated mode).
process.env.BRIDGE_HMAC_SECRET = process.env.BRIDGE_HMAC_SECRET || 'verify-claims-bridge-secret';
// Dedicated pods default to RT_TOOL_PROFILE_ENFORCE=warn during rollout; the
// allowlist claim below is about the enforcing mode (always on in pooled).
process.env.RT_TOOL_PROFILE_ENFORCE = 'deny';
delete process.env.POOLED_DOMAIN_TYPE;
delete process.env.POOLED_ARTHUR;

export interface Claim {
  claim: string;
  check: () => boolean | string | Promise<boolean | string>; // true = holds; string = failure detail
}

/**
 * Run `code` in a fresh tsx process with `env` layered over ours and parse
 * the JSON it prints last. The snippet runs from the repo root, so it
 * requires modules as './server/...'.
 */
function inChild(env: Record<string, string>, code: string): unknown {
  // Do not inherit NODE_OPTIONS: some tsx versions carry their loader there,
  // and stacking it on the child's own tsx is unreliable.
  const { NODE_OPTIONS: _ignored, ...parentEnv } = process.env;
  const out = execFileSync(process.execPath, [join(ROOT, 'node_modules', '.bin', 'tsx'), '-e', code], {
    cwd: ROOT,
    env: { ...parentEnv, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

const POOLED = { POOLED_DOMAIN_TYPE: 'checking', WORKSPACE_ID: 'claims' };

export const CLAIMS: Claim[] = [
  {
    claim: 'In a pooled process no dangerous tool (run_code, shell_exec, write_file, git_*) is registered at all — not even an explicit enabled_tools row can opt a tenant back in.',
    check: () => {
      const r = inChild(POOLED, `
        const t = require('./server/tools/index');
        const registered = t.DANGEROUS_TOOLS.filter((n) => t.tools[n] !== undefined);
        const optIn = Object.keys(t.resolveTools([...t.DANGEROUS_TOOLS, 'calculator'])).filter((n) => t.DANGEROUS_TOOLS.includes(n));
        console.log(JSON.stringify({ registered, optIn, hasIntentBridge: !!t.tools['intent_bridge'] })); process.exit(0);
      `) as { registered: string[]; optIn: string[]; hasIntentBridge: boolean };
      if (r.registered.length) return `registered in pooled: ${r.registered.join(', ')}`;
      if (r.optIn.length) return `opt-in succeeded in pooled: ${r.optIn.join(', ')}`;
      if (!r.hasIntentBridge) return 'intent_bridge missing from the pooled registry';
      return true;
    },
  },
  {
    claim: 'A pooled process refuses a dynamic (MCP) registration under a dangerous tool name.',
    check: () => {
      const r = inChild(POOLED, `
        const t = require('./server/tools/index');
        console.warn = () => {};
        t.registerDynamicTools([{ name: 'write_file', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({}) }]);
        console.log(JSON.stringify({ smuggled: !!t.getDynamicTools()['write_file'] })); process.exit(0);
      `) as { smuggled: boolean };
      return r.smuggled ? 'write_file was registered dynamically in pooled mode' : true;
    },
  },
  {
    claim: 'NULL enabled_tools means the default profile: every dangerous tool excluded, intent_bridge included.',
    check: () => {
      const t = require('../server/tools/index');
      const resolved = Object.keys(t.resolveTools(null));
      const leaked = t.DANGEROUS_TOOLS.filter((n: string) => resolved.includes(n));
      if (leaked.length) return `dangerous tools in the default profile: ${leaked.join(', ')}`;
      if (!resolved.includes('intent_bridge')) return 'intent_bridge missing from the default profile (the 2026-08-14 regression)';
      if (!resolved.includes('run_code') && !t.tools['run_code']) return 'run_code is not even registered in dedicated mode — the claim is about the profile, check the registry';
      return true;
    },
  },
  {
    claim: 'The tool allowlist is enforced at execution, not only at advertisement: under RT_TOOL_PROFILE_ENFORCE=deny (always the case in pooled) executeTool throws ToolNotEnabled for a tool outside the list.',
    check: async () => {
      const t = require('../server/tools/index');
      try {
        await t.executeTool('calculator', { expression: '1+1' }, {}, { enabledToolNames: ['web_search'] });
        return 'executeTool ran calculator although only web_search was enabled';
      } catch (err) {
        const e = err as { code?: string; message: string };
        return e.code === 'TOOL_NOT_ENABLED' ? true : `wrong error: ${e.message}`;
      }
    },
  },
  {
    claim: 'S2S v2 signatures bind the body: requireHmac rejects a request whose body differs from the one signed, and accepts the intact one.',
    check: async () => {
      const s2s = require('../server/utils/s2sSig');
      const { verifyS2sRequest } = require('../server/middleware/requireHmac');
      const secret = process.env.BRIDGE_HMAC_SECRET!;
      const body = '{"a":1}';
      const { headers } = s2s.signPathV2({ secret, routePath: 'sync', body, tenantWsId: 'ws-a' });
      const good = await verifyS2sRequest({ headers, rawBody: Buffer.from(body) }, 'sync');
      if (!good.ok) return `intact request rejected: ${good.error}`;
      const { headers: h2 } = s2s.signPathV2({ secret, routePath: 'sync', body, tenantWsId: 'ws-a' });
      const bad = await verifyS2sRequest({ headers: h2, rawBody: Buffer.from('{"a":2}') }, 'sync');
      return bad.ok ? 'tampered body accepted' : true;
    },
  },
  {
    claim: 'S2S v2 signatures bind the nonce: a replayed request is rejected.',
    check: async () => {
      const s2s = require('../server/utils/s2sSig');
      const { verifyS2sRequest } = require('../server/middleware/requireHmac');
      const secret = process.env.BRIDGE_HMAC_SECRET!;
      const { headers } = s2s.signPathV2({ secret, routePath: 'sync', body: '', tenantWsId: 'ws-a' });
      const first = await verifyS2sRequest({ headers, rawBody: Buffer.from('') }, 'sync');
      if (!first.ok) return `first use rejected: ${first.error}`;
      const replay = await verifyS2sRequest({ headers, rawBody: Buffer.from('') }, 'sync');
      return replay.ok ? 'replayed nonce accepted' : true;
    },
  },
  {
    claim: 'The manifest fails closed: a 200 with empty RT_CONTRACTS yields zero contracts even when the env var still lists one.',
    check: () => {
      const r = inChild({ CONTROL_PLANE_URL: 'http://cp.invalid', RT_CONTRACTS: JSON.stringify([{ contractId: 'env-c', status: 'active', allowedActions: ['*'] }]), WORKSPACE_ID: 'own-ws' }, `
        global.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ RT_CONTRACTS: [], RT_BRIDGES: [] }) });
        console.log = () => {}; console.warn = () => {};
        const { fetchManifest } = require('./server/utils/fetchManifest');
        fetchManifest('own-ws').then((m) => { process.stdout.write(JSON.stringify({ n: (m.RT_CONTRACTS || []).length }) + '\\n'); process.exit(0); });
      `) as { n: number };
      return r.n === 0 ? true : `${r.n} contract(s) resurrected from env after an empty 200`;
    },
  },
  {
    claim: 'Contract lookups enforce liveness: a non-active or expired contract is rejected at every lookup.',
    check: () => {
      const { findAndValidateContract } = require('../server/utils/contractAuth');
      const base = { contractId: 'c1', allowedActions: ['message'], counterparty: { wsId: 'ws-b' } };
      const suspended = findAndValidateContract([{ ...base, status: 'suspended' }], 'c1', 'message');
      if (!suspended.error) return 'suspended contract accepted';
      const expired = findAndValidateContract([{ ...base, status: 'active', expiresAt: '2000-01-01T00:00:00Z' }], 'c1', 'message');
      if (!expired.error) return 'expired contract accepted';
      const live = findAndValidateContract([{ ...base, status: 'active' }], 'c1', 'message');
      return live.error ? `live contract rejected: ${live.error}` : true;
    },
  },
  {
    claim: 'message/send is not a transport action: message, delegate and message_send require an explicit grant in allowedActions.',
    check: () => {
      const { TRANSPORT_ACTIONS, isActionAllowed } = require('../server/utils/contractAuth');
      const { MESSAGE_ACTIONS, ACTION } = require('../server/vocab/actions');
      const auto = MESSAGE_ACTIONS.filter((a: string) => TRANSPORT_ACTIONS.includes(a));
      if (auto.length) return `auto-allowed: ${auto.join(', ')}`;
      if (isActionAllowed([ACTION.intent_execute, ACTION.discover], ACTION.delegate)) return 'delegate allowed without a grant';
      if (isActionAllowed([], ACTION.message_send)) return 'message_send allowed on an empty grant';
      if (!isActionAllowed([ACTION.message], ACTION.message_send)) return 'message grant no longer satisfies the message_send alias';
      return true;
    },
  },
  {
    claim: 'The intent cache serves read-only work only: aggregate, discover and any non-readOnly tool re-execute on every call.',
    check: () => {
      const { isIntentCacheable } = require('../server/protocols/intentExecutor');
      if (isIntentCacheable({ op: 'aggregate', steps: [] })) return 'aggregate is cacheable';
      if (isIntentCacheable({ op: 'discover', scope: 'tools' })) return 'discover is cacheable';
      if (isIntentCacheable({ op: 'tool_call', tool: 'write_file', args: {} })) return 'write_file (side-effecting) is cacheable';
      if (!isIntentCacheable({ op: 'tool_call', tool: 'calculator', args: {} })) return 'calculator (readOnly) is not cacheable — the allowlist shrank';
      return true;
    },
  },
  {
    claim: 'Every core tenant table (workspaces, messages, user_api_keys, workspace_usage, audit_log) gets the two-policy pattern under FORCE ROW LEVEL SECURITY.',
    check: () => {
      const rls = require('../server/db/rls.js');
      const want = ['workspaces', 'messages', 'user_api_keys', 'workspace_usage', 'audit_log'];
      const have = rls.CORE_RLS_TABLES.map((t: { table: string }) => t.table);
      const missing = want.filter((t) => !have.includes(t));
      if (missing.length) return `not under RLS: ${missing.join(', ')}`;
      for (const { table, column } of rls.CORE_RLS_TABLES) {
        const sql = rls.rlsStatementsFor(table, column).join('\n');
        if (!sql.includes(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)) return `${table}: no FORCE ROW LEVEL SECURITY`;
        if (!sql.includes('CREATE POLICY workspace_isolation')) return `${table}: no workspace_isolation policy`;
        if (!sql.includes('CREATE POLICY tenant_context')) return `${table}: no tenant_context policy`;
        if (!sql.includes("current_setting(''app.workspace_id''") && !sql.includes("current_setting('app.workspace_id'")) return `${table}: tenant_context does not key on app.workspace_id`;
      }
      return true;
    },
  },
  {
    claim: 'A dedicated workspace pod connects as its own DB role: DATABASE_URL comes from the per-workspace secret rt-<id>-db, never a mounted admin URL.',
    check: () => {
      const y = read('k8s/overlays/gcp/workspace.yaml');
      const m = y.match(/- name: DATABASE_URL\s*\n\s*valueFrom:\s*\n\s*secretKeyRef:\s*\n\s*name: rt-\$\{WORKSPACE_ID\}-db/);
      if (!m) return 'workspace.yaml does not take DATABASE_URL from rt-${WORKSPACE_ID}-db';
      if (/DATABASE_URL:\s*postgres/.test(y) || /value: "?postgres(ql)?:\/\//.test(y)) return 'a literal DATABASE_URL is rendered into the pod';
      return true;
    },
  },
  {
    claim: 'The pooled chat path never registers a tenant\'s MCP servers into the process-global registry.',
    check: () => {
      const r = inChild(POOLED, `
        console.error = () => {}; console.log = () => {};
        const t = require('./server/tools/index');
        const { discoverMcpTools } = require('./server/sockets/chat/mcp');
        const cfg = {};
        discoverMcpTools({ mcp_servers: [{ name: 'evil', url: 'http://127.0.0.1:1' }] }, 'tenant-a', { RT_MCP_SERVERS: [{ name: 'evil2', url: 'http://127.0.0.1:1' }] }, cfg)
          .then(() => { process.stdout.write(JSON.stringify({ dyn: Object.keys(t.getDynamicTools()), mcpServers: cfg.mcpServers ?? null }) + '\\n'); process.exit(0); });
      `) as { dyn: string[]; mcpServers: unknown };
      if (r.dyn.length) return `dynamic tools registered in pooled chat: ${r.dyn.join(', ')}`;
      if (r.mcpServers) return 'workspaceConfig.mcpServers was populated in pooled mode';
      return true;
    },
  },
  {
    claim: 'The action vocabulary in this repo is the one the control plane carries: sha256(ACTIONS) equals tests/fixtures/actions.sha256.',
    check: () => {
      const { ACTIONS } = require('../server/vocab/actions');
      const got = createHash('sha256').update(JSON.stringify(ACTIONS)).digest('hex');
      const want = read('tests/fixtures/actions.sha256').trim();
      return got === want ? true : `vocabulary hash ${got.slice(0, 12)}… != fixture ${want.slice(0, 12)}…`;
    },
  },
];

async function main() {
  let failed = 0;
  for (const { claim, check } of CLAIMS) {
    let result: boolean | string;
    try {
      result = await check();
    } catch (err) {
      result = `threw: ${(err as Error).message}`;
    }
    if (result === true) {
      console.log(`  ok    ${claim}`);
    } else {
      failed++;
      console.log(`  FAIL  ${claim}`);
      console.log(`        ${String(result).split('\n').join('\n        ')}`);
    }
  }
  console.log(`\nverify-claims: ${CLAIMS.length - failed}/${CLAIMS.length} claims hold`);
  // The loaded server modules keep timers (nonce store, caches) alive; exit explicitly.
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
