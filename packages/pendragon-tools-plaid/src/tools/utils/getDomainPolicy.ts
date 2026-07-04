// tools/utils/getDomainPolicy.ts — Domain account policy enforcement
// Reads RT_ACCOUNT_POLICY env var to filter SQL queries by allowed account types/subtypes.

interface AccountPolicy {
  allowedTypes: string[];
  allowedSubtypes: string[];
}

let cachedPolicy: AccountPolicy | null = null;

/**
 * Parse the RT_ACCOUNT_POLICY env var (JSON).
 * Returns empty arrays if not set (no filtering — backwards compatible).
 */
export function getAccountPolicy(): AccountPolicy {
  if (cachedPolicy) return cachedPolicy;
  const raw = process.env.RT_ACCOUNT_POLICY;
  if (!raw) return { allowedTypes: [], allowedSubtypes: [] };
  try {
    cachedPolicy = JSON.parse(raw) as AccountPolicy;
    return cachedPolicy;
  } catch {
    console.warn('[getDomainPolicy] Failed to parse RT_ACCOUNT_POLICY:', raw);
    return { allowedTypes: [], allowedSubtypes: [] };
  }
}

/**
 * Returns true if domain policy filtering is active.
 */
export function hasDomainPolicy(): boolean {
  const p = getAccountPolicy();
  return p.allowedTypes.length > 0;
}

/**
 * Build SQL WHERE clause fragments and parameter values for domain filtering.
 * Call with the next available parameter index (e.g., if you already have $1, $2, pass 3).
 * 
 * Returns { clause, params } where clause is like 'AND a.type = ANY($3) AND a.subtype = ANY($4)'
 * and params is the array of values to append to your query params.
 * 
 * If no policy is set, returns empty clause and no params (backwards compatible).
 */
export function buildDomainFilter(nextParamIndex: number, tableAlias: string = 'a'): {
  clause: string;
  params: any[];
} {
  const policy = getAccountPolicy();
  if (policy.allowedTypes.length === 0) {
    return { clause: '', params: [] };
  }

  const clauses: string[] = [];
  const params: any[] = [];

  clauses.push(`${tableAlias}.type = ANY($${nextParamIndex})`);
  params.push(policy.allowedTypes);

  if (policy.allowedSubtypes.length > 0) {
    clauses.push(`${tableAlias}.subtype = ANY($${nextParamIndex + 1})`);
    params.push(policy.allowedSubtypes);
  }

  return {
    clause: 'AND ' + clauses.join(' AND '),
    params,
  };
}
