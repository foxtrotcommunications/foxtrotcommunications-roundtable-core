# Cross-Workspace Compliance Investigation

> **Industry**: Financial Services — Hedge Funds, Asset Managers, Broker-Dealers  
> **Feature**: Workspace Bridges  
> **Status**: Planned  

## The Problem

In a multi-desk hedge fund, compliance investigations require data that lives in other teams' systems. When a compliance analyst spots an anomalous securities transaction, they need:

1. **Trading data** from the execution desk (fills, timestamps, counterparties)
2. **Position data** from the portfolio management system
3. **Communication records** for the relevant trader
4. **Restricted list** checks against their own compliance database

Today this involves emails, Slack threads, Bloomberg terminal screenshots, and manual data requests — none of which produce a unified audit trail. Investigations that should take hours take days.

## The Solution: Workspace Bridges

Roundtable's workspace bridge feature enables **AI-mediated cross-team collaboration** where each team retains its own tools and data access, but can open a shared channel for joint investigation.

### Architecture

```
GKE Cluster (Fund Infrastructure)
│
├── rt-compliance ──── Bridge ──── rt-trading
│   👤 Compliance Officer              👤 Head Trader
│   👤 Compliance Analyst              👤 Execution Trader
│   🤖 Compliance AI                   🤖 Trading AI
│   │                                  │
│   ├── 📋 Restricted List DB          ├── 📈 Bloomberg Agent (A2A)
│   ├── 📊 Regulatory Filings          ├── 💹 OMS / Execution Data
│   ├── 🛡️ Communication Archive       ├── 📊 Position Database
│   └── 📁 Investigation Case Files    └── 📁 Trade Blotters
│
├── rt-risk ──── Bridge ──── rt-compliance
│   👤 Risk Manager
│   🤖 Risk AI
│   │
│   ├── 📉 VaR Models
│   ├── 📊 Exposure Analytics
│   └── 🔥 Stress Test Engine
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

### 1. Compliance Detects an Anomaly

The compliance analyst is working in the `rt-compliance` workspace and queries their surveillance database:

```
Compliance Analyst:
@ai Show me all trades flagged by our wash trade detection
model in the past 48 hours.

Compliance AI:
[queries surveillance database]

3 trades flagged:
| Symbol | Side | Qty   | Price  | Time           | Flag Score |
|--------|------|-------|--------|----------------|------------|
| AAPL   | Buy  | 5,000 | 198.42 | May 14, 10:32a | 0.87       |
| AAPL   | Sell | 5,000 | 198.45 | May 14, 10:34a | 0.87       |
| TSLA   | Buy  | 2,000 | 178.90 | May 14, 2:15p  | 0.62       |

The AAPL pair (buy/sell within 2 minutes, same quantity, $0.03
spread) scores 0.87 on the wash trade model. This warrants
investigation.
```

### 2. Opening a Bridge to Trading

The compliance analyst needs execution details that only the trading desk has. They open a bridge:

```
Compliance Analyst clicks: [🔗 Bridge → Trading Desk]

System: Bridge request sent to rt-trading.
        Waiting for acceptance...

Head Trader (in rt-trading): [✓ Accept Bridge]

System: Bridge established between Compliance and Trading Desk.
        All messages in this channel are visible to both
        workspaces and logged for regulatory compliance.
```

### 3. Cross-Workspace AI Query

Now the compliance analyst can query the **trading workspace's AI**, which has access to Bloomberg and the order management system:

```
Compliance Analyst:
@trading-ai Show me the full execution details for the AAPL
trades on May 14 between 10:30a and 10:35a. Include
counterparties, venue, and order origination.

Trading AI: [queries OMS, Bloomberg execution data]

Order 1 (Buy):
  Symbol: AAPL | Side: Buy | Qty: 5,000 | Avg Price: $198.42
  Venue: NASDAQ | Counterparty: Citadel Securities
  Order Type: Limit | Originator: jsmith (Algo Desk)
  Parent Order ID: PO-2024-88412
  Strategy: VWAP

Order 2 (Sell):
  Symbol: AAPL | Side: Sell | Qty: 5,000 | Avg Price: $198.45
  Venue: NYSE | Counterparty: Virtu Financial
  Order Type: Market | Originator: jsmith (Algo Desk)
  Parent Order ID: PO-2024-88415
  Strategy: Manual

Note: Different parent order IDs suggest these were independent
orders, not legs of the same strategy. The buy was algorithmic
(VWAP), the sell was manual, placed 2 minutes later.
```

### 4. Compliance Follows Up with Own Tools

The compliance analyst uses **their own AI** (which has the restricted list and communication archive):

```
Compliance Analyst:
@ai Check if jsmith has any active restrictions on AAPL, and
pull any communications mentioning AAPL from the past week.

Compliance AI: [queries restricted list, communication archive]

Restricted List Check:
  ✅ AAPL is NOT on the firm restricted list
  ✅ jsmith has no personal trading restrictions on AAPL

