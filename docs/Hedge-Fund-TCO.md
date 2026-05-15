---
pdf_options:
  format: Letter
  margin: 25mm
  displayHeaderFooter: true
  headerTemplate: '<div style="font-size:9px; width:100%; padding:0 25mm; color:#666; display:flex; justify-content:space-between;"><span>Roundtable — Hedge Fund TCO Analysis</span><span>Foxtrot Communications</span></div>'
  footerTemplate: '<div style="font-size:9px; width:100%; text-align:center; color:#999;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
stylesheet: https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown.min.css
body_class: markdown-body
css: |-
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
  .markdown-body { max-width: none; }
  h1 { border-bottom: 2px solid #6366f1; padding-bottom: 8px; }
  h2 { border-bottom: 1px solid #e1e4e8; padding-bottom: 6px; margin-top: 28px; }
  h3 { margin-top: 20px; }
  code { background: #f0f0f5; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  pre { background: #1e1e2e; color: #cdd6f4; padding: 16px; border-radius: 8px; }
  pre code { background: none; color: inherit; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d0d7de; padding: 8px 12px; text-align: left; }
  th { background: #f6f8fa; font-weight: 600; }
  blockquote { border-left: 4px solid #6366f1; padding: 4px 16px; color: #57606a; background: #f8f8fc; margin: 12px 0; }
  a { color: #6366f1; }
---

# Total Cost of Ownership: Hedge Fund AI Consolidation

> **Industry**: Financial Services — Hedge Funds, Asset Managers
> **Topic**: Platform Consolidation & Cost Reduction
> **Platform**: Roundtable by Foxtrot Communications

## Executive Summary

A typical 100-person hedge fund spends **$1.3M+ annually** on a patchwork of disconnected AI tools — per-seat ChatGPT licenses, standalone compliance platforms, duplicate cloud API subscriptions, and 2-3 engineers maintaining custom integrations between them. None of these systems talk to each other, and there is no unified audit trail.

Roundtable replaces this entire stack with a single, self-hosted platform at an infrastructure cost of **~$30K/year** plus licensing. The savings come from eliminating per-seat AI licensing, consolidating duplicate subscriptions, removing integration engineering, and replacing standalone compliance AI platforms — while adding capabilities none of the individual tools provide.

## The Problem: AI Sprawl

Every desk picks their own AI. Every team has their own API keys. Every tool has its own data pipeline to the same underlying data.

```
Trading Desk:     ChatGPT Enterprise + Bloomberg AI  $180K/yr
Quant Research:   Claude Teams + Custom ML Platform   $324K/yr
Compliance:       Behavox + NICE Actimize             $200K/yr
Risk Management:  Internal Python + OpenAI API         $85K/yr
Operations:       ChatGPT Enterprise                   $36K/yr
Integration Glue: 2-3 Engineers keeping it connected  $400K/yr
Duplicate Infra:  Each tool's own ETL + storage       $100K/yr
                                               Total: ~$1.3M+
```

And none of it talks to each other. When compliance needs trading data for an investigation, they send an email. When quant builds a risk model, they export a CSV. When a regulator asks for AI interaction records, three different teams scramble to produce logs in three different formats.

## The Solution: One Platform, N Workspaces

```
GKE Cluster
├── rt-compliance    Bridge    rt-trading
├── rt-risk          Bridge    rt-compliance
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
| **Eliminate per-seat licensing** | $96,000 | Workspace-based, not user-based |
| **Eliminate compliance AI platform** | $200,000 | Native audit trail in PostgreSQL |
| **Eliminate integration engineering** | $400,000 | Tools and agents are shared infrastructure |
| **Consolidate AI API accounts** | $60,000 | One Vertex AI endpoint, volume pricing |
| **Reduce custom ML platform** | $200,000 | Quant models exposed as A2A agents |
| **Eliminate duplicate pipelines** | $100,000 | BigQuery configured once for all workspaces |
| | **Total savings** | **~$1,056,000/yr** |

## Why Per-Seat Licensing Is Obsolete

ChatGPT Enterprise charges $60/user/month regardless of usage. A trader who asks one question a week pays the same as an analyst running 50 queries a day.

Roundtable's model:

- **Infrastructure cost**: Fixed per workspace (~$600/yr per pod)
- **AI inference cost**: Per token consumed — pay for what you use
- **Users**: Unlimited per workspace at no additional cost

| Model | Cost for 100 users |
|---|---|
| ChatGPT Enterprise | $72,000/yr |
| Roundtable + Gemini Flash | ~$6,000/yr |

The difference widens with headcount. At 200 users, ChatGPT doubles to $144K. Roundtable stays at ~$6K because adding users to an existing workspace costs nothing.

## Why Integration Engineering Disappears

Today a typical fund employs 2-3 engineers ($150-200K each) whose primary job is connecting AI tools to each other and to internal data:

- Building a pipeline from Bloomberg Terminal to the compliance AI platform
- Writing exporters from ChatGPT conversation logs to the regulatory archive
- Maintaining a bridge between the quant team's Python models and the risk dashboard
- Creating Slack bots that forward AI outputs between teams

In Roundtable:

- **Bloomberg** is an A2A agent deployed once, accessible to any workspace
- **BigQuery** is a built-in tool configured once in the ConfigMap
- **Conversation logs** are already in PostgreSQL — no export needed
- **Cross-team AI queries** are native via workspace bridges

The 2-3 integration engineers can be redeployed to higher-value work.

## Why Standalone Compliance Platforms Are Redundant

Behavox and NICE Actimize charge $200K+ for:

| Capability | Behavox ($200K+) | Roundtable (included) |
|---|---|---|
| Record all AI interactions | Yes | Yes — `messages` table |
| Attribute to user + timestamp | Yes | Yes — `user_id`, `created_at` |
| Search interaction history | Yes | Yes — SQL queries |
| Cross-desk audit trail | Yes | Yes — `source_workspace_id` |
| Tool call logging | No | Yes — every tool call recorded |
| AI-powered investigation | No | Yes — dedicated compliance AI |

## Model Arbitrage: Right-Size AI Spend

Each workspace can use a different model — pay for capability only when needed:

| Workspace | Model | Cost/1M tokens |
|---|---|---|
| **Operations** | Gemini 2.0 Flash | $0.075 |
| **Compliance** (routine) | Gemini 2.0 Flash | $0.075 |
| **Compliance** (escalated) | Gemini 2.5 Pro | $1.25 |
| **Quant Research** | Gemini 2.5 Pro | $1.25 |
| **Trading Desk** | Gemini 2.0 Flash | $0.075 |

80% of queries use Flash. Only complex reasoning needs Pro. Per-seat licensing doesn't give you this flexibility.

## Beyond Cost: New Capabilities

### Cross-Workspace AI Routing

A compliance analyst types `@trading-ai Show me AAPL trades from May 14` — and the trading workspace's AI responds with Bloomberg data. Both workspaces see the exchange. Full audit trail. No email, no Slack, no CSV.

*No combination of ChatGPT + Behavox + Bloomberg can do this.*

### Unified Institutional Memory

Every AI conversation across every desk is in one database. When an analyst leaves, their investigation history stays. When a regulator asks "what AI-assisted decisions led to this trade?" — the answer is a SQL query, not a six-week forensic exercise.

### One-Command Desk Deployment

```bash
GCP_PROJECT=fund-infra ./deploy-gke.sh newdesk "New Desk"
```

A new team gets full AI capabilities in 5 minutes. Today it takes weeks.

## Implementation Timeline

| Phase | Duration | Deliverable |
|---|---|---|
| **Pilot** | 2 weeks | 1 workspace, 5-10 users |
| **Validation** | 2 weeks | Confirm audit trail, test bridges |
| **Rollout** | 2 weeks | All desks, A2A agents |
| **Decommission** | 4 weeks | Phase out legacy tools |
| **Total** | **10 weeks** | Full migration |

## Summary

| Metric | Current | Roundtable |
|---|---|---|
| **Annual AI spend** | $1.3M+ | ~$30K + license |
| **Systems to maintain** | 7+ | 1 |
| **Unified audit trail** | No | Yes |
| **Cross-desk AI collaboration** | No | Yes |
| **Time to onboard a desk** | Weeks | Minutes |
| **Per-seat cost** | $60/user/mo | $0 |
| **Vendor lock-in** | High | None (Apache 2.0) |
| **Integration engineers** | 2-3 | 0 |

---

*Roundtable by [Foxtrot Communications](https://foxtrotcommunications.net) — Replace your AI sprawl with one platform your compliance team will actually love.*
