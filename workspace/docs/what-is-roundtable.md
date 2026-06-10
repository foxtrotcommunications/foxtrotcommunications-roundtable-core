# What is Roundtable?

**Roundtable** is a real-time, multiplayer AI workspace built by Foxtrot Communications. Think of it as a shared room where your team can chat with each other — and with an AI assistant that has real tools and access to your data.

## How It Works

Roundtable combines **team chat** with a **tool-equipped AI assistant** in a single, real-time environment.

- **Multiplayer by default** — everyone on your team sees the same conversation. When someone asks the AI a question, the whole team sees the answer.
- **@ai to invoke** — type `@ai` followed by your request to talk to the AI. Messages *without* `@ai` go to your teammates only, like a normal chat.
- **Real tools, not just text** — the AI doesn't just generate responses. It can query your databases, render charts, search the web, write and run code, read files, and export results — all within the chat.

## What Makes It Different

Most AI assistants are single-player: one person, one chat, one session. Roundtable is built for teams that need to work together with AI in the same shared context.

| Feature | Roundtable | Typical AI Chat |
|---------|-----------|-----------------|
| Multi-user real-time | ✅ Shared workspace | ❌ Single user |
| Data querying | ✅ BigQuery, Snowflake | ❌ No data access |
| Charts & visualizations | ✅ In-chat rendering | ❌ Text only |
| Code execution | ✅ Sandboxed runtime | ⚠️ Limited |
| File operations | ✅ Read, write, search | ❌ No filesystem |
| Cross-workspace bridging | ✅ @ai-workspace routing | ❌ N/A |
| On-prem / air-gapped | ✅ Full deployment flexibility | ❌ Cloud only |

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

## Who It's For

Roundtable is designed for teams in **highly regulated industries** that need strict control over what the AI can access and do:

- **Financial services** — Per-desk data scoping, compliance audit trails, governed cross-team AI collaboration
- **Healthcare** — HIPAA-compliant workspaces with role-based data access
- **Defense & intelligence** — Air-gapped deployments with no external dependencies
- **Energy & utilities** — Operational data isolation across business units

## Deployment Options

Roundtable can be deployed anywhere:

- **Cloud (managed)** — Hosted on Google Cloud, fully managed
- **Dedicated tenant** — Isolated instance in your cloud account
- **On-premises** — Run entirely within your network
- **Air-gapped** — Zero external connectivity, all models run locally (Ollama support)

## This Workspace

This workspace is part of the **Pendragon Capital Management** demo — a multi-strategy hedge fund with specialized AI workspaces for each team (Execution, Research, Risk, Compliance, etc.).

Your authorized tables and data access are defined in the system prompt. Each workspace can only query its own scoped BigQuery views — enforced at both the database and prompt level.

Try asking:
- `@ai What data do I have access to?`
- `@ai Describe our bridges and contracts`
- `@ai What are the latest research signals?`

