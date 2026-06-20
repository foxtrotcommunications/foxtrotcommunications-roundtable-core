# Pendragon Capital — Demo Setup

> Everything needed to rebuild the Pendragon demo organization from scratch on a brand-new environment.

## Overview

Pendragon Capital is the reference demo for the Roundtable multi-agent platform. It showcases a financial orchestration scenario with seven workspaces:

| Workspace | Role | AI Model | Domain |
|---|---|---|---|
| **Arthur** | Orchestrator | GPT-5.5 (OpenAI) | — |
| **Checking & Savings** | Domain Agent | Gemini 3.5 Flash | `checking` |
| **Debt Management** | Domain Agent | Gemini 3.5 Flash | `debt` |
| **Real Estate** | Domain Agent | Gemini 3.5 Flash | `realestate` |
| **Investments** | Domain Agent | Gemini 3.5 Flash | `investments` |
| **Retirement** | Domain Agent | Gemini 3.5 Flash | `retirement` |
| **Taxes** | Domain Agent | Gemini 3.5 Flash | `taxes` |

Arthur delegates user queries to domain workspaces over A2A bridges, governed by contracts that restrict which capabilities each domain may expose.

---

## Directory Structure

```
demo/
├── README.md                        # This file
├── config/
│   ├── org.json                     # Organization-level configuration
│   ├── workspaces.json              # All 7 workspace definitions
│   ├── bridges.json                 # A2A bridge definitions (Arthur → domains)
│   └── contracts.json               # Governance contracts (allowed actions)
├── sql/
│   ├── 00-schema-core.sql           # Core schema (users, messages, audit, etc.)
│   ├── 01-schema-plaid.sql          # Plaid domain schema (accounts, txns, liabilities)
│   ├── 02-schema-realestate.sql     # Real estate schema (properties, mortgages, valuations)
│   ├── 03-schema-investments.sql    # Investment domain schema (holdings, securities)
│   ├── seed-checking.sql            # Seed data for Checking & Savings workspace
│   ├── seed-debt.sql                # Seed data for Debt Management workspace
│   ├── seed-realestate.sql          # Seed data for Real Estate workspace
│   ├── seed-investments.sql         # Seed data for Investments workspace
│   ├── seed-retirement.sql          # Seed data for Retirement workspace
│   └── seed-taxes.sql               # Seed data for Taxes workspace
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
- `roles/bigquery.dataEditor` — create BigQuery tables for telemetry

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
for db in ws_fy6m0lu0kattxza3yo1r ws_narv6objpk50ajla6eed ws_jmdsbwmzzqelanlijcgq ws_qy339asobmooibkdw9mh ws_pk7mwxr2nq5vjbys8dfe ws_hn3clzv9st6wmgxa4bki ws_er8fdyu1kp4qjnzm7wco; do
  gcloud sql databases create "$db" --instance=roundtable-public-pg --project=roundtable-public
done
```

### Phase 3 — Schema Migrations

Apply the core schema to all workspaces, then domain-specific schemas:

```bash
# Core schema → all 7 databases
for db in ws_fy6m0lu0kattxza3yo1r ws_narv6objpk50ajla6eed ws_jmdsbwmzzqelanlijcgq ws_qy339asobmooibkdw9mh ws_pk7mwxr2nq5vjbys8dfe ws_hn3clzv9st6wmgxa4bki ws_er8fdyu1kp4qjnzm7wco; do
  psql -h 127.0.0.1 -U roundtable -d "$db" -f sql/00-schema-core.sql
done

# Plaid schema → Checking & Savings + Debt Management + Taxes
for db in ws_narv6objpk50ajla6eed ws_jmdsbwmzzqelanlijcgq ws_er8fdyu1kp4qjnzm7wco; do
  psql -h 127.0.0.1 -U roundtable -d "$db" -f sql/01-schema-plaid.sql
done

# Real Estate schema → Real Estate only
psql -h 127.0.0.1 -U roundtable -d ws_qy339asobmooibkdw9mh -f sql/02-schema-realestate.sql

# Investment schema → Investments + Retirement
for db in ws_pk7mwxr2nq5vjbys8dfe ws_hn3clzv9st6wmgxa4bki; do
  psql -h 127.0.0.1 -U roundtable -d "$db" -f sql/03-schema-investments.sql
done
```

