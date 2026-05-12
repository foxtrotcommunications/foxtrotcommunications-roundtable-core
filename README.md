# 🎙️ Roundtable

**Real-time multiplayer AI workspace platform.**

Multiple users collaborate on AI conversations in real-time — with built-in tools for querying data warehouses, executing code, and managing files. Each workspace is an isolated container with its own AI, tools, and persistent storage.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-98%20passing-brightgreen.svg)](#testing)

## Features

- **Multiplayer AI Chat** — Multiple users in the same AI conversation, streaming in real-time
- **Multi-Provider AI** — OpenAI, Anthropic (Claude), and Google Gemini (via Vertex AI)
- **14 Built-in Tools** — Web search, data warehouse queries, file management, shell execution, and more
- **Data Warehouse Queries** — AI can query BigQuery, Snowflake, and Databricks in real-time
- **Workspace-per-Container** — Each workspace is an isolated container with its own identity
- **Multi-Cloud** — Deploy on Cloud Run, GKE, EKS, AKS, or any Kubernetes cluster
- **BYOK** — Bring Your Own Key; users configure their own API keys, or use server-level defaults
- **Presence** — See who's online in each workspace
- **Streaming** — AI responses stream token-by-token to all participants
- **Embeddable** — Embed in other apps via iframe with `EMBED_MODE=true`
- **No Build Step** — Pure HTML/CSS/JS frontend, zero build toolchain

## Quick Start

```bash
# Clone
git clone https://github.com/foxtrotcommunications/foxtrotcommunications-roundtable.git
cd foxtrotcommunications-roundtable

# Configure
cp .env.example .env
# Edit .env: set SESSION_SECRET, DATABASE_URL, and optional AI API keys

# Install & run
npm install
npm run dev

# Open http://localhost:3000
```

### Prerequisites

- **Node.js** 20+ (tested on Node 25)
- **PostgreSQL** — required for session and data persistence

## Deployment

### Docker

```bash
docker build -t roundtable:latest .
docker run -p 3000:3000 --env-file .env roundtable:latest
```

### Cloud Run (Google Cloud)

```bash
./deploy-cloudrun.sh
```

### GKE (Google Kubernetes Engine)

```bash
# First time: creates Autopilot cluster, IAM, secrets, nginx-ingress
./deploy-gke.sh --setup

# Deploy a workspace
./deploy-gke.sh dev Development
./deploy-gke.sh backend "Backend Team"
```

### Any Kubernetes Cluster (EKS, AKS, bare metal)

```bash
# Apply shared config
kubectl apply -f k8s/base/config.yaml

# Create secrets
kubectl create secret generic roundtable-secrets \
  --from-literal=SESSION_SECRET=$(openssl rand -hex 32) \
  --from-literal=DATABASE_URL="postgresql://user:pass@host:5432/roundtable"

# Deploy a workspace
./deploy-k8s.sh dev Development
```

See [`k8s/overlays/tls/`](k8s/overlays/tls/) for HTTPS setup with cert-manager + Let's Encrypt.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `SESSION_SECRET` | (required in prod) | Secret for session cookies |
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| `WORKSPACE_ID` | `default` | Unique workspace identity |
| `WORKSPACE_NAME` | `Roundtable` | Display name for the workspace |
| `EMBED_MODE` | `false` | Allow iframe embedding |
| `SECURE_COOKIES` | `true` in prod | Set `false` for HTTP-only deployments |

### AI Providers

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Server-level OpenAI key |
| `ANTHROPIC_API_KEY` | Server-level Anthropic key |
| `GOOGLE_AI_API_KEY` | Server-level Google AI key |
| `GCP_PROJECT` | GCP project for Vertex AI (uses ADC, no key needed) |
| `GCP_LOCATION` | Vertex AI region (default: `us-central1`) |

### Data Warehouses

| Variable | Description |
|----------|-------------|
| `GCP_PROJECT` | BigQuery — uses same ADC as Vertex AI |
| `BQ_MAX_BYTES` | BigQuery — max bytes scanned per query (default: 1GB) |
| `SNOWFLAKE_ACCOUNT` | Snowflake account identifier |
| `SNOWFLAKE_USERNAME` | Snowflake username |
| `SNOWFLAKE_PASSWORD` | Snowflake password |
| `SNOWFLAKE_WAREHOUSE` | Snowflake compute warehouse |
| `SNOWFLAKE_DATABASE` | Default Snowflake database |
| `DATABRICKS_HOST` | Databricks workspace URL |
| `DATABRICKS_TOKEN` | Databricks personal access token |
| `DATABRICKS_HTTP_PATH` | SQL warehouse HTTP path |
| `DATABRICKS_CATALOG` | Default Unity Catalog |

See [`.env.example`](.env.example) for the full list.

## Built-in Tools

| Tool | Description |
|------|-------------|
| **web_search** | Search the web via Google Custom Search or Vertex AI grounding |
| **read_url** | Fetch and extract text from web pages |
| **calculator** | Evaluate math expressions (powered by mathjs) |
| **run_code** | Execute JavaScript in a sandboxed environment |
| **query_bigquery** | Query Google BigQuery (read-only, max 1000 rows) |
| **query_snowflake** | Query Snowflake (read-only, max 1000 rows) |
| **query_databricks** | Query Databricks SQL Warehouse (read-only, max 1000 rows) |
| **shell_exec** | Execute allowlisted shell commands in the workspace |
| **read_file** | Read files from the workspace directory |
| **write_file** | Write files to the workspace directory |
| **list_files** | List files in the workspace directory |
| **find_file** | Search for files by name |
| **git_clone** | Clone a git repository into the workspace |
| **git_commit** | Stage and commit changes |

Data warehouse tools enforce **read-only access** — INSERT, UPDATE, DELETE, DROP, and other write operations are blocked at the tool level.

## Architecture

```
Browser (Vanilla JS + Socket.IO)
    ↕ WebSocket
Express + Socket.IO Server
    ↕                    ↕                        ↕
PostgreSQL          AI Providers              Data Warehouses
(sessions,      (OpenAI / Anthropic /      (BigQuery / Snowflake /
 messages,       Vertex AI Gemini)          Databricks)
 workspaces)
```

```
Deployment model (workspace-per-container):

┌─────────────────────────┐
│  Cloud Run / GKE / EKS  │
├─────────────────────────┤
│ ┌─────────┐ ┌─────────┐ │
│ │ rt-dev  │ │rt-backend│ │    Each workspace = 1 container
│ │ :3000   │ │ :3000   │ │    All share the same PostgreSQL
│ └────┬────┘ └────┬────┘ │
│      │           │      │
│      └─────┬─────┘      │
│            ▼            │
│     ┌────────────┐      │
│     │ PostgreSQL │      │
│     └────────────┘      │
└─────────────────────────┘
```

- **Backend**: Node.js 20, Express, Socket.IO
- **Database**: PostgreSQL (sessions, messages, workspace registry)
- **Frontend**: Vanilla HTML/CSS/JS (no build step)
- **Real-time**: Socket.IO for WebSocket communication
- **Container**: Alpine-based Docker image (~60MB)

## Testing

```bash
npm test
```

98 tests across 8 suites:

| Suite | Tests | Coverage |
|-------|-------|----------|
| Shell execution security | 18 | Allowlist, dangerous patterns, path traversal |
| Data warehouse tools | 42 | SQL safety for BigQuery, Snowflake, Databricks |
| File tools | 10 | Read, write, list, find + path traversal |
| Calculator | 8 | Arithmetic, trig, units, stats |
| URL reader | 5 | Fetch, HTML stripping, truncation |
| Auth middleware | 4 | Session validation |
| Config | 9 | Environment variable parsing |
| DB adapter | 2 | Export validation |

## Kubernetes Structure

```
k8s/
├── base/                        # Cloud-agnostic (works anywhere)
│   ├── workspace.yaml           # StatefulSet + Service template
│   ├── config.yaml              # ConfigMap + secret instructions
│   └── ingress.yaml             # nginx-ingress with WebSocket support
└── overlays/
    ├── gcp/                     # Google Cloud specific
    │   └── workspace.yaml       # Adds Cloud SQL proxy + Workload Identity
    └── tls/                     # HTTPS (any cloud)
        ├── issuer.yaml          # Let's Encrypt ClusterIssuer
        └── ingress-tls.yaml     # TLS-enabled ingress
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Run tests (`npm test`)
4. Commit your changes (`git commit -m 'Add my feature'`)
5. Push to the branch (`git push origin feature/my-feature`)
6. Open a Pull Request

## License

[Apache License 2.0](LICENSE)

---

_Built by [Foxtrot Communications](https://foxtrotcommunications.net)_
