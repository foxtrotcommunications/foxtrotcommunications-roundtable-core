# Pendragon Capital — Demo Setup

> Everything needed to rebuild the Pendragon demo organization from scratch on a brand-new environment.

## Overview

Pendragon Capital is the reference demo for the Roundtable multi-agent platform. It showcases a financial orchestration scenario with eight workspaces:

| Workspace | Role | AI Model | Domain |
|---|---|---|---|
| **Arthur** | Orchestrator | GPT-5.5 (OpenAI) | — |
| **Checking & Savings** | Domain Agent | Gemini 3.5 Flash | `checking` |
| **Debt Management** | Domain Agent | Gemini 3.5 Flash | `debt` |
| **Real Estate** | Domain Agent | Gemini 3.5 Flash | `realestate` |
| **Investments** | Domain Agent | Gemini 3.5 Flash | `investments` |
| **Retirement** | Domain Agent | Gemini 3.5 Flash | `retirement` |
| **Taxes** | Domain Agent | Gemini 3.5 Flash | `taxes` |
| **Demographics** | Domain Agent | Gemini 3.5 Flash | `demographics` |

Arthur delegates user queries to domain workspaces over A2A bridges, governed by contracts that restrict which capabilities each domain may expose.

---

## Directory Structure

```
demo/
├── README.md                        # This file
├── config/
│   ├── org.json                     # Organization-level configuration
│   ├── workspaces.json              # All 8 workspace definitions + system prompts
│   ├── bridges.json                 # A2A bridge definitions (Arthur → domains)
│   └── contracts.json               # Governance contracts (allowed actions)
├── sql/
│   ├── 00-schema-core.sql           # Core schema (users, messages, audit, etc.)
│   ├── 01-schema-plaid.sql          # Plaid domain schema (accounts, txns, liabilities)
│   ├── 02-schema-realestate.sql     # Real estate schema (properties, mortgages, valuations)
│   ├── 03-schema-investments.sql    # Investment domain schema (holdings, securities)
│   ├── 04-schema-demographics.sql   # Demographics domain schema (profiles, households)
│   ├── seed-checking.sql            # Seed data for Checking & Savings workspace
│   ├── seed-debt.sql                # Seed data for Debt Management workspace
│   ├── seed-realestate.sql          # Seed data for Real Estate workspace
│   ├── seed-investments.sql         # Seed data for Investments workspace
│   ├── seed-retirement.sql          # Seed data for Retirement workspace
│   ├── seed-taxes.sql               # Seed data for Taxes workspace
│   ├── seed-demographics.sql        # Seed data for Demographics workspace
│   ├── seed-goals-checking.sql      # Financial goals for Checking & Savings
│   ├── seed-goals-debt.sql          # Financial goals for Debt Management
│   ├── seed-goals-investments.sql   # Financial goals for Investments
│   ├── seed-goals-realestate.sql    # Financial goals for Real Estate
│   ├── seed-goals-retirement.sql    # Financial goals for Retirement
│   └── seed-goals-taxes.sql         # Financial goals for Taxes
├── tools/
│   └── demographics-tools.js        # Custom tools for demographics domain
└── scripts/
    ├── setup.sh                     # Full end-to-end setup (k8s, SQL, Firestore)
    ├── seed-db.sh                   # Seed databases + sync workspace settings
    ├── sync-settings.sh             # Push workspace settings to PostgreSQL
    ├── seed-firestore.js            # Seed Firestore (workspaces, bridges, contracts)
    ├── provision-domains.js         # Provision new domains via Roundtable API
    ├── verify.sh                    # Verify all pods, databases, bridges, and settings
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

## Managing Deployed State

The `config/` directory is the **single source of truth** for the demo. When you change anything in config (system prompts, AI models, contracts, etc.), push those changes to the live environment:

```bash
# Sync system prompts and AI settings to all workspace databases
./scripts/sync-settings.sh

# Sync only a single workspace (e.g., after editing Arthur's system prompt)
./scripts/sync-settings.sh --workspace Arthur

# Sync only system prompts (skip AI provider/model)
./scripts/sync-settings.sh --prompt-only

# Preview what would change without modifying anything
./scripts/sync-settings.sh --dry-run

# Full re-seed: schema + domain data + workspace settings
./scripts/seed-db.sh

# Update Firestore (bridges, contracts, capabilities)
node scripts/seed-firestore.js
```

> [!IMPORTANT]
> After changing `workspaces.json`, always run `sync-settings.sh` to push settings to the live databases. System prompts, AI provider, and AI model are stored in each workspace's PostgreSQL database and are **not** automatically synced from config.

### Goal Seeding

Financial goals are seeded separately from domain data. Each domain has a `seed-goals-*.sql` file:

```bash
# Seed goals for a specific domain (via Cloud SQL proxy)
psql -h 127.0.0.1 -p 5432 -U roundtable -d ws_<db_name> -f sql/seed-goals-checking.sql
```

- Goal IDs follow the pattern: `goal_demo_<domain>_<name>` (e.g., `goal_demo_chk_emergency`)
- All seed goals are tagged with `parameters->>'demo_seed' = 'true'`
- SQL uses `INSERT ... ON CONFLICT UPDATE` for idempotent re-seeding

### Full Demo Rebuild

To fully rebuild the demo from scratch (e.g., after database corruption or schema changes):

```bash
# 1. Seed domain databases (schema + accounts/transactions/balances)
./scripts/seed-db.sh

# 2. Seed financial goals for all domains
for f in sql/seed-goals-*.sql; do
  domain=$(echo $f | sed 's/.*seed-goals-\(.*\)\.sql/\1/')
  psql -h 127.0.0.1 -p 5432 -U roundtable -d ws_<${domain}_db> -f $f
done

# 3. Sync workspace settings (system prompts, AI provider/model)
./scripts/sync-settings.sh

# 4. Reconcile governance contracts
npx ts-node scripts/reconcile-demo-contracts.ts

# 5. Rolling restart to clear stale manifest caches
kubectl rollout restart deployment -n rt-pendragon-demo
```

> [!TIP]
> For quick data refreshes without touching schema, just re-run steps 1-2 and restart.

---

## Key IDs Reference

| Resource | ID |
|---|---|
| Org ID | `kyrbKRYXptDQTCeCa9lG` |
| Arthur WS | `FY6M0lU0katTXza3Yo1r` |
| Checking & Savings WS | `Narv6OBjpk50aJla6eED` |
| Debt Management WS | `jmdsbwMzZqelAnliJcGQ` |
| Real Estate WS | `Qy339ASoBmooIBKdw9mH` |
| Investments WS | `lYjs7ZeDanzC1FDiO3es` |
| Retirement WS | `b0njzeX7q4JZ3KeLyASx` |
| Taxes WS | `4x5OQpZSA29iLJIrhmAC` |
| Demographics WS | `DemoGraphicsWs01xYz` |
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

### Goals missing or duplicated
Goal seed SQL uses `INSERT ... ON CONFLICT UPDATE`, so re-running is safe. If goals appear duplicated, check whether multiple seed runs used different ID patterns. Clean up with:
```sql
DELETE FROM goals WHERE parameters->>'demo_seed' = 'true';
```
Then re-seed.
