#!/usr/bin/env node
// =============================================================================
// Pendragon Demo — Firestore Seeding Script
// =============================================================================
// Reads config files (org.json, workspaces.json, bridges.json, contracts.json)
// and seeds Firestore with the complete workspace, bridge, and contract
// document set for the Pendragon Capital demo org.
//
// Prerequisites:
//   - firebase-admin npm package installed
//   - GOOGLE_APPLICATION_CREDENTIALS env var set, or running on GCE/Cloud Shell
//
// Usage:
//   node scripts/seed-firestore.js
//   node scripts/seed-firestore.js --dry-run   # Print what would be written
//   node scripts/seed-firestore.js --delete     # Delete all docs first
// =============================================================================

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SCRIPT_DIR = __dirname;
const CONFIG_DIR = path.join(SCRIPT_DIR, '..', 'config');

// Load config files
const orgConfig = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'org.json'), 'utf8'));
const workspaces = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'workspaces.json'), 'utf8'));
const bridges = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'bridges.json'), 'utf8'));
const contracts = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'contracts.json'), 'utf8'));

// CLI flags
const DRY_RUN = process.argv.includes('--dry-run');
const DELETE_FIRST = process.argv.includes('--delete');

// Colors for terminal output
const colors = {
  info:    (msg) => `\x1b[34m[INFO]\x1b[0m  ${msg}`,
  success: (msg) => `\x1b[32m[OK]\x1b[0m    ${msg}`,
  warn:    (msg) => `\x1b[33m[WARN]\x1b[0m  ${msg}`,
  error:   (msg) => `\x1b[31m[ERROR]\x1b[0m ${msg}`,
  step:    (msg) => `\n\x1b[36m━━━ ${msg} ━━━\x1b[0m`,
};

// ---------------------------------------------------------------------------
// Initialize Firebase Admin
// ---------------------------------------------------------------------------
if (!DRY_RUN) {
  admin.initializeApp({
    projectId: orgConfig.firebaseProject,
  });
}

const db = DRY_RUN ? null : admin.firestore();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a document to Firestore (or print in dry-run mode).
 */
async function writeDoc(collectionPath, docId, data) {
  const fullPath = `${collectionPath}/${docId}`;

  if (DRY_RUN) {
    console.log(colors.info(`[DRY RUN] Would write: ${fullPath}`));
    console.log(JSON.stringify(data, null, 2));
    console.log('');
    return;
  }

  await db.collection(collectionPath).doc(docId).set(data, { merge: true });
  console.log(colors.success(`Written: ${fullPath}`));
}

/**
 * Delete all documents in a subcollection.
 */
async function deleteCollection(collectionPath) {
  if (DRY_RUN) {
    console.log(colors.info(`[DRY RUN] Would delete collection: ${collectionPath}`));
    return;
  }

  const snapshot = await db.collection(collectionPath).get();
  if (snapshot.empty) {
    console.log(colors.info(`Collection empty: ${collectionPath}`));
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  console.log(colors.warn(`Deleted ${snapshot.size} docs from: ${collectionPath}`));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const orgId = orgConfig.orgId;

  console.log(colors.step('Firestore Seeding — Pendragon Capital'));
  console.log(colors.info(`Org ID:    ${orgId}`));
  console.log(colors.info(`Project:   ${orgConfig.firebaseProject}`));
  console.log(colors.info(`Dry Run:   ${DRY_RUN}`));
  console.log('');

  // -------------------------------------------------------------------------
  // Optionally delete existing documents first
  // -------------------------------------------------------------------------
  if (DELETE_FIRST) {
    console.log(colors.step('Deleting Existing Documents'));
    await deleteCollection(`organizations/${orgId}/workspaces`);
    await deleteCollection(`organizations/${orgId}/bridges`);
    await deleteCollection(`organizations/${orgId}/contracts`);
  }

  // -------------------------------------------------------------------------
  // Seed: Organization document
  // -------------------------------------------------------------------------
  console.log(colors.step('Seeding Organization'));

  await writeDoc('organizations', orgId, {
    name: orgConfig.orgName,
    slug: orgConfig.orgSlug,
    gcpProject: orgConfig.gcpProject,
    clusterNamespace: orgConfig.clusterNamespace,
    redisUrl: orgConfig.redisUrl,
    dockerImage: orgConfig.dockerImage,
    defaultModel: orgConfig.defaultModel,
    createdAt: admin.firestore ? admin.firestore.FieldValue.serverTimestamp() : new Date().toISOString(),
    updatedAt: admin.firestore ? admin.firestore.FieldValue.serverTimestamp() : new Date().toISOString(),
  });

  // -------------------------------------------------------------------------
  // Seed: Workspaces
  // -------------------------------------------------------------------------
  console.log(colors.step('Seeding Workspaces'));

  for (const ws of workspaces) {
    await writeDoc(`organizations/${orgId}/workspaces`, ws.id, {
      name: ws.name,
      role: ws.role,
      aiProvider: ws.aiProvider,
      aiModel: ws.aiModel,
      deploymentName: ws.deploymentName,
      databaseName: ws.databaseName,
      url: ws.url,
      a2aApiKey: ws.a2aApiKey,
      domainType: ws.domainType || null,
      capabilities: ws.capabilities || [],
      status: 'active',
      createdAt: admin.firestore ? admin.firestore.FieldValue.serverTimestamp() : new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // Seed: Bridges
  // -------------------------------------------------------------------------
  console.log(colors.step('Seeding Bridges'));

  for (const bridge of bridges) {
    await writeDoc(`organizations/${orgId}/bridges`, bridge.bridgeId, {
      sourceWsId: bridge.sourceWsId,
      sourceName: bridge.sourceName,
      targetWsId: bridge.targetWsId,
      targetName: bridge.targetName,
      permissions: bridge.permissions,
      status: 'active',
      createdAt: admin.firestore ? admin.firestore.FieldValue.serverTimestamp() : new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // Seed: Contracts
  // -------------------------------------------------------------------------
  console.log(colors.step('Seeding Contracts'));

  for (const contract of contracts) {
    await writeDoc(`organizations/${orgId}/contracts`, contract.contractId, {
      type: contract.type,
      source: contract.source,
      target: contract.target,
      allowedActions: contract.allowedActions,
      status: contract.status,
      createdAt: admin.firestore ? admin.firestore.FieldValue.serverTimestamp() : new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(colors.step('Firestore Seeding Complete'));
  console.log('');
  console.log(colors.success(`Organization: ${orgConfig.orgName} (${orgId})`));
  console.log(colors.success(`Workspaces:   ${workspaces.length}`));
  console.log(colors.success(`Bridges:      ${bridges.length}`));
  console.log(colors.success(`Contracts:    ${contracts.length}`));
  console.log('');
}

// Run
main().catch((err) => {
  console.error(colors.error(`Fatal error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
