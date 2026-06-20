# Pendragon Capital — Demo Setup

> Everything needed to rebuild the Pendragon demo organization from scratch on a brand-new environment.

## Overview

Pendragon Capital is the reference demo for the Roundtable multi-agent platform. It showcases a financial orchestration scenario with four workspaces:

| Workspace | Role | AI Model | Domain |
|---|---|---|---|
| **Arthur** | Orchestrator | GPT-5.5 (OpenAI) | — |
| **Checking & Savings** | Domain Agent | Gemini 3.5 Flash | `checking` |
| **Debt Management** | Domain Agent | Gemini 3.5 Flash | `debt` |
| **Real Estate** | Domain Agent | Gemini 3.5 Flash | `realestate` |

Arthur delegates user queries to domain workspaces over A2A bridges, governed by contracts that restrict which capabilities each domain may expose.

---

## Directory Structure

```
demo/
├── README.md                        # This file
├── config/
│   ├── org.json                     # Organization-level configuration
│   ├── workspaces.json              # All 4 workspace definitions
│   ├── bridges.json                 # A2A bridge definitions (Arthur → domains)
│   └── contracts.json               # Governance contracts (allowed actions)
├── sql/
│   ├── 00-schema-core.sql           # Core schema (users, messages, audit, etc.)
│   ├── 01-schema-plaid.sql          # Plaid domain schema (accounts, txns, liabilities)
│   ├── 02-schema-realestate.sql     # Real estate schema (properties, mortgages, valuations)
│   ├── seed-checking.sql            # Seed data for Checking & Savings workspace
│   ├── seed-debt.sql                # Seed data for Debt Management workspace
│   └── seed-realestate.sql          # Seed data for Real Estate workspace
└── scripts/
    ├── setup.sh                     # Full end-to-end setup (k8s, SQL, Firestore)
    ├── seed-db.sh                   # Seed only the Cloud SQL databases
    ├── seed-firestore.js            # Seed Firestore (workspaces, bridges, contracts)
    ├── verify.sh                    # Verify all pods, databases, and bridges
    └── teardown.sh                  # Tear down everything
```

---

## Prerequisites

1. **gcloud CLI** — authenticated with access to `roundtable-public` project
2. **kubectl** — configured for the target GKE cluster
3. **Node.js ≥ 18** — for the Firestore seeding script
4. **Cloud SQL Proxy** — for local database access during setup
5. **jq** — for JSON parsing in shell scripts
6. **psql** — PostgreSQL client for running SQL migrations

### GCP Permissions Required

- `roles/cloudsql.admin` — create databases
- `roles/container.developer` — manage GKE resources
- `roles/datastore.user` — write to Firestore
- `roles/artifactregistry.reader` — pull Docker images

---

## Quick Start

```bash
# 1. Clone the repo (if you haven't already)
git clone git@github.com:foxtrotcommunications/foxtrotcommunications-roundtable-core.git
cd foxtrotcommunications-roundtable-core/demo

# 2. Install Node dependencies for Firestore seeding
npm install firebase-admin

# 3. Make scripts executable
chmod +x scripts/*.sh

# 4. Run the full setup
./scripts/setup.sh

# 5. Verify everything is running
./scripts/verify.sh
```

---

## Step-by-Step Manual Setup

If you prefer to run each phase individually:

### Phase 1 — Kubernetes Namespace

```bash
kubectl create namespace rt-pendragon-demo
```

### Phase 2 — Cloud SQL Databases

Create one database per workspace:

```bash
for db in ws_fy6m0lu0kattxza3yo1r ws_narv6objpk50ajla6eed ws_jmdsbwmzzqelanlijcgq ws_qy339asobmooibkdw9mh; do
  gcloud sql databases create "$db" --instance=roundtable-public-pg --project=roundtable-public
done
```

### Phase 3 — Schema Migrations

Apply the core schema to all workspaces, then domain-specific schemas:

```bash
# Core schema → all 4 databases
for db in ws_fy6m0lu0kattxza3yo1r ws_narv6objpk50ajla6eed ws_jmdsbwmzzqelanlijcgq ws_qy339asobmooibkdw9mh; do
  psql -h 127.0.0.1 -U roundtable -d "$db" -f sql/00-schema-core.sql
done

# Plaid schema → Checking & Savings + Debt Management
for db in ws_narv6objpk50ajla6eed ws_jmdsbwmzzqelanlijcgq; do
  psql -h 127.0.0.1 -U roundtable -d "$db" -f sql/01-schema-plaid.sql
done

# Real Estate schema → Real Estate only
psql -h 127.0.0.1 -U roundtable -d ws_qy339asobmooibkdw9mh -f sql/02-schema-realestate.sql
```

### Phase 4 — Seed Data

```bash
psql -h 127.0.0.1 -U roundtable -d ws_narv6objpk50ajla6eed -f sql/seed-checking.sql
psql -h 127.0.0.1 -U roundtable -d ws_jmdsbwmzzqelanlijcgq -f sql/seed-debt.sql
psql -h 127.0.0.1 -U roundtable -d ws_qy339asobmooibkdw9mh -f sql/seed-realestate.sql
```

### Phase 5 — Kubernetes Deployments

The `setup.sh` script generates deployments from `config/workspaces.json`. Each workspace pod gets:

- `WORKSPACE_ID` — the Firestore document ID
- `DATABASE_URL` — Cloud SQL connection string (via proxy sidecar)
- `AI_PROVIDER` / `AI_MODEL` — the model configuration
- `REDIS_URL` — shared Redis instance
- `A2A_API_KEY` — workspace-to-workspace auth token

### Phase 6 — Firestore Seeding

```bash
node scripts/seed-firestore.js
```

This writes workspace, bridge, and contract documents under the org path in Firestore.

### Phase 7 — Verification

```bash
./scripts/verify.sh
```

---

## Teardown

To completely remove the demo:

```bash
./scripts/teardown.sh
```

> [!CAUTION]
> Teardown is destructive and irreversible. It deletes the Kubernetes namespace, Cloud SQL databases, and all Firestore documents for the Pendragon org.

---

## Key IDs Reference

| Resource | ID |
|---|---|
| Org ID | `kyrbKRYXptDQTCeCa9lG` |
| Arthur WS | `FY6M0lU0katTXza3Yo1r` |
| Checking & Savings WS | `Narv6OBjpk50aJla6eED` |
| Debt Management WS | `jmdsbwMzZqelAnliJcGQ` |
| Real Estate WS | `Qy339ASoBmooIBKdw9mH` |
| K8s Namespace | `rt-pendragon-demo` |
| GCP Project | `roundtable-public` |
| Redis | `redis://10.253.40.203:6379` |

---

## Troubleshooting

### Pods stuck in `CrashLoopBackOff`
Check that the Cloud SQL databases exist and the schema has been applied. The app will fail to start if it cannot connect to its database.

### Bridges not working
Verify that Firestore bridge documents exist and that the A2A API keys in the workspace pods match the keys in Firestore.

### Missing data
Re-run `./scripts/seed-db.sh` to repopulate seed data without affecting the schema.
