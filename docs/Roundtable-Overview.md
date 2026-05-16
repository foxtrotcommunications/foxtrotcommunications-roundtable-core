---
pdf_options:
  format: Letter
  margin: 25mm
  displayHeaderFooter: true
  headerTemplate: '<div style="font-size:9px; width:100%; padding:0 25mm; color:#666; display:flex; justify-content:space-between;"><span>Roundtable — Multiplayer AI Workspace Platform</span><span>Foxtrot Communications</span></div>'
  footerTemplate: '<div style="font-size:9px; width:100%; text-align:center; color:#999;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
stylesheet: https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown.min.css
body_class: markdown-body
css: |-
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
  .markdown-body { max-width: none; }
  h1 { border-bottom: 2px solid #6366f1; padding-bottom: 8px; }
  h2 { border-bottom: 1px solid #e1e4e8; padding-bottom: 6px; margin-top: 28px; }
  code { background: #f0f0f5; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  pre { background: #1e1e2e; color: #cdd6f4; padding: 16px; border-radius: 8px; }
  pre code { background: none; color: inherit; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d0d7de; padding: 8px 12px; text-align: left; }
  th { background: #f6f8fa; font-weight: 600; }
  blockquote { border-left: 4px solid #6366f1; padding: 4px 16px; color: #57606a; background: #f8f8fc; }
  a { color: #6366f1; }
  img { display: none; }
---

# 🎙️ Roundtable

**Real-time multiplayer AI workspace platform.**

Multiple users collaborate on AI conversations in real-time — with built-in tools for querying data warehouses, executing code, and managing files. Each workspace is an isolated container with its own AI, tools, and persistent storage.

Roundtable is designed as a **platform for agent orchestration** — connect your own A2A agents, MCP servers, or custom tools and let the AI route between them. Build agents in any language, deploy them anywhere, and plug them into a shared workspace where your whole team works together.

## Quick Start

**Zero config. No database. No `.env` file.**

```bash
git clone https://github.com/foxtrotcommunications/foxtrotcommunications-roundtable.git
cd foxtrotcommunications-roundtable
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

## Features

- **Multiplayer AI Chat** — Multiple users in the same AI conversation, streaming in real-time
- **Concurrent Generation** — Each user has an independent AI generation lifecycle; multiple people can prompt AI simultaneously without blocking each other
- **Multi-Provider AI** — OpenAI, Anthropic (Claude), and Google Gemini (via Vertex AI or direct API key)
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
│ │ rt-dev    │ │ rt-backend│ │ rt-ops │ │  Each workspace = 1 container
│ │ :3000     │ │ :3000     │ │ :3000  │ │  All share the same PostgreSQL
│ └─────┬─────┘ └─────┬─────┘ └───┬────┘ │
│       │             │           │       │
│       └──────┬──────┘───────────┘       │
│              ▼                          │
│       ┌────────────┐                    │
│       │ PostgreSQL │                    │
│       └────────────┘                    │
│              ▲                          │
│       ┌──────┴──────┐                   │
│       │  A2A Agents │ External agents   │
│       │  MCP Servers│ plug in here      │
│       └─────────────┘                   │
└─────────────────────────────────────────┘
```

## Built-in Tools

All 14 tools are enabled by default. Individual tools can be toggled per workspace.

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

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `SESSION_SECRET` | dev default | Secret for session cookies (required in production) |
| `DATABASE_URL` | (none) | PostgreSQL connection string. If unset, uses SQLite for local dev |
| `WORKSPACE_ID` | `default` | Unique workspace identity |
| `WORKSPACE_NAME` | `Roundtable` | Display name for the workspace |
| `EMBED_MODE` | `false` | Allow iframe embedding |

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
| `SNOWFLAKE_ACCOUNT` | Snowflake account identifier |
| `SNOWFLAKE_USERNAME` / `PASSWORD` | Snowflake credentials |
| `DATABRICKS_HOST` | Databricks workspace URL |
| `DATABRICKS_TOKEN` | Databricks personal access token |

## Workspace Settings

Each workspace can be configured at runtime via the **Settings panel** (no redeploy required):

- **AI Agent**: Provider, model, and system prompt
- **Tools**: Enable or disable individual tools per workspace
- **API Keys**: Users can configure personal API keys that override server defaults

## Testing

```bash
npm test
```

98 tests across 8 suites covering shell execution security, SQL safety for all three data warehouse tools, file operations, authentication, and configuration parsing.

## Deployment Options

### Docker Quickstart (VM)

```bash
curl -O https://raw.githubusercontent.com/foxtrotcommunications/foxtrotcommunications-roundtable/main/docker-compose.quickstart.yml
docker compose -f docker-compose.quickstart.yml up
```

### GKE (Google Kubernetes Engine)

```bash
GCP_PROJECT=your-project ./deploy-gke.sh --setup
GCP_PROJECT=your-project ./deploy-gke.sh dev Development
```

### Any Kubernetes Cluster

```bash
kubectl apply -f k8s/base/config.yaml
kubectl create secret generic roundtable-secrets \
  --from-literal=SESSION_SECRET=$(openssl rand -hex 32) \
  --from-literal=DATABASE_URL="postgresql://user:pass@host:5432/roundtable"
./deploy-k8s.sh dev Development
```

## License

Apache License 2.0

---

*Built by [Foxtrot Communications](https://foxtrotcommunications.net)*
