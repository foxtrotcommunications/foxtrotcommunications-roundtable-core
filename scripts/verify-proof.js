#!/usr/bin/env node
// scripts/verify-proof.js — verify an execution proof with NO secrets.
//
//   node scripts/verify-proof.js <manifest.json> <proof.json> [--sql <statements.json>]
//
// manifest.json: a workspace manifest as the control plane serves it
//   (`GET /api/internal/workspaces/:id/manifest`), or just its RT_CONTRACTS
//   array, or a single contract entry — anything that leads to
//   `contract.signing[wsId]` (Ed25519 SPKI PEM per party, upgrade plan 5.2).
// proof.json: an ExecutionProof as returned in `result.proof` of
//   intent/execute (a whole IntentResult or JSON-RPC response is unwrapped).
// --sql: optional JSON array of the compiled SQL statements, to also check
//   `executedSqlHash` against them.
//
// That is the point of 5.2: the proof says which party executed, and anyone
// holding the public manifest can check it — no contract key, no master, no
// access to either workspace. Exit 0 = verified, 1 = not verified, 2 = usage.
//
// Dependency-free on purpose: only Node's crypto and the canonicalization
// rule (sorted keys, JSON.stringify) copied from intentTokenCodec.ts so the
// script runs from a checkout without a build.

const fs = require('fs');
const crypto = require('crypto');

function canonicalize(obj) {
  return JSON.stringify(obj, (_k, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted, k) => { sorted[k] = value[k]; return sorted; }, {});
    }
    return value;
  });
}

// Mirrors server/protocols/executionProof.ts proofSigningDigest — keep in sync.
const FIELD_SEP = '\x1f';
function proofSigningDigest(p) {
  const fields = [p.executedSqlHash || '', p.outputHash, p.nonce || '', p.timestamp, p.contractId, p.intentHash || p.inputHash];
  return crypto.createHash('sha256').update(fields.join(FIELD_SEP), 'utf8').digest();
}
function hashExecutedSql(sql) {
  return crypto.createHash('sha256').update(JSON.stringify(sql)).digest('hex');
}

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('usage: verify-proof.js <manifest.json> <proof.json> [--sql <statements.json>]');
  process.exit(2);
}

function readJson(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { usage(`cannot read ${path}: ${e.message}`); }
}

/** Find the contract entry for `contractId` in whatever shape we were given. */
function findContract(manifest, contractId) {
  const list = Array.isArray(manifest) ? manifest
    : Array.isArray(manifest && manifest.RT_CONTRACTS) ? manifest.RT_CONTRACTS
      : manifest && manifest.contractId ? [manifest] : [];
  return list.find((c) => c && c.contractId === contractId) || null;
}

/** Unwrap { result: { proof } } / { proof } / proof. */
function unwrapProof(doc) {
  if (doc && doc.result && doc.result.proof) return doc.result.proof;
  if (doc && doc.proof) return doc.proof;
  return doc;
}

function main(argv) {
  const args = argv.slice(2);
  const sqlIdx = args.indexOf('--sql');
  let sqlPath = null;
  if (sqlIdx !== -1) { sqlPath = args[sqlIdx + 1]; args.splice(sqlIdx, 2); }
  if (args.length !== 2) usage();

  const manifest = readJson(args[0]);
  const proof = unwrapProof(readJson(args[1]));
  if (!proof || typeof proof !== 'object' || !proof.contractId || !proof.outputHash || !proof.timestamp) {
    usage('proof.json does not look like an ExecutionProof (needs contractId, outputHash, timestamp)');
  }

  const contract = findContract(manifest, proof.contractId);
  if (!contract) {
    console.error(`NOT VERIFIED: contract ${proof.contractId} not found in manifest`);
    return 1;
  }
  const signing = contract.signing || {};
  const sig = proof.signature;
  if (!sig || sig.alg !== 'ed25519') {
    console.error('NOT VERIFIED: proof carries no Ed25519 signature (HMAC-only proof — needs the contract key to check)');
    return 1;
  }
  const pem = signing[sig.signer];
  if (!pem) {
    console.error(`NOT VERIFIED: manifest has no signing key for party ${sig.signer} (contract.signing lists: ${Object.keys(signing).join(', ') || 'none'})`);
    return 1;
  }
  if (Array.isArray(contract.parties) && !contract.parties.includes(sig.signer)) {
    console.error(`NOT VERIFIED: signer ${sig.signer} is not a party to ${proof.contractId}`);
    return 1;
  }

  let key;
  try { key = crypto.createPublicKey(pem); } catch (e) { console.error(`NOT VERIFIED: bad public key for ${sig.signer}: ${e.message}`); return 1; }
  if (key.asymmetricKeyType !== 'ed25519') { console.error('NOT VERIFIED: signing key is not Ed25519'); return 1; }

  let ok = false;
  try { ok = crypto.verify(null, proofSigningDigest(proof), key, Buffer.from(sig.sig, 'base64')); } catch { ok = false; }
  if (!ok) {
    console.error(`NOT VERIFIED: Ed25519 signature by ${sig.signer} does not match the proof fields`);
    return 1;
  }

  if (sqlPath) {
    const sql = readJson(sqlPath);
    if (!Array.isArray(sql)) usage('--sql file must be a JSON array of statements');
    if (!proof.executedSqlHash) { console.error('NOT VERIFIED: proof carries no executedSqlHash to check --sql against'); return 1; }
    if (hashExecutedSql(sql) !== proof.executedSqlHash) { console.error('NOT VERIFIED: executedSqlHash does not match the supplied statements'); return 1; }
  }

  console.log(`VERIFIED: proof for contract ${proof.contractId} signed by ${sig.signer} (ed25519)`);
  console.log(`  tool=${proof.toolName} grade=${proof.proofGrade} at=${proof.timestamp}`);
  console.log(`  outputHash=${proof.outputHash}`);
  if (proof.executedSqlHash) console.log(`  executedSqlHash=${proof.executedSqlHash} (${proof.executedSqlCount} statement(s))${sqlPath ? ' — matches --sql' : ''}`);
  if (proof.nonce) console.log(`  nonce=${proof.nonce}`);
  const failed = (proof.policyChecks || []).filter((c) => !c.passed);
  console.log(`  policyChecks=${(proof.policyChecks || []).length} (${failed.length} failed)`);
  // canonicalize is exported for tests; unused here beyond documenting the rule.
  void canonicalize;
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main, proofSigningDigest, findContract, unwrapProof };
