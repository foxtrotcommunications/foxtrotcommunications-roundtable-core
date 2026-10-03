/**
 * S2S v2 routePath registry (upgrade plan 5.0) — the core half of the
 * cross-repo reconciliation.
 *
 * tests/pooled/s2sRoutePaths.json is byte-for-byte the same file as the
 * control plane's api/tests/fixtures/s2sRoutePaths.json. This test scans
 * core's source for every v2 signer (signPathV2({ routePath: '…' })) and
 * every path-based verifier (requireHmac('…'), verifyS2sRequest(req, '…'))
 * and asserts the names are exactly the registry's — a renamed route on
 * one side of the wire is a silent 401 on the other, which is a correctness
 * bug, not a style issue.
 *
 * Signer tenant binding is checked too: a signer whose call carries
 * `tenantWsId:` must be registered tenantBound true/'optional', and one
 * registered true must bind.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../server');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 's2sRoutePaths.json'), 'utf8')) as {
  routes: Array<{ route: string; tenantBound: boolean | 'optional'; direction: string; note?: string }>;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(p, out);
    } else if (/\.(ts|js)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const SOURCE = walk(ROOT).map((p) => ({ p, text: fs.readFileSync(p, 'utf8') }));

/** signPathV2({ … routePath: 'x' … }) → [{ route, bindsTenant }] */
function scanSigners(): Array<{ route: string; bindsTenant: boolean; file: string }> {
  const out: Array<{ route: string; bindsTenant: boolean; file: string }> = [];
  const re = /signPathV2\(\s*\{([^}]*)\}/g;
  for (const { p, text } of SOURCE) {
    if (p.endsWith('utils/s2sSig.js')) continue; // the definition
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const args = m[1];
      const r = /routePath:\s*'([^']+)'/.exec(args);
      if (!r) throw new Error(`${p}: signPathV2 call without a literal routePath — the registry cannot see it`);
      out.push({ route: r[1], bindsTenant: /tenantWsId:/.test(args), file: path.relative(ROOT, p) });
    }
  }
  return out;
}

/** requireHmac('x' … ) and verifyS2sRequest(req, 'x' … ) → routes */
function scanVerifiers(): Array<{ route: string; file: string }> {
  const out: Array<{ route: string; file: string }> = [];
  const res = [/requireHmac\(\s*'([^']+)'/g, /verifyS2sRequest\(\s*\w+\s*,\s*'([^']+)'/g];
  for (const { p, text } of SOURCE) {
    if (p.endsWith('middleware/requireHmac.js')) continue; // the definitions
    for (const re of res) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) out.push({ route: m[1], file: path.relative(ROOT, p) });
    }
  }
  return out;
}

const byRoute = new Map(FIXTURE.routes.map((r) => [r.route, r]));

describe('S2S v2 routePath registry (core)', () => {
  it('fixture is well-formed and has no duplicate routes', () => {
    const seen = new Set<string>();
    for (const r of FIXTURE.routes) {
      expect(typeof r.route).toBe('string');
      expect([true, false, 'optional']).toContain(r.tenantBound);
      expect(['core->cp', 'cp->core', 'pd->core']).toContain(r.direction);
      expect(seen.has(r.route)).toBe(false);
      seen.add(r.route);
    }
  });

  it("core's signers use exactly the registry's core->cp routes (minus ones core does not emit yet)", () => {
    const signers = scanSigners();
    const signed = new Set(signers.map((s) => s.route));
    const expected = new Set(FIXTURE.routes
      .filter((r) => r.direction === 'core->cp' && !/does not sign this yet/.test(r.note || ''))
      .map((r) => r.route));
    expect([...signed].sort()).toEqual([...expected].sort());
  });

  it('every core signer binds the tenant exactly as registered', () => {
    for (const s of scanSigners()) {
      const reg = byRoute.get(s.route)!;
      expect(reg).toBeDefined();
      if (reg.tenantBound === true) expect({ ...s, bindsTenant: s.bindsTenant }).toEqual({ ...s, bindsTenant: true });
      if (reg.tenantBound === false) expect({ ...s, bindsTenant: s.bindsTenant }).toEqual({ ...s, bindsTenant: false });
    }
  });

  it("core's verifiers use exactly the registry's cp->core and pd->core routes (minus routes core does not serve)", () => {
    const verified = new Set(scanVerifiers().map((v) => v.route));
    const expected = new Set(FIXTURE.routes
      .filter((r) => (r.direction === 'cp->core' || r.direction === 'pd->core') && !/no core route/.test(r.note || ''))
      .map((r) => r.route));
    expect([...verified].sort()).toEqual([...expected].sort());
  });

  it('the pooled task-complete signer binds the tenant, not the service id', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes/bridgeReceive.js'), 'utf8');
    const call = /signPathV2\(\s*\{[^}]*routePath: 'bridges\/tasks\/complete'[^}]*\}/.exec(src)!;
    expect(call).not.toBeNull();
    expect(call[0]).toMatch(/tenantWsId:\s*tenantWsId \|\| config\.workspaceId/);
  });
});
