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

Roundtable is designed for teams in data-sensitive industries:

- **Healthcare** — HIPAA-compliant workspaces for clinical data analysis
- **Financial services** — Secure environments for quantitative research
- **Defense & intelligence** — Air-gapped deployments with no external dependencies
- **Pharma & life sciences** — Collaborative drug discovery and clinical trial analysis

## Deployment Options

Roundtable can be deployed anywhere:

- **Cloud (managed)** — Hosted on Google Cloud, fully managed
- **Dedicated tenant** — Isolated instance in your cloud account
- **On-premises** — Run entirely within your network
- **Air-gapped** — Zero external connectivity, all models run locally (Ollama support)

## The Demo

This demo workspace connects to a **synthetic healthcare dataset** built on the OMOP Common Data Model. The data contains ~1,000 synthetic patients with conditions, medications, procedures, observations, and more.

Try asking:
- `@ai How many patients are in the dataset?`
- `@ai What are the top 10 most common conditions?`
- `@ai Show me a chart of patient age distribution`
- `@ai Query readmission rates by diagnosis`

The data is entirely synthetic — no real patient information is used.
