# Total Cost of Ownership: Hedge Fund AI Consolidation

> **Industry**: Financial Services — Hedge Funds, Asset Managers  
> **Topic**: Platform Consolidation & Cost Reduction  
> **Platform**: Roundtable by Foxtrot Communications

## Executive Summary

A typical 100-person hedge fund spends **$1.3M+ annually** on a patchwork of disconnected AI tools — per-seat ChatGPT licenses, standalone compliance platforms, duplicate cloud API subscriptions, and 2-3 engineers maintaining custom integrations between them. None of these systems talk to each other, and there is no unified audit trail.

Roundtable replaces this entire stack with a single, self-hosted platform at an infrastructure cost of **~$30K/year** plus licensing. The savings come from eliminating per-seat AI licensing, consolidating duplicate subscriptions, removing integration engineering, and replacing standalone compliance AI platforms — while adding capabilities none of the individual tools provide.

## The Problem: AI Sprawl

Every desk picks their own AI. Every team has their own API keys. Every tool has its own data pipeline to the same underlying data. The result:

```
Trading Desk:     ChatGPT Enterprise + Bloomberg AI → $180K/yr
Quant Research:   Claude Teams + Custom ML Platform  → $324K/yr
Compliance:       Behavox + NICE Actimize            → $200K/yr
Risk Management:  Internal Python + OpenAI API       → $85K/yr
Operations:       ChatGPT Enterprise                 → $36K/yr
Integration Glue: 2-3 Engineers keeping it connected → $400K/yr
Duplicate Infra:  Each tool's own ETL + storage      → $100K/yr
                                              Total: ~$1.3M+/yr
```

And none of it talks to each other. When compliance needs trading data for an investigation, they send an email. When quant builds a risk model, they export a CSV. When a regulator asks for AI interaction records, three different teams scramble to produce logs in three different formats.

## The Solution: One Platform, N Workspaces

```
GKE Cluster
├── rt-compliance ─── Bridge ─── rt-trading
├── rt-risk ───────── Bridge ─── rt-compliance
├── rt-quant
├── rt-ops
│
├── Shared PostgreSQL (all messages, all audit trails)
├── Shared Vertex AI endpoint (usage-based pricing)
├── Shared BigQuery connection (configured once)
└── Shared A2A Agent Pool
    ├── Bloomberg Agent
    ├── Kensho Agent
    └── Custom Risk Model Agent
```

Each workspace is an isolated container with its own AI configuration, tools, and system prompt — but shares infrastructure with every other workspace. Users connect to their team's workspace via browser. No desktop software. No per-seat licensing.

## Cost Comparison

### Current State: Disconnected Tools

| Category | Components | Annual Cost |
|---|---|---|
| **Per-seat AI licensing** | ChatGPT Enterprise (100 seats), Claude Teams (20 seats) | $96,000 |
| **Compliance AI platform** | Behavox, NICE Actimize, or equivalent | $200,000 |
| **Custom ML/AI platform** | Quant team infrastructure, GPU instances | $300,000 |
| **Cloud AI API accounts** | OpenAI, Anthropic, Google — per-team accounts | $60,000 |
| **Integration engineering** | 2-3 engineers maintaining connectors | $400,000 |
| **Duplicate data pipelines** | Each tool's own ETL to the same data | $100,000 |
| **Bloomberg AI add-ons** | Per-terminal AI features | $150,000 |
| | **Total** | **$1,306,000** |

### Roundtable: Consolidated Platform

| Category | Components | Annual Cost |
|---|---|---|
| **GKE cluster** | 5 workspace pods, e2-standard-2, spot instances | $3,000 |
| **Cloud SQL** | PostgreSQL (db-f1-micro), shared across all workspaces | $1,200 |
| **Vertex AI inference** | Gemini Flash + Pro, usage-based (no per-seat) | $18,000 |
| **BigQuery** | On-demand pricing, already provisioned | $2,000 |
| **A2A agent hosting** | Bloomberg/Kensho adapters, lightweight containers | $5,000 |
| **Roundtable Enterprise license** | Cross-workspace bridges, audit, fleet management | TBD |
| **Integration engineering** | Agents plug in via A2A — no custom glue | $0 |
| | **Total** | **~$30,000 + license** |

### Savings Breakdown

| Savings Category | Amount | How |
|---|---|---|
| **Eliminate per-seat licensing** | $96,000 | Workspace-based, not user-based. 100 users in 5 workspaces = 5 containers |
| **Eliminate compliance AI platform** | $200,000 | Every message is in PostgreSQL with attribution. Native audit trail |
| **Eliminate integration engineering** | $400,000 | Tools and agents are shared infrastructure. No custom connectors |
| **Consolidate AI API accounts** | $60,000 | One Vertex AI endpoint, usage-based. Volume pricing |
| **Reduce custom ML platform spend** | $200,000 | Quant models exposed as A2A agents, hosted in same cluster |
| **Eliminate duplicate data pipelines** | $100,000 | BigQuery connection configured once, available to all workspaces |
| | **Total savings** | **~$1,056,000/yr** |

## Why Per-Seat Licensing Is Obsolete

ChatGPT Enterprise charges $60/user/month regardless of usage. A trader who asks one question a week pays the same as an analyst running 50 queries a day.

Roundtable's model:

- **Infrastructure cost**: Fixed per workspace (~$600/yr per pod)
- **AI inference cost**: Per token consumed — pay for what you use
- **Users**: Unlimited per workspace at no additional cost

For a 100-person fund with 5 desks:

