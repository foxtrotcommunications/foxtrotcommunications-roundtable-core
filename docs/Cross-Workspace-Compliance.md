---
pdf_options:
  format: Letter
  margin: 25mm
  displayHeaderFooter: true
  headerTemplate: '<div style="font-size:9px; width:100%; padding:0 25mm; color:#666; display:flex; justify-content:space-between;"><span>Roundtable — Cross-Workspace Compliance</span><span>Foxtrot Communications</span></div>'
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

# Cross-Workspace Compliance Investigation

> **Industry**: Financial Services — Hedge Funds, Asset Managers, Broker-Dealers
> **Feature**: Workspace Bridges
> **Platform**: Roundtable by Foxtrot Communications

## Executive Summary

In multi-desk financial firms, compliance investigations require data that spans trading systems, risk platforms, communication archives, and regulatory databases — each owned by different teams. Today, this coordination happens through emails, Slack threads, and manual data requests, producing no unified audit trail.

Roundtable's **Workspace Bridges** enable AI-mediated cross-team collaboration where each team retains its own tools and data access, but can open a shared, auditable channel for joint investigation. Every message, tool call, and AI response is logged with workspace attribution for SEC/FINRA compliance.

## The Problem

When a compliance analyst spots an anomalous securities transaction, they need:

1. **Trading data** from the execution desk (fills, timestamps, counterparties)
2. **Position data** from the portfolio management system
3. **Communication records** for the relevant trader
4. **Restricted list** checks against their own compliance database

Each of these data sources is owned by a different team, accessed through different tools, and protected by different access controls. The investigation requires coordination across organizational boundaries — without breaking information barriers.

## Architecture

```
GKE Cluster (Fund Infrastructure)
│
├── rt-compliance ──── Bridge ──── rt-trading
│   Compliance Officer                 Head Trader
│   Compliance Analyst                 Execution Trader
│   Compliance AI                      Trading AI
│   │                                  │
│   ├── Restricted List DB             ├── Bloomberg Agent (A2A)
│   ├── Regulatory Filings             ├── OMS / Execution Data
│   ├── Communication Archive          ├── Position Database
│   └── Investigation Case Files       └── Trade Blotters
│
├── rt-risk ──── Bridge ──── rt-compliance
│   Risk Manager
│   Risk AI
│   │
│   ├── VaR Models
│   ├── Exposure Analytics
│   └── Stress Test Engine
│
└── PostgreSQL (shared)
    ├── workspace_bridges (channel state)
    └── messages (full audit trail with source_workspace_id)
```

### Key Design Principles

- **Tool isolation**: The compliance AI cannot access Bloomberg directly. The trading AI cannot access the restricted list. Each workspace's AI retains only its own tools. Cross-workspace queries are explicit and logged.
- **Human-in-the-loop**: The bridge must be accepted by the target workspace. Both sides see every message. No silent data access.
- **Audit trail**: Every message in a bridge is tagged with `source_workspace_id`. SEC/FINRA examiners can reconstruct exactly what was asked, by whom, when, and what data informed the response.

## Walkthrough: Investigating an Anomalous Trade

### Step 1 — Compliance Detects an Anomaly

The compliance analyst queries their surveillance database in the `rt-compliance` workspace:

```
Compliance Analyst:
@ai Show me all trades flagged by our wash trade detection
model in the past 48 hours.

Compliance AI → [queries surveillance database]

3 trades flagged:
| Symbol | Side | Qty   | Price  | Time           | Score |
|--------|------|-------|--------|----------------|-------|
| AAPL   | Buy  | 5,000 | 198.42 | May 14, 10:32a | 0.87  |
| AAPL   | Sell | 5,000 | 198.45 | May 14, 10:34a | 0.87  |
| TSLA   | Buy  | 2,000 | 178.90 | May 14, 2:15p  | 0.62  |

The AAPL pair (buy/sell within 2 minutes, same quantity,
$0.03 spread) scores 0.87 on the wash trade model.
This warrants investigation.
```

### Step 2 — Opening a Bridge to Trading

The compliance analyst needs execution details that only the trading desk has:

```
Compliance Analyst clicks: [Bridge → Trading Desk]

System: Bridge request sent to rt-trading.
        Waiting for acceptance...

Head Trader (in rt-trading): [Accept Bridge]

System: Bridge established between Compliance and Trading Desk.
        All messages in this channel are visible to both
        workspaces and logged for regulatory compliance.
```

### Step 3 — Cross-Workspace AI Query

The compliance analyst queries the **trading workspace's AI**, which has access to Bloomberg and the order management system:

```
Compliance Analyst:
@trading-ai Show me the full execution details for the AAPL
trades on May 14 between 10:30a and 10:35a. Include
counterparties, venue, and order origination.

Trading AI → [queries OMS, Bloomberg execution data]

Order 1 (Buy):
  Symbol: AAPL | Side: Buy | Qty: 5,000 | Avg: $198.42
  Venue: NASDAQ | Counterparty: Citadel Securities
  Order Type: Limit | Originator: jsmith (Algo Desk)
  Parent Order ID: PO-2024-88412
  Strategy: VWAP

Order 2 (Sell):
  Symbol: AAPL | Side: Sell | Qty: 5,000 | Avg: $198.45
  Venue: NYSE | Counterparty: Virtu Financial
  Order Type: Market | Originator: jsmith (Algo Desk)
  Parent Order ID: PO-2024-88415
  Strategy: Manual

Note: Different parent order IDs suggest these were
independent orders, not legs of the same strategy.
The buy was algorithmic (VWAP), the sell was manual.
```

