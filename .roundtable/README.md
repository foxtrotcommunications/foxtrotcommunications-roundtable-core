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

## ICE (Intent Compiled Execution)

ICE is the execution model for cross-workspace operations. The principle is simple:

> **Your AI reasons about what the user needs. ICE executes it. The target AI is
> not involved unless delegation is genuinely needed.**

When your AI determines that data or an action is needed from another workspace,
it compiles a structured **intent token** — a cryptographically signed, deterministic
instruction. The receiving workspace executes the token directly without invoking
its own LLM. This eliminates inference latency, reduces cost, and produces
audit-grade execution proofs.

### ICE Operations

| Operation | Description |
|-----------|-------------|
| `query` | Execute a read-only SQL query on the target workspace's data source. |
| `tool_call` | Invoke a specific tool on the target workspace (e.g., `web_search`, `read_file`). |
| `capability` | Call a typed capability published by the target workspace (preferred for structured operations). |
| `discover` | List available capabilities, tools, and data sources on the target workspace. |
| `aggregate` | Fan out multiple operations and merge results in a single round trip. |

### When to Use ICE vs Delegation

Follow this hierarchy — prefer the highest option that satisfies the need:

1. **Capability call** (preferred) — The target workspace publishes a typed capability. Call it directly via ICE.
2. **Data query** — You need data from the target workspace. Send a `query` intent token.
3. **Tool invocation** — You need a specific tool executed. Send a `tool_call` intent token.
4. **Delegation** (last resort) — The task genuinely requires the target workspace's AI to *reason*. Use `bridge_workspace` with `action: delegate`.

---

## Capability Registry

Workspaces publish **typed capabilities** that other workspaces can discover and call
via ICE. Each capability has a name, version, JSON Schema for its input and output,
and is governed by contracts.

### Key Properties

| Property | Description |
|----------|-------------|
| **Typed** | Each capability has a unique name and semantic version (e.g., `medication.check_interaction@1.2.0`). |
| **Schema-validated** | Inputs and outputs are validated against JSON Schema before execution and before returning results. |
| **Contract-governed** | A capability can only be called if an active contract authorizes the calling workspace. |
| **Discoverable** | Use the ICE `discover` operation to list capabilities available on a bridged workspace. |

### How Capabilities Work

1. A workspace registers capabilities with typed schemas (e.g., `formulary.lookup`, `billing.estimate`).
2. A calling workspace's AI uses `discover` to find what's available.
3. The AI compiles a `capability` intent token with the required input.
4. ICE validates the input against the capability's JSON Schema, executes it, validates the output, and returns a signed result with an execution proof.

No LLM inference is needed on the receiving side. The capability executes deterministically.

---

## Bridges

Bridges are **bidirectional, HMAC-authenticated communication channels** connecting
two workspaces. They establish the *potential* for collaboration — the secure pipe
between workspaces. However, a bridge alone does not authorize any activity.
**A governance contract is required before any cross-workspace communication can occur.**

### Operations

| Action | Description |
|--------|-------------|
| `delegate` | Ask the connected workspace's AI agent to run a task using its local tools and data. Only the final result is returned — no raw database access is exposed across the bridge. This should be used only when the target AI genuinely needs to reason about the task. |

### How to Use

Call the `bridge_workspace` tool with:
- `target`: The name of the workspace to reach (e.g., "Pharmacy AI")
- `action`: `delegate`
- `content`: The task to send

For structured operations (queries, tool calls, capability invocations), use `intent_bridge` instead.

### How to Discover Your Bridges

Call `describe_workspace`. The `bridges` array shows your active connections,
including target names, IDs, and permitted actions.

---

## Cross-Workspace Execution Model

When working across workspaces, follow this mental model:

> Your AI reasons about what the user needs. ICE executes it. The target AI is
> not involved unless delegation is genuinely needed.

**Hierarchy** (prefer the top):

1. **Capability call** — Target publishes a typed capability → call it via ICE `capability` operation.
2. **Data query** — Need data → send a `query` intent token via ICE.
3. **Tool invocation** — Need a tool run → send a `tool_call` intent token via ICE.
4. **Delegation** — Need the target AI to *think* → use `bridge_workspace` with `delegate` (rare).

Most cross-workspace needs are satisfied by capabilities or queries. Delegation
should be reserved for genuinely open-ended reasoning tasks.

---

## Contracts

Contracts are **directional, typed, approval-gated governance agreements** that
authorize specific actions across a bridge. Without an active contract, a bridge
is dormant — no delegations, no data flows, no capability calls. Contracts are the
authorization layer that brings bridges to life.

### Key Properties

| Property | Description |
|----------|-------------|
| **Directional** | Source → Target (asymmetric). A bridge is bidirectional, but each contract is one-way. Two contracts are needed for full bidirectional governance. |
| **Typed** | Each contract has a type that defines its purpose and preset allowed actions. |
| **Approval-gated** | Both workspace admins must approve. Material changes (allowed actions, type, escalation target) trigger a re-approval flow. Original terms stay active until re-approved. |
| **Action-scoped** | Contracts define specific allowed actions beyond basic delegate. |

### Contract Types

| Type | Typical Actions |
|------|----------------|
| `General` | `delegate` |
| `MedicationRequest` | `request_medication_review`, `check_inventory`, `flag_interaction`, `request_formulary_check` |
| `PatientHandoff` | `initiate_handoff`, `accept_handoff`, `update_status` |
| `ClinicalEscalation` | `escalate_case`, `acknowledge_escalation`, `resolve_escalation` |
| `FinancialReport` | `request_report`, `submit_report`, `approve_report` |
| `DataQuery` | `query_data`, `export_results` |
| `McpToolAccess` | `tools_list`, `tools_call`, `resources_read`, `resources_list` |
| `AgentDelegation` | `delegate`, `tasks_get`, `tasks_cancel`, `stream_subscribe` |

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
4. **Prefer ICE over delegation.** If the task can be expressed as a capability call,
   query, or tool invocation, use `intent_bridge`. Only delegate when the target AI
   genuinely needs to reason.
