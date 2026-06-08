# 🎙️ Roundtable

**Real-time multiplayer AI workspace platform.**

Multiple users collaborate on AI conversations in real-time — with built-in tools for querying data warehouses, executing code, and managing files. Each workspace is an isolated container with its own AI, tools, and persistent storage.

Roundtable is designed as a **platform for agent orchestration** — connect your own A2A agents, MCP servers, or custom tools and let the AI route between them. Build agents in any language, deploy them anywhere, and plug them into a shared workspace where your whole team works together.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-315%20passing-brightgreen.svg)](#testing)
[![CI](https://github.com/foxtrotcommunications/foxtrotcommunications-roundtable-core/actions/workflows/ci.yml/badge.svg)](https://github.com/foxtrotcommunications/foxtrotcommunications-roundtable-core/actions/workflows/ci.yml)

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
| **Cloud Run** | PostgreSQL (Cloud SQL) | `gcloud run deploy` | ~5 min | Serverless production |
| **GKE production** | PostgreSQL (Cloud SQL) | `./deploy-gke.sh dev Development` | ~5 min | Enterprise deployment |

### Prerequisites

- **Node.js** 20+ (tested on Node 20, 22)
- **PostgreSQL** — required only for production (local dev uses SQLite automatically)

## Features

- **Multiplayer AI Chat** — Multiple users in the same AI conversation, streaming in real-time
- **Concurrent Generation** — Each user has an independent AI generation lifecycle; multiple people can prompt AI simultaneously without blocking each other
- **Multi-Provider AI** — OpenAI, Anthropic (Claude), Google Gemini (via Vertex AI or API key), and Ollama (local models, OpenAI-compatible)
- **23 Built-in Tools** — Web search, data warehouse queries, file management, shell execution, charts, cross-workspace bridges, intent compilation, A2A agent calls, and more
- **Model-Aware Tooling** — Tools like web search automatically use the workspace's configured model and endpoint
- **Configurable Tool Set** — Enable or disable individual tools per workspace via the Settings panel
- **Configurable Agent** — Set the AI provider, model, and system prompt per workspace — no redeploy needed
- **Data Warehouse Queries** — AI can query BigQuery, Snowflake, and Databricks in real-time
- **Workspace-per-Container** — Each workspace is an isolated container with its own identity
- **Workspace Bridges** — Open cross-workspace channels for AI-mediated collaboration between teams
- **Bridge Contracts** — Governed communication agreements between workspaces; contracts define allowed actions, approval requirements, and escalation paths at each bridge hop
- **A2A Agent Protocol** — Plug in external agents built in any language via the A2A standard (JSON-RPC 2.0 over HTTP)
- **Governance Contracts** — Typed, approved agreements between workspaces that define allowed actions, approval chains, and escalation paths; enforced cryptographically at runtime
- **E2E Encrypted Communication** — Cross-workspace A2A messages are encrypted with AES-256-GCM using HKDF-derived per-contract keys; only the two workspaces in an active contract can decrypt
- **Intent Compilation Engine (ICE)** — Compiles structured AI operations into signed, deterministic intent tokens that execute on receiving workspaces without LLM inference. Includes SQL fusion, execution proofs, and result caching
- **Execution Proofs** — Every compiled execution produces a cryptographic proof (SHA-256 input/output hashes, policy checks applied, HMAC-signed) for audit-grade traceability
- **Intent Caching** — LRU cache (1000 entries, 60s TTL) for compiled intent results; identical operations return cached results in <1ms
- **SQL Fusion Compiler** — Merges multiple queries against the same table into a single optimized query, reducing API costs and latency
- **MCP Server Support** — Connect external Model Context Protocol servers to extend workspace tool capabilities
- **Multi-Cloud** — Deploy on Cloud Run, GKE, EKS, AKS, or any Kubernetes cluster
- **BYOK** — Bring Your Own Key; users configure their own API keys, or use server-level defaults
- **Presence** — See who's online in each workspace
- **Streaming** — AI responses stream token-by-token to all participants
- **Embeddable** — Embed in other apps via iframe with `EMBED_MODE=true`
- 🎨 **Theme system** — Light, dark, and system (OS preference) color schemes
- **React + TypeScript** — Modern frontend with Vite, hot-reload dev server
- **AI Request Queue** — One AI request at a time per workspace; concurrent requests are queued with position tracking
- **Monthly Token Credit Pool** — Configurable hard/soft caps per workspace
- **Mermaid Diagram Rendering** — Interactive SVG diagrams from mermaid code blocks
- **Collapsible Output Blocks** — Charts, tables, and diagrams are collapsible with download buttons
- **Downloadable Outputs** — PNG export for charts/diagrams, CSV export for tables
- **@Mention Autocomplete** — User mentions with pill styling
- **Schema Auto-Injection** — YAML schema files from `workspace/uploads/` injected into AI context
- **Documentation Auto-Injection** — Markdown docs from `workspace/docs/` injected into AI context
- **First-Visit Onboarding** — Tooltip guides new users on how to interact with the AI

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
| `EMBED_ALLOWED_ORIGINS` | - | Comma-separated origins allowed to embed this workspace (required when `EMBED_MODE=true`) |
| `DEMO_MODE` | `false` | Enable auto-login guest accounts (`true`/`false`) |
| `WORKSPACE_URL` | - | Public URL of this workspace (required for cross-workspace bridge) |
| `PLATFORM_ORG` | - | Organization name shown in system prompt and describe_workspace |
| `SECURE_COOKIES` | `false` | Force secure cookies in production (`true`/`false`) |
| `SHELL_EXEC_ENABLED` | `false` | Allow the shell_exec tool (`true`/`false`) |
| `A2A_SERVER_ENABLED` | `false` | Enable the A2A agent protocol server (`true`/`false`) |
| `ORG_MASTER_SECRET` | - | HKDF master secret for contract key derivation (injected by provisioner) |
| `RT_CONTRACTS` | - | JSON manifest of active governance contracts (injected by provisioner) |
| `RT_BRIDGES` | - | JSON manifest of workspace bridges (injected by provisioner) |
| `RT_MCP_SERVERS` | - | JSON manifest of MCP server connections (injected by provisioner) |
| `RT_A2A_AGENTS` | - | JSON manifest of A2A agent connections (injected by provisioner) |

### AI Providers

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Server-level OpenAI key |
| `ANTHROPIC_API_KEY` | Server-level Anthropic key |
| `GOOGLE_AI_API_KEY` | Server-level Google AI key |
| `GCP_PROJECT` | GCP project for Vertex AI (uses ADC, no key needed) |
| `GCP_LOCATION` | Vertex AI region (default: `us-central1`) |
| `OLLAMA_HOST` | Default Ollama host URL (default: `http://localhost:11434`, overridable per-workspace) |
| `GOOGLE_SEARCH_API_KEY` | Google Custom Search API key (for web_search tool) |
| `GOOGLE_SEARCH_ENGINE_ID` | Google Custom Search engine ID |

### Data Warehouses

| Variable | Description |
|----------|-------------|
| `GCP_PROJECT` | BigQuery — uses same ADC as Vertex AI |
| `BQ_PROJECT` | Override BigQuery billing project (cross-project access, default: `GCP_PROJECT` value) |
| `BQ_LOCATION` | BigQuery dataset location (default: `US`) |
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
| **Provider** | `vertexai` \| `openai` \| `anthropic` \| `google` \| `ollama` |
| **Model** | Any model supported by the selected provider (e.g. `gemini-2.5-flash`, `gpt-4o`, `claude-opus-4-5`) |
| **System Prompt** | Custom instructions prepended to every AI conversation in this workspace |

### Tools tab

Enable or disable individual tools per workspace. Disabled tools are removed from the AI's context entirely — the model won't attempt to call them. Tools are grouped by category:

- **Web**: `web_search`, `read_url`
- **Code**: `run_code`, `shell_exec`, `calculator`
- **Files**: `read_file`, `write_file`, `list_files`, `find_file`
- **Git**: `git_clone`, `git_commit`, `git_pull`
- **Data**: `query_bigquery`, `query_snowflake`, `query_databricks`, `download_query_results`
- **Visualization**: `render_chart`
- **Workspace**: `describe_workspace`, `bridge_workspace`, `intent_bridge`, `verify_workspace`, `trigger_synthea_pipeline`
- **Agent**: `call_agent`

> **Tip**: For workspaces focused on data analysis, disable `shell_exec`, `git_clone`, and `git_commit` to reduce the AI's tool surface and improve response focus.

### API Keys tab

Users can configure personal API keys (OpenAI, Anthropic, Google AI) that override server-level defaults for their sessions.

### Embed Mode

Roundtable can be embedded as an iframe in external sites. Set `EMBED_MODE=true` to enable:

- **Cross-origin cookies**: Session cookies use `SameSite=None; Secure`
- **Stateless guest auth**: When third-party cookies are blocked (e.g., Chrome incognito), requests are auto-assigned ephemeral guest identities — no cookies required
- **CORS**: Only origins listed in `EMBED_ALLOWED_ORIGINS` are allowed
- **Socket.IO**: WebSocket connections also support stateless guest auth

```bash
EMBED_MODE=true
EMBED_ALLOWED_ORIGINS=https://example.com,https://dashboard.example.com
```

The parent page can inject prompt text into the embedded workspace using `postMessage`:

```javascript
iframe.contentWindow.postMessage({ type: 'roundtable:setPrompt', text: 'Your prompt here' }, '*');
```

### Demo Mode

Set `DEMO_MODE=true` to enable the `/api/auth/demo` endpoint, which creates auto-login guest accounts with random names (e.g., `brave-falcon-a1b2`). Useful for public demos.

## Built-in Tools

All 23 tools are enabled by default. Individual tools can be toggled per workspace via the Settings panel.

| Tool | Description |
|------|-------------|
| **web_search** | Search the web via Google Custom Search or Vertex AI grounding (model-aware, supports preview and GA models) |
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
| **git_pull** | Pull latest changes from a remote Git repository into the workspace |
| **describe_workspace** | Self-discovery meta-tool that helps the AI understand what tools and data sources are available in the workspace (always enabled) |
| **bridge_workspace** | Cross-workspace AI communication — delegates queries to other Roundtable workspaces via `@ai-{workspace}` mentions |
| **render_chart** | Generate interactive charts (bar, line, pie, doughnut, area, scatter) inline in chat from query results |
| **download_query_results** | Export query results as downloadable CSV/JSON files |
| **trigger_synthea_pipeline** | Trigger synthetic FHIR/OMOP patient data generation via Synthea |
| **verify_workspace** | Run health checks on tools and data sources |
| **call_agent** | Delegate a task to an external AI agent via the A2A (Agent-to-Agent) protocol |
| **intent_bridge** | Compiled intent token bridge — sends cryptographically signed, deterministic operations to other workspaces for direct execution without LLM inference (ICE) |

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

```
Intent Compilation Engine (ICE):
  LLM → intent_bridge → IntentToken (signed) → /a2a intent/execute
  → Cache check → SQL fusion → Tool dispatch → ExecutionProof → Signed result
  Zero LLM inference on receiving side.
```

- **Backend**: Node.js 20, Express, Socket.IO
- **Database**: PostgreSQL (production) or SQLite (local dev)
- **Frontend**: React + TypeScript (Vite, `client/dist/`)
- **Real-time**: Socket.IO for WebSocket communication
- **Container**: Alpine-based Docker image (~60MB)

## Testing

```bash
npm test                # Unit + ICE tests (315 tests)
npm run test:integration  # Integration tests (99 tests)
npm run typecheck       # TypeScript strict mode check
npm run lint:server     # ESLint (0 errors, warnings only)
```

### Unit Tests (Jest)

315 tests across 18 suites:

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
| Intent token types | 19 | validateIntent, intentOpToAction, operation validation |
| Intent token codec | 16 | Canonicalize, build, verify, decrypt, sign, expiry |
| Nonce store | 7 | Replay detection, TTL expiry, cleanup |
| Intent metrics | 8 | Stats, token savings, p95, cache/fusion counters |
| Intent executor | 9 | Query, tool_call, discover, auth gate, SQL safety |
| Execution proofs | 8 | Build, verify, tamper detection, hash matching |
| Intent cache | 11 | Hit/miss, TTL, LRU eviction, stats |
| Intent compiler | 14 | SQL fusion, dedup, LIMIT injection |

### Integration Tests (Jest)

99 tests across 4 suites:

| Suite | Tests | Coverage |
|-------|-------|----------|
| Contract crypto (`contractAuth`) | 38 | HKDF key derivation, AES-256-GCM encrypt/decrypt, HMAC signing, timestamp freshness |
| Bridge communication (`bridgeReceive`) | 11 | HMAC auth validation, contract enforcement, expired timestamps |
| MCP protocol (`mcpProtocol`) | 19 | JSON-RPC 2.0 compliance, initialize/tools/list/call, error codes |
| Tool registry (`toolRegistry`) | 31 | All 22+ tools validated, resolveTools filtering, OpenAI/Anthropic/Google format output |

### TypeScript Strict Mode

The server TypeScript config has incremental strict flags enabled (`strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`) with 0 errors.

### ESLint

Flat config with `typescript-eslint` recommended rules. 0 errors, 164 warnings (intentional `no-explicit-any` and `ban-ts-comment` at warn level).

```bash
npm run lint:server  # Lint server/ directory
```

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
3. Run tests (`npm test && npm run test:integration`)
4. Run typecheck (`npm run typecheck`)
5. Commit your changes (`git commit -m 'Add my feature'`)
6. Push to the branch (`git push origin feature/my-feature`)
7. Open a Pull Request

## Security

Security policies and compliance documentation are maintained in [`docs/security/`](docs/security/):

- [**Incident Response Plan**](docs/security/incident-response-plan.md) — Detection, triage, containment, and post-mortem procedures
- [**Data Classification Policy**](docs/security/data-classification-policy.md) — Four-level classification (Restricted → Public) for all platform data
- [**Acceptable Use Policy**](docs/security/acceptable-use-policy.md) — Permitted and prohibited platform usage
- [**Shared Responsibility Model**](docs/security/shared-responsibility-model.md) — GCP control ownership mapping for SOC 2 auditors

Infrastructure and application security controls include:

- **Workspace Isolation** — Each workspace runs as its own K8s pod with a dedicated database and per-pod NetworkPolicy (ingress restricted to ingress controller only)
- **Workload Identity** — No static service account keys; pods authenticate via GKE Workload Identity
- **Encryption in Transit** — TLS 1.2+ for all external communication (HTTPS, WSS)
- **End-to-End Encryption** — Cross-workspace A2A messages are encrypted with AES-256-GCM using HKDF-derived per-contract keys. The wake proxy, ingress controller, and log pipeline cannot inspect message payloads
- **Intent Compilation Engine** — Compiled intent tokens carry HMAC-SHA256 signatures, optional AES-256-GCM encryption, nonce-based replay prevention (10-min window), and contract-based action authorization. Every execution produces a signed `ExecutionProof` with SHA-256 hashes of input and output for audit-grade traceability
- **SQL Safety in Compiled Execution** — The intent executor enforces the same SQL blocklist (INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE, MERGE, GRANT, REVOKE) as direct tool calls, preventing data mutation through compiled intent tokens
- **Contract-Based Authentication** — Every bridge request carries a `contractToken` (`HMAC-SHA256(secret, contractId:sortedAllowedActions)`) generated by the control plane and independently re-derived by the pod using `timingSafeEqual`. The full request signature covers `taskId:timestamp:contractId:action`, binding the specific action into the signature so replay attacks against a different action or contract are rejected
- **Pod-Side Enforcement Gate** — `server/routes/bridgeReceive.js` enforces contracts in four sequential stages: (1) HMAC + timestamp ≤5 min, (2) `contractId` in local `RT_CONTRACTS` manifest, (3) `contractToken` match, (4) action in `allowedActions`. Stages 2–4 use `timingSafeEqual`. A compromised or misconfigured control plane cannot grant permissions not written into the pod's manifest
- **Handshake Approval Model** — Contracts require explicit approval from the workspace admin of both the source and target workspaces. Proposed amendments are staged in `amendment.proposedChanges` (original terms remain enforced) until both admins re-approve, preventing unilateral privilege escalation
- **Encryption at Rest** — AES-256 at rest via Cloud SQL and Firestore; API keys and credentials encrypted before database storage
- **Audit Logging** — Cloud Audit Logs exported to immutable storage (`gs://roundtable-audit-logs`); governance engine flags ungoverned bridges and policy violations
- **Container Scanning** — Artifact Registry vulnerability scanning enabled on all images
- **Branch Protection** — PRs require at least one approving review before merge

## Related

- **[Roundtable Dashboard](https://github.com/foxtrotcommunications/foxtrotcommunications-roundtable)** — Multi-tenant SaaS management console (workspace lifecycle, members, usage, billing)

## License

[Apache License 2.0](LICENSE)

---

_Built by [Foxtrot Communications](https://foxtrotcommunications.net)_