### Step 4 — Compliance Uses Own Tools

The compliance analyst uses **their own AI** for restricted list checks and communication review:

```
Compliance Analyst:
@ai Check if jsmith has any active restrictions on AAPL,
and pull any communications mentioning AAPL from the past week.

Compliance AI → [queries restricted list, comms archive]

Restricted List Check:
  ✓ AAPL is NOT on the firm restricted list
  ✓ jsmith has no personal trading restrictions on AAPL

Communications (past 7 days):
  3 results for "AAPL" in jsmith's communications:

  1. May 13, 4:45p — Slack to mwilson (PM):
     "AAPL looking heavy into close, might want to trim"
  2. May 14, 10:28a — Bloomberg chat to external (Citadel):
     "Working a 5k AAPL buy, VWAP, 30min horizon"
  3. May 14, 10:33a — Slack to self-note:
     "Filled on AAPL buy. PM says reverse it, wrong account"

The third communication is significant — "wrong account"
suggests the sell was a correction, not a wash trade.
```

### Step 5 — Escalation to Risk

Compliance opens a second bridge to the Risk workspace:

```
Compliance Analyst:
@risk-ai What's the current net AAPL exposure across all
accounts managed by the equity desk?

Risk AI → [queries position and exposure systems]

AAPL Exposure Summary (as of May 15, 8:00a):
  Account A (Equity Long/Short): +12,000 shares ($2.38M)
  Account B (Market Neutral):     -3,000 shares ($595K)
  Account C (Algo Trading):            0 shares

Net Firm Exposure: +9,000 shares ($1.79M)

Account C (Algo Trading, managed by jsmith) shows zero
position. The 5,000 buy/sell cycle on May 14 resulted
in a flat position — consistent with a trade correction.
```

### Step 6 — Resolution

The compliance analyst has a complete picture across three workspaces:

- **Trading desk**: Independent orders with different strategies
- **Compliance tools**: Communication trail explaining the correction
- **Risk systems**: Net-zero position confirming no directional intent

```
Compliance Analyst:
@ai Summarize this investigation and draft a disposition
memo for the AAPL wash trade alert (May 14).

Compliance AI → [generates memo with cross-workspace citations]

DISPOSITION: FALSE POSITIVE — Trade Correction

Summary: The AAPL buy/sell pair flagged on May 14 (score: 0.87)
was a trade correction, not a wash trade. Evidence:
1. Different parent order IDs (PO-88412 vs PO-88415)
2. Different strategies (VWAP vs Manual)
3. Trader communication: "PM says reverse it, wrong account"
4. Net-zero position in the originating account

Recommendation: Close alert. No further action required.
```

**Total investigation time: ~15 minutes** (vs. 1-2 days with manual coordination).

## Regulatory Compliance

| Requirement | How Roundtable Addresses It |
|---|---|
| **Books and records** (SEC 17a-4) | Every bridged message is persisted with timestamp, user ID, workspace origin, and tool call details |
| **Supervisory review** (FINRA 3110) | Bridge requests require acceptance; all AI tool calls are logged and reviewable |
| **Communication surveillance** | AI queries across workspaces are captured as structured data, not ephemeral chat |
| **Information barriers** | Workspaces maintain tool isolation — compliance cannot directly access trading data without an explicit, logged bridge |
| **Audit trail reconstruction** | `source_workspace_id` on every message enables full reconstruction of cross-desk information flow |

## Technical Implementation

### Database Schema

```sql
CREATE TABLE workspace_bridges (
    id SERIAL PRIMARY KEY,
    workspace_a TEXT NOT NULL REFERENCES workspaces(id),
    workspace_b TEXT NOT NULL REFERENCES workspaces(id),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'active', 'closed')),
    opened_by INTEGER REFERENCES users(id),
    accepted_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP,
    UNIQUE(workspace_a, workspace_b)
);
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/bridge/:target_workspace_id` | Open a bridge request |
| `PUT` | `/api/bridge/:bridge_id/accept` | Accept a bridge request |
| `PUT` | `/api/bridge/:bridge_id/close` | Close a bridge |
| `GET` | `/api/bridges` | List active bridges |
| `GET` | `/api/bridge/:bridge_id/messages` | Get bridged conversation |

### Cross-Workspace AI Routing

When a user types `@trading-ai <query>`, the message routes to the target workspace's AI with the target's tools and system prompt. `@ai` always routes locally. Both responses are broadcast to all bridged users.

## Deployment

For a 100-person fund with 5 desks:

```bash
GCP_PROJECT=fund-infra ./deploy-gke.sh compliance "Compliance"
GCP_PROJECT=fund-infra ./deploy-gke.sh trading "Trading Desk"
GCP_PROJECT=fund-infra ./deploy-gke.sh risk "Risk Management"
GCP_PROJECT=fund-infra ./deploy-gke.sh quant "Quant Research"
GCP_PROJECT=fund-infra ./deploy-gke.sh ops "Operations"
```

5 workspace pods, shared PostgreSQL, shared A2A agent pool. Each desk has its own AI, tools, and data access. Bridges connect them on demand.

## Pricing

| Tier | Workspaces | Bridges | |
|---|---|---|---|
| **Open Source** | 1 | — | Free |
| **Team** | Up to 5 | Within team | Contact sales |
| **Enterprise** | Unlimited | Cross-workspace | Contact sales |

---

*Roundtable by [Foxtrot Communications](https://foxtrotcommunications.net) — AI workspace platform for teams that can't send their data to the cloud.*
