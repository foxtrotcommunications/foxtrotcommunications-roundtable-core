// server/utils/validateContracts.ts — Contract schema validator
//
// Validates contracts loaded from RT_CONTRACTS env or control-plane manifest.
// Catches format mismatches (legacy vs current) that would silently break
// contract enforcement in intent_bridge and bridge_workspace tools.

interface ContractIssue {
  contractId: string;
  severity: 'error' | 'warning';
  message: string;
}

interface ValidationResult {
  valid: boolean;
  issues: ContractIssue[];
  format: 'legacy' | 'current' | 'mixed' | 'unknown';
  count: number;
}

const REQUIRED_FIELDS = ['status', 'allowedActions'];
const VALID_STATUSES = ['draft', 'pending_approval', 'active', 'pending_amendment', 'suspended', 'expired'];

/**
 * Validate an array of contracts and return issues.
 * Called at startup and on manifest refresh.
 */
function validateContracts(contracts: any[]): ValidationResult {
  const issues: ContractIssue[] = [];
  let legacyCount = 0;
  let currentCount = 0;

  if (!Array.isArray(contracts)) {
    return {
      valid: false,
      issues: [{ contractId: '(root)', severity: 'error', message: 'RT_CONTRACTS is not an array' }],
      format: 'unknown',
      count: 0,
    };
  }

  for (const c of contracts) {
    const id = c.contractId || c.id || '(unknown)';

    // ── Identify format ──
    const hasLegacyFields = !!(c.direction && c.counterparty);
    const hasCurrentFields = !!(c.source && c.target);

    if (hasLegacyFields) legacyCount++;
    if (hasCurrentFields) currentCount++;

    // ── Must have target identification ──
    if (!hasLegacyFields && !hasCurrentFields) {
      issues.push({
        contractId: id,
        severity: 'error',
        message: 'Contract has neither legacy (direction/counterparty) nor current (source/target) format — will not match any bridge',
      });
    }

    // ── Validate target wsId is present ──
    if (hasCurrentFields && (!c.target.wsId || typeof c.target.wsId !== 'string')) {
      issues.push({
        contractId: id,
        severity: 'error',
        message: 'Contract target.wsId is missing or not a string',
      });
    }
    if (hasLegacyFields && (!c.counterparty.wsId || typeof c.counterparty.wsId !== 'string')) {
      issues.push({
        contractId: id,
        severity: 'error',
        message: 'Contract counterparty.wsId is missing or not a string',
      });
    }

    // ── Required fields ──
    for (const field of REQUIRED_FIELDS) {
      if (c[field] === undefined || c[field] === null) {
        issues.push({
          contractId: id,
          severity: 'error',
          message: `Missing required field: ${field}`,
        });
      }
    }

    // ── Status validation ──
    if (c.status && !VALID_STATUSES.includes(c.status)) {
      issues.push({
        contractId: id,
        severity: 'warning',
        message: `Unknown status "${c.status}" — valid statuses: ${VALID_STATUSES.join(', ')}`,
      });
    }

    // ── allowedActions validation ──
    if (c.allowedActions && !Array.isArray(c.allowedActions)) {
      issues.push({
        contractId: id,
        severity: 'error',
        message: 'allowedActions must be an array',
      });
    } else if (c.allowedActions && c.allowedActions.length === 0) {
      issues.push({
        contractId: id,
        severity: 'warning',
        message: 'allowedActions is empty — no operations will be permitted',
      });
    }

    // ── Non-active warning ──
    if (c.status && c.status !== 'active') {
      issues.push({
        contractId: id,
        severity: 'warning',
        message: `Contract status is "${c.status}" — only "active" contracts are enforced`,
      });
    }
  }

  // ── Format consistency check ──
  let format: ValidationResult['format'] = 'unknown';
  if (legacyCount > 0 && currentCount > 0) {
    format = 'mixed';
    issues.push({
      contractId: '(all)',
      severity: 'warning',
      message: `Mixed contract formats detected: ${legacyCount} legacy + ${currentCount} current — ensure tools handle both`,
    });
  } else if (legacyCount > 0) {
    format = 'legacy';
  } else if (currentCount > 0) {
    format = 'current';
  }

  const hasErrors = issues.some(i => i.severity === 'error');

  return {
    valid: !hasErrors,
    issues,
    format,
    count: contracts.length,
  };
}

/**
 * Validate and log contract issues at startup.
 * Returns true if contracts are valid enough to proceed.
 */
function validateAndLogContracts(contracts: any[], source: string = 'RT_CONTRACTS'): boolean {
  if (!contracts || contracts.length === 0) {
    console.log(`[contracts] No contracts loaded from ${source}`);
    return true; // No contracts is valid (just no cross-workspace activity)
  }

  const result = validateContracts(contracts);

  if (result.issues.length === 0) {
    console.log(`[contracts] ✓ ${result.count} contracts validated (format: ${result.format})`);
    return true;
  }

  // Log issues
  const errors = result.issues.filter(i => i.severity === 'error');
  const warnings = result.issues.filter(i => i.severity === 'warning');

  if (errors.length > 0) {
    console.error(`[contracts] ✗ ${errors.length} error(s) in ${result.count} contracts:`);
    for (const e of errors) {
      console.error(`  [${e.contractId}] ${e.message}`);
    }
  }

  if (warnings.length > 0) {
    console.warn(`[contracts] ⚠ ${warnings.length} warning(s):`);
    for (const w of warnings) {
      console.warn(`  [${w.contractId}] ${w.message}`);
    }
  }

  console.log(`[contracts] Format: ${result.format}, Valid: ${result.valid}`);
  return result.valid;
}

module.exports = { validateContracts, validateAndLogContracts };
export { validateContracts, validateAndLogContracts };
export type { ContractIssue, ValidationResult };
