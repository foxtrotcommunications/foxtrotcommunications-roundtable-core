// server/pooled/tenantResolver.ts — who is this request FOR?
//
// In a pooled service the receiving workspace arrives as a claim
// (X-Rt-Tenant) and is never trusted alone. Proof is two-sided:
//   1. The caller's contract HMAC (verified by the a2a middleware with the
//      tenant bound into the signed string — contractAuth.js) proves the
//      caller holds contract C's HKDF key, i.e. is a party to C.
//   2. C ∈ manifest(claimed tenant) proves the claimed tenant is ALSO a
//      party to C — the control plane only lists a contract in workspace W's
//      manifest when W is its source or target.
// Together: the only tenant a holder of key(C) can successfully claim is the
// counterparty of their own contract — exactly the workspace they are
// authorized to consult. Everything else fails closed (403).

// CJS interop style matching routes/a2a.ts — these modules are CommonJS.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetchManifest } = require('../utils/fetchManifest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findAndValidateContract } = require('../utils/contractAuth');

export const TENANT_HEADER = 'x-rt-tenant';

export interface ResolvedTenant {
  workspaceId: string;
  manifest: {
    RT_CONTRACTS: any[];
    RT_BRIDGES: any[];
    RT_MCP_SERVERS?: any[];
    RT_A2A_AGENTS?: any[];
    /** Sanitized connection list (control-plane addition; may be absent on
     *  older control planes — credentials then simply don't resolve). */
    RT_CONNECTIONS?: Array<{ connId: string; name?: string; type: string; envPrefix?: string; domainType?: string }>;
  };
  /** The manifest contract entry that authorized this request. */
  contract: any;
}

export class TenantResolutionError extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = 'TenantResolutionError';
    this.status = status;
  }
}

/**
 * Resolve and authorize the tenant claim on a contract-authenticated request.
 * Call AFTER the contract signature has been verified with the tenant bound
 * in — this function decides membership, not cryptography.
 */
export async function resolveTenantFromRequest(
  req: { headers: Record<string, unknown> },
  opts: { contractId: string; action: string },
): Promise<ResolvedTenant> {
  const raw = req.headers[TENANT_HEADER];
  const workspaceId = typeof raw === 'string' ? raw.trim() : '';
  if (!workspaceId) {
    throw new TenantResolutionError('Missing X-Rt-Tenant header', 401);
  }

  // Tenant-keyed manifest; for a workspace this control plane doesn't know,
  // the fetch fails closed to an empty contract list — membership then fails.
  const manifest = await fetchManifest(workspaceId);

  const validation = findAndValidateContract(
    manifest?.RT_CONTRACTS ?? [],
    opts.contractId,
    opts.action,
  ) as { contract?: any; error?: string };
  if (!validation.contract) {
    throw new TenantResolutionError(
      `Contract ${opts.contractId} not authorized for tenant ${workspaceId}: ${validation.error}`,
    );
  }

  // Direction assert — consults run source→target, so the receiving tenant
  // should see the contract as inbound. LOG-ONLY until shadow parity confirms
  // no legitimate outbound-direction receives exist; then enforce.
  const direction = validation.contract?.direction;
  if (direction && direction !== 'inbound') {
    console.warn(
      `[tenantResolver] direction=${direction} (not inbound) for contract ${opts.contractId} on tenant ${workspaceId} — log-only for now`,
    );
  }

  return { workspaceId, manifest, contract: validation.contract };
}