### Phase 4 — Seed Data

```bash
psql -h 127.0.0.1 -U roundtable -d ws_narv6objpk50ajla6eed -f sql/seed-checking.sql
psql -h 127.0.0.1 -U roundtable -d ws_jmdsbwmzzqelanlijcgq -f sql/seed-debt.sql
psql -h 127.0.0.1 -U roundtable -d ws_qy339asobmooibkdw9mh -f sql/seed-realestate.sql
psql -h 127.0.0.1 -U roundtable -d ws_pk7mwxr2nq5vjbys8dfe -f sql/seed-investments.sql
psql -h 127.0.0.1 -U roundtable -d ws_hn3clzv9st6wmgxa4bki -f sql/seed-retirement.sql
psql -h 127.0.0.1 -U roundtable -d ws_er8fdyu1kp4qjnzm7wco -f sql/seed-taxes.sql
```

### Phase 5 — Kubernetes Deployments

The `setup.sh` script generates deployments from `config/workspaces.json`. Each workspace pod gets:

- `WORKSPACE_ID` — the Firestore document ID
- `DATABASE_URL` — Cloud SQL connection string (via proxy sidecar)
- `AI_PROVIDER` / `AI_MODEL` — the model configuration
- `REDIS_URL` — shared Redis instance
- `A2A_API_KEY` — workspace-to-workspace auth token

### Phase 6 — ConfigMaps

Apply Kustomize patches as ConfigMaps for infrastructure layering:

```bash
kubectl apply -f k8s/configmaps/a2a-server-patch.yaml      -n rt-pendragon-demo
kubectl apply -f k8s/configmaps/intent-bridge-patch.yaml   -n rt-pendragon-demo
kubectl apply -f k8s/configmaps/contract-auth-patch.yaml   -n rt-pendragon-demo
kubectl apply -f k8s/configmaps/aiprovider-patch.yaml      -n rt-pendragon-demo
```

### Phase 7 — Ingress

Apply the Ingress resource with one host rule per workspace:

```bash
kubectl apply -f k8s/ingress.yaml -n rt-pendragon-demo
```

Each workspace gets a subdomain under `pendragon-demo.ws.roundtable.foxtrotcommunications.net`.

### Phase 8 — Tracing (BigQuery)

Create the BigQuery dataset and table for request tracing:

```bash
bq mk --dataset roundtable-public:roundtable_telemetry
bq mk --table roundtable-public:roundtable_telemetry.request_traces \
  trace_id:STRING,workspace_id:STRING,request_type:STRING,duration_ms:INTEGER,created_at:TIMESTAMP
```

### Phase 9 — Firestore Seeding

```bash
node scripts/seed-firestore.js
```

This writes workspace, bridge, and contract documents under the org path in Firestore.

### Phase 10 — Verification

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
| Investments WS | `pK7mWxR2nQ5vJbYs8dFe` |
| Retirement WS | `hN3cLzV9sT6wMgXa4bKi` |
| Taxes WS | `eR8fDyU1kP4qJnZm7wCo` |
| K8s Namespace | `rt-pendragon-demo` |
| GCP Project | `roundtable-public` |
| Redis | `redis://10.253.40.203:6379` |
| BigQuery Dataset | `roundtable_telemetry` |

---

## Troubleshooting

### Pods stuck in `CrashLoopBackOff`
Check that the Cloud SQL databases exist and the schema has been applied. The app will fail to start if it cannot connect to its database.

### Bridges not working
Verify that Firestore bridge documents exist and that the A2A API keys in the workspace pods match the keys in Firestore.

### Missing data
Re-run `./scripts/seed-db.sh` to repopulate seed data without affecting the schema.
