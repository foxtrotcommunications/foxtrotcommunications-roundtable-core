# 🎙️ Roundtable

**Real-time multiplayer AI workspace platform.**

Multiple users collaborate on AI conversations in real-time — with built-in tools for querying data warehouses, executing code, and managing files. Each workspace is an isolated container with its own AI, tools, and persistent storage.

Roundtable is designed as a **platform for agent orchestration** — connect your own A2A agents, MCP servers, or custom tools and let the AI route between them. Build agents in any language, deploy them anywhere, and plug them into a shared workspace where your whole team works together.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-98%20passing-brightgreen.svg)](#testing)

## Quick Start

**Zero config. No database. No `.env` file.**

```bash
git clone https://github.com/foxtrotcommunications/foxtrotcommunications-roundtable-core.git
cd foxtrotcommunications-roundtable-core
npm install
npm run dev

# Open http://localhost:3000
```

Roundtable auto-detects the environment: if no `DATABASE_URL` is set, it uses SQLite and in-memory sessions for instant local development.

### Three Deployment Paths

| Path | Database | Command | Time | Use Case |
|------|----------|---------|------|----------|
| **Local dev** | SQLite (auto) | `npm run dev` | ~3 min | Development, testing, evaluation |
| **Docker quickstart** | PostgreSQL (compose) | `docker compose -f docker-compose.quickstart.yml up` | ~3 min | Quick demo on a VM |
| **GKE production** | PostgreSQL (Cloud SQL) | `./deploy-gke.sh dev Development` | ~5 min | Enterprise deployment |

### Prerequisites

- **Node.js** 20+ (tested on Node 20, 22)
- **PostgreSQL** — required only for production (local dev uses SQLite automatically)

## Features

- **Multiplayer AI Chat** — Multiple users in the same AI conversation, streaming in real-time
- **Concurrent Generation** — Each user has an independent AI generation lifecycle; multiple people can prompt AI simultaneously without blocking each other
- **Multi-Provider AI** — OpenAI, Anthropic (Claude), Google Gemini (via Vertex AI or API key), and Ollama (local models, OpenAI-compatible)
- **14 Built-in Tools** — Web search, data warehouse queries, file management, shell execution, and more
- **Configurable Tool Set** — Enable or disable individual tools per workspace via the Settings panel
- **Configurable Agent** — Set the AI provider, model, and system prompt per workspace — no redeploy needed
- **Data Warehouse Queries** — AI can query BigQuery, Snowflake, and Databricks in real-time
- **Workspace-per-Container** — Each workspace is an isolated container with its own identity
- **Workspace Bridges** — Open cross-workspace channels for AI-mediated collaboration between teams
- **A2A Agent Protocol** — Plug in external agents built in any language via the A2A standard
- **Multi-Cloud** — Deploy on Cloud Run, GKE, EKS, AKS, or any Kubernetes cluster
- **BYOK** — Bring Your Own Key; users configure their own API keys, or use server-level defaults
- **Presence** — See who's online in each workspace
- **Streaming** — AI responses stream token-by-token to all participants
- **Embeddable** — Embed in other apps via iframe with `EMBED_MODE=true`
- **React + TypeScript** — Modern frontend with Vite, hot-reload dev server

## Deployment

### Docker Quickstart (VM)

Pull a pre-built image — no source build required. Port 80, `http://<vm-ip>` just works.

```bash
curl -O https://raw.githubusercontent.com/foxtrotcommunications/foxtrotcommunications-roundtable-core/main/docker-compose.quickstart.yml
docker compose -f docker-compose.quickstart.yml up
```

### Docker (Build from Source)

```bash
docker build -t roundtable:latest .
docker run -p 3000:3000 --env-file .env roundtable:latest
```

### Docker Compose (Full Stack)

```bash
docker compose up
```

Starts Roundtable + PostgreSQL. Edit `docker-compose.yml` to configure AI keys and workspace settings.

### Local Models (Ollama)

Run AI models locally with [Ollama](https://ollama.com) — no API keys, no cost, fully offline.

```bash
# Start Roundtable + Ollama with GPU support
docker compose -f docker-compose.yml -f docker-compose.ollama.yml up

# Pull a model
docker compose exec ollama ollama pull llama3.1:8b
```

Then set the provider to **Ollama** in Settings. Works with any OpenAI-compatible endpoint (vLLM, LM Studio, Groq, Together AI, etc.) — just enter the host URL.

Each workspace can point at a different Ollama instance, enabling per-team model and GPU isolation.

### GKE (Google Kubernetes Engine)

```bash
# First time: creates Autopilot cluster, IAM, secrets, nginx-ingress
GCP_PROJECT=your-project ./deploy-gke.sh --setup

# Deploy a workspace
GCP_PROJECT=your-project ./deploy-gke.sh dev Development
GCP_PROJECT=your-project ./deploy-gke.sh backend "Backend Team"
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
| `SESSION_SECRET` | dev default | Secret for session cookies (required in production) |
| `DATABASE_URL` | (none) | PostgreSQL connection string. If unset, uses SQLite for local dev |
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
| `OLLAMA_HOST` | Default Ollama host URL (default: `http://localhost:11434`, overridable per-workspace) |

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

## Workspace Settings

Each workspace can be configured at runtime via the **⚙️ Settings panel** (no redeploy required):

### AI Agent tab

| Setting | Description |
|---------|-------------|
| **Provider** | `vertexai` \| `openai` \| `anthropic` \| `google` |
| **Model** | Any model supported by the selected provider (e.g. `gemini-2.0-flash-001`, `gpt-4o`, `claude-opus-4-5`) |
| **System Prompt** | Custom instructions prepended to every AI conversation in this workspace |

### Tools tab

Enable or disable individual tools per workspace. Disabled tools are removed from the AI's context entirely — the model won't attempt to call them. Tools are grouped by category:

- **Web**: `web_search`, `read_url`
- **Code**: `run_code`, `shell_exec`, `calculator`
- **Files**: `read_file`, `write_file`, `list_files`, `find_file`
- **Git**: `git_clone`, `git_commit`
- **Data**: `query_bigquery`, `query_snowflake`, `query_databricks`

> **Tip**: For workspaces focused on data analysis, disable `shell_exec`, `git_clone`, and `git_commit` to reduce the AI's tool surface and improve response focus.

### API Keys tab

Users can configure personal API keys (OpenAI, Anthropic, Google AI) that override server-level defaults for their sessions.

## Built-in Tools

All 14 tools are enabled by default. Individual tools can be toggled per workspace via the Settings panel.

| Tool | Description |
|------|-------------|
| **web_search** | Search the web via Google Custom Search or Vertex AI grounding |
| **read_url** | Fetch and extract text from web pages |
| **calculator** | Evaluate math expressions (powered by mathjs) |
| **run_code** | Execute JavaScript in a sandboxed environment |
| **query_bigquery** | Query Google BigQuery (read-only, max 100 rows) |
| **query_snowflake** | Query Snowflake (read-only, max 100 rows) |
| **query_databricks** | Query Databricks SQL Warehouse (read-only, max 100 rows) |
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
Browser (React + Socket.IO)
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

┌─────────────────────────────────────────┐
│         Cloud Run / GKE / EKS           │
├─────────────────────────────────────────┤
│ ┌───────────┐ ┌───────────┐ ┌────────┐ │
│ │ rt-dev    │ │ rt-backend│ │ rt-ops │ │   Each workspace = 1 container
│ │ :3000     │ │ :3000     │ │ :3000  │ │   All share the same PostgreSQL
│ └─────┬─────┘ └─────┬─────┘ └───┬────┘ │
│       │             │           │       │
│       └──────┬──────┘───────────┘       │
│              ▼                          │
│       ┌────────────┐                    │
│       │ PostgreSQL │                    │
│       └────────────┘                    │
│              ▲                          │
│       ┌──────┴──────┐                   │
│       │  A2A Agents │  External agents  │
│       │  MCP Servers│  plug in here     │
│       └─────────────┘                   │
└─────────────────────────────────────────┘
```

- **Backend**: Node.js 20, Express, Socket.IO
- **Database**: PostgreSQL (production) or SQLite (local dev)
- **Frontend**: React + TypeScript (Vite, `client/dist/`)
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
