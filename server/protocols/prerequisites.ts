// server/protocols/prerequisites.ts — executable contract prerequisites
// (upgrade plan 5.3; doctrine §7).
//
// A contract's `prerequisites` are predicates the RECEIVER evaluates against
// the intent's parameters after action authorization and before anything
// runs — or is served from cache. One artifact then states who may ask
// (allowedActions), how much (amount_max), how fresh (freshness_hours) and
// whether the human said yes (grant_required), all enforced at the seam,
// fail-closed, no runtime graph walk.
//
//   { kind: 'amount_max',      field, value }  → params[field] is a finite number ≤ value
//   { kind: 'freshness_hours', field, value }  → params[field] is an ISO timestamp,
//                                                now − value h ≤ ts ≤ now + 5 min
//   { kind: 'grant_required',  scope }         → params.consent_grant_id present AND the
//                                                wired verifier accepts it for `scope`
//
// Missing field → deny. Unknown kind → deny. No verifier wired for a grant
// → deny. Every evaluation is recorded as a policy check
// { type: 'prerequisite', kind, passed, detail } whether or not it passed,
// and all prerequisites are evaluated (the proof shows the whole picture)
// before the first failure denies the intent.

import type { IntentOperation } from './intentToken';
import type { PolicyCheck } from './executionProof';

export type Prerequisite =
  | { kind: 'amount_max'; field: string; value: number }
  | { kind: 'freshness_hours'; field: string; value: number }
  | { kind: 'grant_required'; scope: string };

export const PREREQUISITE_KINDS = ['amount_max', 'freshness_hours', 'grant_required'] as const;

/** The parameter a grant id travels in (matches tools-plaid CONSENT_PARAM). */
export const CONSENT_GRANT_PARAM = 'consent_grant_id';

/** Future skew tolerated on a freshness timestamp (clock drift between parties). */
export const FRESHNESS_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Verifies that `grantId` is a live, unused grant for `scope` given the
 * call's params (target derivation is the verifier's business). MUST NOT
 * consume the grant — the capability that follows consumes it itself.
 * Resolves true only on a positive verification; anything else is false.
 */
export type GrantVerifier = (grantId: string, scope: string, params: Record<string, unknown>) => Promise<boolean>;

/**
 * The parameters a prerequisite reads: the capability's input, a tool
 * call's args, a query's params. Aggregates and discovery have no single
 * parameter set, so a field-based prerequisite on them denies (there is
 * nothing to check against) — a contract that wants aggregates under an
 * amount limit must put the limit on the capability instead.
 */
export function intentParams(intent: IntentOperation): Record<string, unknown> {
  switch (intent.op) {
    case 'capability': return (intent.input && typeof intent.input === 'object') ? intent.input : {};
    case 'tool_call':  return (intent.args && typeof intent.args === 'object') ? intent.args : {};
    case 'query':      return (intent.params && typeof intent.params === 'object') ? (intent.params as Record<string, unknown>) : {};
    default:           return {};
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export interface PrerequisiteEvaluation {
  checks: PolicyCheck[];
  /** First failure, as the denial message; undefined when all passed. */
  denied?: string;
}

/**
 * Evaluate every prerequisite against `params`. Pure except for the grant
 * verifier (a lookup, never a write).
 */
export async function evaluatePrerequisites(
  prerequisites: unknown,
  params: Record<string, unknown>,
  opts: { grantVerifier?: GrantVerifier; now?: number } = {},
): Promise<PrerequisiteEvaluation> {
  const checks: PolicyCheck[] = [];
  let denied: string | undefined;
  const fail = (kind: string, detail: string) => {
    checks.push({ type: 'prerequisite', kind, passed: false, detail });
    if (!denied) denied = detail;
  };
  const pass = (kind: string, detail: string) => {
    checks.push({ type: 'prerequisite', kind, passed: true, detail });
  };

  if (prerequisites === undefined || prerequisites === null) return { checks };
  if (!Array.isArray(prerequisites)) {
    fail('invalid', 'Contract prerequisites are not a list — refusing');
    return { checks, denied };
  }
  const now = opts.now ?? Date.now();

  for (let i = 0; i < prerequisites.length; i++) {
    const p = prerequisites[i];
    if (!isPlainObject(p) || typeof p.kind !== 'string') {
      fail('invalid', `Prerequisite ${i} is malformed — refusing`);
      continue;
    }
    switch (p.kind) {
      case 'amount_max': {
        const field = typeof p.field === 'string' ? p.field : '';
        const limit = typeof p.value === 'number' ? p.value : NaN;
        if (!field || !Number.isFinite(limit)) { fail(p.kind, `Prerequisite ${i} (amount_max) has no field/value — refusing`); break; }
        const v = params[field];
        if (typeof v !== 'number' || !Number.isFinite(v)) { fail(p.kind, `amount_max: '${field}' is missing or not a number`); break; }
        if (v > limit) { fail(p.kind, `amount_max: '${field}' = ${v} exceeds ${limit}`); break; }
        pass(p.kind, `amount_max: '${field}' = ${v} ≤ ${limit}`);
        break;
      }
      case 'freshness_hours': {
        const field = typeof p.field === 'string' ? p.field : '';
        const hours = typeof p.value === 'number' ? p.value : NaN;
        if (!field || !Number.isFinite(hours) || hours < 0) { fail(p.kind, `Prerequisite ${i} (freshness_hours) has no field/value — refusing`); break; }
        const raw = params[field];
        const ts = typeof raw === 'string' && raw.trim() ? Date.parse(raw) : NaN;
        if (!Number.isFinite(ts)) { fail(p.kind, `freshness_hours: '${field}' is missing or not an ISO timestamp`); break; }
        const ageMs = now - ts;
        if (ageMs > hours * 3_600_000) { fail(p.kind, `freshness_hours: '${field}' is ${(ageMs / 3_600_000).toFixed(2)} h old, limit ${hours} h`); break; }
        if (ageMs < -FRESHNESS_FUTURE_SKEW_MS) { fail(p.kind, `freshness_hours: '${field}' is in the future`); break; }
        pass(p.kind, `freshness_hours: '${field}' is ${(Math.max(0, ageMs) / 3_600_000).toFixed(2)} h old ≤ ${hours} h`);
        break;
      }
      case 'grant_required': {
        const scope = typeof p.scope === 'string' ? p.scope : '';
        if (!scope) { fail(p.kind, `Prerequisite ${i} (grant_required) has no scope — refusing`); break; }
        const grantId = params[CONSENT_GRANT_PARAM];
        if (typeof grantId !== 'string' || !grantId.trim()) { fail(p.kind, `grant_required: '${CONSENT_GRANT_PARAM}' is missing (scope ${scope})`); break; }
        if (!opts.grantVerifier) { fail(p.kind, `grant_required: no grant verifier is wired on this receiver (scope ${scope}) — refusing`); break; }
        let ok = false;
        try { ok = (await opts.grantVerifier(grantId, scope, params)) === true; } catch { ok = false; }
        if (!ok) { fail(p.kind, `grant_required: grant for scope ${scope} did not verify`); break; }
        pass(p.kind, `grant_required: grant verified for scope ${scope}`);
        break;
      }
      default:
        fail(String(p.kind), `Prerequisite ${i} has unknown kind '${String(p.kind)}' — refusing`);
    }
  }
  return { checks, denied };
}
