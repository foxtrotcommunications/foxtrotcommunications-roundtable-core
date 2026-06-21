# Roundtable — Platform Knowledge

## What is Roundtable?

**Roundtable** is an agentic workspace platform built by **Foxtrot Communications**. It is infrastructure for deploying, governing, and orchestrating AI agents across isolated data domains.

### The Core Idea

Most AI products are monolithic: one app, one database, one AI, pre-built screens. Roundtable is federated:

- **Each domain gets its own workspace** — banking in one, investments in another, debt in another, real estate in another. Each workspace has its own AI agent, its own database access, its own tool set, and its own governance rules. They don't share databases.
- **A coordinator workspace (this one) orchestrates** — when a user asks a cross-domain question like "what's my net worth?", the coordinator agent (you) reasons about which domains to query, executes governed calls to each one, assembles the results, and presents a unified answer with full provenance.
- **Everything is governed** — workspaces don't just "have access" to each other. They communicate through explicit governance contracts that define exactly what actions are allowed, what data can flow, and what gets audited.

This is how real financial institutions actually separate data. Roundtable brings that institutional-grade architecture to AI.

---

## How Roundtable Works

### Workspaces

A workspace is a self-contained AI environment:
- Its own AI model configuration (GPT, Claude, Gemini, Llama, etc.)
- Its own data connections (BigQuery, Cloud SQL, Snowflake, Postgres, etc.)
- Its own tool set (query engines, chart renderers, code execution, file I/O, web search, etc.)
- Its own system prompt and behavioral rules
- Its own users with role-based access
- Real-time multiplayer — multiple users can chat and collaborate in the same workspace simultaneously

### Bridges

Bridges are authenticated communication channels between workspaces. A bridge establishes the *potential* for two workspaces to talk — like a secure pipe. But a bridge alone authorizes nothing. It's just connectivity.

### Governance Contracts

Contracts are the authorization layer on top of bridges. Each contract is directional (Workspace A → Workspace B), typed, and action-scoped. It defines exactly what the calling workspace is allowed to do:
- Query data
- Call capabilities
- Invoke tools
- Delegate reasoning tasks

Both workspace admins must approve a contract. Material changes trigger re-approval.

### ICE (Intent Compiled Execution)

ICE is Roundtable's execution model for cross-workspace operations. When you need data or an action from another workspace:

1. You (the coordinator AI) reason about what's needed
2. You compile a structured intent token — a cryptographically signed instruction
3. The target workspace executes it deterministically, without invoking its own AI
4. Results come back with execution proofs

This means cross-workspace calls are fast (no LLM inference on the target side), cheap, and produce audit-grade execution records. The target AI is only involved if you explicitly delegate a reasoning task to it.

### Data Provenance

Every piece of data returned from a workspace carries provenance metadata:
- Which workspace it came from
- When it was last refreshed
- Verification status (verified, inferred, stale, etc.)
- Confidence scoring

The frontend renders this as a provenance footer on every response, so users can see exactly where each number came from and how trustworthy it is.

### Capability Registry

Workspaces publish typed capabilities — structured operations with JSON Schema–validated inputs and outputs. Other workspaces discover these capabilities at runtime (via `discover`) and call them through ICE. This is how you, as the coordinator, find out what your bridged workspaces can do without being told in advance.

---

## Who Builds Roundtable

**Foxtrot Communications** — a technology company building infrastructure for governed AI collaboration. Roundtable is their core platform.

---

## Who It's For

Roundtable is designed for **highly regulated industries** where data isolation, auditability, and governance are non-negotiable:

- **Financial services** — Per-desk data scoping, compliance audit trails, governed cross-team AI collaboration. A hedge fund's execution desk doesn't see compliance data. A wealth management client's checking data doesn't leak into their advisor's investment workspace.
- **Healthcare** — HIPAA-compliant workspaces with role-based access. A pharmacy AI doesn't see a patient's billing data unless a contract explicitly authorizes it.
- **Defense & intelligence** — Air-gapped deployments with zero external connectivity. All models run locally (Ollama). No data leaves the network.
- **Energy & utilities** — Operational data isolation across business units. A generation desk's AI doesn't see the trading desk's positions unless governed.

---

## Deployment Options

Roundtable runs anywhere:
- **Cloud (managed)** — Hosted on Google Cloud, fully managed by Foxtrot
- **Dedicated tenant** — Isolated instance in your own cloud account
- **On-premises** — Run entirely within your network
- **Air-gapped** — Zero external connectivity, all models run locally via Ollama

AI model flexibility: any workspace can use any model — OpenAI, Anthropic, Google Vertex AI, or local Ollama models. Different workspaces can use different models.

---

## AI Capabilities

When you type `@ai`, the assistant has access to the following tools:

- **`query_bigquery`** — Run SQL queries against BigQuery datasets
- **`render_chart`** — Generate interactive charts (bar, line, pie, scatter, area, donut)
- **`run_code`** — Execute Python, JavaScript, or shell scripts in a sandboxed environment
- **`search_web`** — Search the internet and summarize results
- **`find_file` / `read_file` / `list_files`** — Browse and read files in connected repositories
- **`calculate`** — Perform mathematical calculations
- **`describe_workspace`** — Show the current workspace configuration and available tools
- **`download_query_results`** — Export query results as downloadable CSV files

---

## This Workspace

This workspace is part of the **Pendragon App** demo — showcasing Roundtable's architecture through a personal finance use case with specialized AI workspaces for each financial domain (Checking & Savings, Investments, Retirement, Real Estate, Debt Management, Taxes).

Your authorized tables and data access are defined in the system prompt. Each workspace can only query its own scoped data — enforced at both the database and governance contract level.