Communications (past 7 days):
  3 results for "AAPL" in jsmith's communications:
  
  1. May 13, 4:45p — Slack to mwilson (PM):
     "AAPL looking heavy into close, might want to trim"
  2. May 14, 10:28a — Bloomberg chat to external (Citadel):
     "Working a 5k AAPL buy, VWAP, 30min horizon"
  3. May 14, 10:33a — Slack to self-note:
     "Filled on AAPL buy. PM says reverse it, wrong account"

The third communication is significant — "wrong account" suggests
the sell was a correction, not a wash trade. Recommend requesting
the PM's confirmation and the account transfer records.
```

### 5. Escalation via Additional Bridge

Compliance now opens a bridge to the Risk workspace:

```
Compliance Analyst clicks: [🔗 Bridge → Risk]

Compliance Analyst:
@risk-ai What's the current net AAPL exposure across all
accounts managed by the equity desk?

Risk AI: [queries position and exposure systems]

AAPL Exposure Summary (as of May 15, 8:00a):
  Account A (Equity Long/Short): +12,000 shares ($2.38M)
  Account B (Market Neutral):     -3,000 shares ($595K)
  Account C (Algo Trading):            0 shares

Net Firm Exposure: +9,000 shares ($1.79M)

Note: Account C (Algo Trading, managed by jsmith) shows zero
position. The 5,000 share buy/sell cycle on May 14 resulted
in a flat position — consistent with a trade correction
rather than a directional bet.
```

### 6. Resolution

The compliance analyst now has a complete picture across three workspaces, assembled in minutes:

- **Trading desk** provided execution details showing independent orders with different strategies
- **Compliance tools** found the communication trail explaining the correction
- **Risk systems** confirmed the net-zero position in the relevant account

```
Compliance Analyst:
@ai Summarize this investigation and draft a disposition memo
for the AAPL wash trade alert (May 14).

Compliance AI:
[generates memo with citations from all three data sources]

DISPOSITION: FALSE POSITIVE — Trade Correction
...
```

The entire investigation — flagging, cross-desk data gathering, communication review, risk confirmation, and disposition — happened in a single bridged session. Every message, every tool call, and every AI response is logged with workspace attribution.

## Technical Requirements

### Database Schema

```sql
-- New table for bridge management
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

-- Existing messages table already has:
--   source_workspace_id TEXT  ← tags message origin in bridged conversations
```

### API Endpoints

```
POST   /api/bridge/:target_workspace_id    Open a bridge request
PUT    /api/bridge/:bridge_id/accept       Accept a bridge request
PUT    /api/bridge/:bridge_id/close        Close a bridge
GET    /api/bridges                        List active bridges for this workspace
GET    /api/bridge/:bridge_id/messages     Get bridged conversation history
```

### Socket.IO Events

```
bridge:request      → target workspace receives bridge request
bridge:accepted     → originating workspace is notified
bridge:message      → broadcast to all users in both workspaces
bridge:closed       → both workspaces notified
```

### Cross-Workspace AI Routing

When a user types `@trading-ai <query>`:

1. The message is sent to the bridge channel
2. The **target workspace's AI** processes the query with the target workspace's tools and system prompt
3. The response is broadcast to all users in both bridged workspaces
4. The message is saved with `source_workspace_id` set to the originating workspace

`@ai` (without a workspace prefix) always routes to the local workspace's AI.

## Regulatory Compliance

This feature is designed for environments subject to SEC, FINRA, FCA, and MiFID II requirements:

| Requirement | How Roundtable Addresses It |
|---|---|
| **Books and records** (SEC 17a-4) | Every bridged message is persisted in PostgreSQL with timestamp, user ID, workspace origin, and tool call details |
| **Supervisory review** (FINRA 3110) | Bridge requests require acceptance by the target workspace; all AI tool calls are logged |
| **Communication surveillance** | AI queries across workspaces are captured as structured data, not ephemeral chat |
| **Information barriers** | Workspaces maintain tool isolation — compliance cannot directly access trading tools or data without an explicit, logged bridge |
| **Audit trail reconstruction** | `source_workspace_id` on every message enables full reconstruction of cross-desk information flow |

## Deployment Topology

For a 100-person hedge fund with 5 desks:

```bash
GCP_PROJECT=fund-infra ./deploy-gke.sh compliance "Compliance"
GCP_PROJECT=fund-infra ./deploy-gke.sh trading "Trading Desk"
GCP_PROJECT=fund-infra ./deploy-gke.sh risk "Risk Management"
GCP_PROJECT=fund-infra ./deploy-gke.sh quant "Quant Research"
GCP_PROJECT=fund-infra ./deploy-gke.sh ops "Operations"
```

5 workspace pods, shared PostgreSQL, shared A2A agent pool. Each desk has its own AI, tools, and data access. Bridges connect them on demand.

## Pricing Tier

Workspace bridges are an **enterprise tier** feature:

| Tier | Workspaces | Bridges | Price |
|---|---|---|---|
| **OSS (open source)** | 1 | — | Free |
| **Team** | Up to 5 | Within team | $X/workspace/mo |
| **Enterprise** | Unlimited | Cross-workspace | $X/workspace/mo + support |

---

*This use case is based on real regulatory workflows in financial services. The Roundtable architecture — workspace isolation, shared database, AI tool routing, and persistent audit trails — was designed to support this class of compliance-critical, cross-team collaboration.*