| Model | Cost for 100 users |
|---|---|
| ChatGPT Enterprise | $72,000/yr (100 × $60/mo) |
| Roundtable + Gemini Flash | ~$6,000/yr (5 pods + actual token usage) |

The difference widens with headcount. At 200 users, ChatGPT doubles to $144K. Roundtable stays at ~$6K because adding users to an existing workspace costs nothing.

## Why Integration Engineering Disappears

Today a typical fund employs 2-3 engineers ($150-200K each) whose primary job is connecting AI tools to each other and to internal data:

- Building a pipeline from Bloomberg Terminal → the compliance AI platform
- Writing exporters from ChatGPT conversation logs → the regulatory archive
- Maintaining a bridge between the quant team's Python models and the risk dashboard
- Creating Slack bots that forward AI outputs between teams

In Roundtable:

- **Bloomberg** is an A2A agent deployed once, accessible to any workspace
- **BigQuery** is a built-in tool configured once in the ConfigMap
- **Conversation logs** are already in PostgreSQL — no export needed
- **Cross-team AI queries** are native via workspace bridges

The 2-3 integration engineers can be redeployed to higher-value work (building proprietary agents, improving data quality, developing trading strategies).

## Why Standalone Compliance Platforms Are Redundant

Behavox and NICE Actimize charge $200K+ for:

1. Recording AI interactions
2. Making them searchable
3. Producing reports for regulators
4. Flagging anomalous patterns

Roundtable provides #1-3 by default:

| Capability | Behavox | Roundtable |
|---|---|---|
| Record all AI interactions | ✅ | ✅ (PostgreSQL — `messages` table) |
| Attribute to user + timestamp | ✅ | ✅ (`user_id`, `created_at`, `source_workspace_id`) |
| Search interaction history | ✅ | ✅ (SQL queries against messages table) |
| Cross-desk audit trail | ✅ | ✅ (workspace bridges log all cross-desk queries) |
| Tool call logging | ❌ | ✅ (every `query_bigquery`, `web_search`, etc. is recorded) |
| AI-powered investigation | ❌ | ✅ (compliance AI with dedicated tools) |
| Annual cost | $200K+ | Included in platform |

For #4 (anomaly detection), the compliance workspace's AI can be configured with a system prompt that instructs it to flag patterns — using the same data warehouse tools that every other workspace uses.

## Model Arbitrage: Right-Size AI Spend

Per-seat licensing forces you to pay for the most expensive model for every interaction. With Roundtable, each workspace can use a different model:

| Workspace | Model | Why | Cost/1M tokens |
|---|---|---|---|
| **Operations** | Gemini 2.0 Flash | Routine queries, scheduling, docs | $0.075 |
| **Compliance** | Gemini 2.0 Flash | Surveillance scanning, routine checks | $0.075 |
| **Compliance** (escalated) | Gemini 2.5 Pro | Complex regulatory analysis | $1.25 |
| **Quant Research** | Gemini 2.5 Pro | Deep reasoning, model validation | $1.25 |
| **Trading Desk** | Gemini 2.0 Flash | Quick lookups, position summaries | $0.075 |

80% of queries can use Flash ($0.075/1M tokens). Only complex reasoning tasks need Pro ($1.25/1M tokens). Per-seat licensing doesn't give you this flexibility.

## Beyond Cost: Capabilities That Don't Exist Today

The cost savings justify the migration. But Roundtable enables things the current stack simply cannot do:

### Cross-Workspace AI Routing

A compliance analyst types `@trading-ai Show me AAPL trades from May 14` — and the trading workspace's AI responds with data from Bloomberg. Both workspaces see the exchange. Full audit trail. No email, no Slack, no CSV.

*No combination of ChatGPT + Behavox + Bloomberg can do this.*

### Unified Institutional Memory

Every AI conversation across every desk is in one database. When an analyst leaves, their investigation history stays. When a regulator asks "what AI-assisted decisions led to this trade?" — the answer is a SQL query, not a six-week forensic exercise.

*Today this data is scattered across ChatGPT logs, Slack threads, email, and Bloomberg chat.*

### One-Command Desk Deployment

```bash
GCP_PROJECT=fund-infra ./deploy-gke.sh newdesk "New Desk"
```

A new team gets their own workspace with full AI capabilities, data warehouse access, and bridge-ready connectivity — in 5 minutes. Today, onboarding a new team to the AI stack takes weeks of procurement, licensing, and integration work.

## Implementation Timeline

| Phase | Duration | Deliverable |
|---|---|---|
| **Pilot** | 2 weeks | 1 workspace (compliance or ops), 5-10 users |
| **Validation** | 2 weeks | Confirm audit trail, test bridge concept |
| **Rollout** | 2 weeks | Deploy remaining desks, configure A2A agents |
| **Decommission** | 4 weeks | Phase out ChatGPT seats, compliance platform |
| **Total** | **10 weeks** | Full migration |

## Summary

| Metric | Current | Roundtable |
|---|---|---|
| **Annual AI spend** | $1.3M+ | ~$30K + license |
| **Systems to maintain** | 7+ | 1 |
| **Unified audit trail** | No | Yes |
| **Cross-desk AI collaboration** | No | Yes (workspace bridges) |
| **Time to onboard a new desk** | Weeks | Minutes |
| **Per-seat cost** | $60/user/mo | $0 (workspace-based) |
| **Vendor lock-in** | High | None (Apache 2.0, self-hosted) |
| **Integration engineers needed** | 2-3 | 0 |

---

*Roundtable by [Foxtrot Communications](https://foxtrotcommunications.net) — Replace your AI sprawl with one platform your compliance team will actually love.*
