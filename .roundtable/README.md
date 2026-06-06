# Roundtable Platform Reference

> **This directory is read-only.** It contains authoritative platform documentation.
> For live data about your current configuration, call the `describe_workspace` tool.

---

## What is Roundtable?

Roundtable is a multiplayer AI workspace platform. Organizations deploy multiple
specialized workspaces (e.g., Billing AI, Pharmacy AI, Executive AI) that operate
independently with their own tools, data sources, and AI configurations. Workspaces
collaborate through **Bridges** and are governed by **Contracts**.

---

## Bridges

Bridges are **bidirectional, HMAC-authenticated communication channels** connecting
two workspaces. They establish the *potential* for collaboration — the secure pipe
between workspaces. However, a bridge alone does not authorize any activity.
**A governance contract is required before any cross-workspace communication can occur.**

### Operations

| Action | Description |
|--------|-------------|
| `message` | Post a chat message to the connected workspace's feed. All users in that workspace will see it. |
| `delegate` | Ask the connected workspace's AI agent to run a task using its local tools and data. Only the final result is returned — no raw database access is exposed across the bridge. |

### How to Use

Call the `bridge_workspace` tool with:
- `target`: The name of the workspace to reach (e.g., "Pharmacy AI")
- `action`: Either `message` or `delegate`
- `content`: The message or task to send

The bridge enforces permissions — if a bridge only allows `message`, you cannot `delegate`.

### How to Discover Your Bridges

Call `describe_workspace`. The `bridges` array shows your active connections,
including target names, IDs, and permitted actions.

---

## Contracts

Contracts are **directional, typed, approval-gated governance agreements** that
authorize specific actions across a bridge. Without an active contract, a bridge
is dormant — no messages, no delegations, no data flows. Contracts are the
authorization layer that brings bridges to life.

### Key Properties

| Property | Description |
|----------|-------------|
| **Directional** | Source → Target (asymmetric). A bridge is bidirectional, but each contract is one-way. Two contracts are needed for full bidirectional governance. |
| **Typed** | Each contract has a type that defines its purpose and preset allowed actions. |
| **Approval-gated** | Both workspace admins must approve. Material changes (allowed actions, type, escalation target) trigger a re-approval flow. Original terms stay active until re-approved. |
| **Action-scoped** | Contracts define specific allowed actions beyond basic message/delegate. |

### Contract Types

| Type | Typical Actions |
|------|----------------|
| `General` | `message`, `delegate` |
| `MedicationRequest` | `request_medication_review`, `check_inventory`, `flag_interaction`, `request_formulary_check` |
| `PatientHandoff` | `initiate_handoff`, `accept_handoff`, `update_status` |
| `ClinicalEscalation` | `escalate_case`, `acknowledge_escalation`, `resolve_escalation` |
| `FinancialReport` | `request_report`, `submit_report`, `approve_report` |
| `DataQuery` | `query_data`, `export_results` |
| `McpToolAccess` | `tools_list`, `tools_call`, `resources_read`, `resources_list` |
| `AgentDelegation` | `message_send`, `tasks_get`, `tasks_cancel`, `stream_subscribe` |

### Bridges vs Contracts

| Aspect | Bridges | Contracts |
|--------|---------|-----------|
| **Purpose** | Connectivity — *can we talk?* | Authorization — *what can we do?* |
| **Direction** | Bidirectional | Directional (source → target) |
| **Permissions** | None (connectivity only) | Fine-grained action lists |
| **Approval** | Admin creates | Both admins must approve |
| **Mutability** | Toggle on/off | Changes require re-approval |

### How to Discover Your Contracts

Call `describe_workspace`. The `contracts` array shows your active governance
agreements, including type, direction, counterparty, allowed actions, and
escalation targets.

---

## Important Rules

1. **Never fabricate information** about your bridges, contracts, or capabilities.
   Always call `describe_workspace` to get live data from the control plane.
2. **Never claim files or schemas exist** without verifying via your file tools.
3. **Contracts are NOT data schema validators.** They govern cross-workspace
   authorization — who can do what. They do not enforce database schemas,
   column naming, or CI/CD pipeline validation.
