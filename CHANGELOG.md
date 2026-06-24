# Changelog

All notable changes to Roundtable will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Intent Compiled Execution (ICE) engine** — Compiles AI reasoning into deterministic, cryptographically signed intent tokens with 5 operations: `query`, `tool_call`, `capability`, `discover`, `aggregate`
- **Capability registry** — Workspaces publish typed capabilities with JSON Schema validation, semantic versioning, and contract-governed access; discoverable via ICE `discover` operation
- **HKDF cryptographic contract authentication** — Per-contract keys derived via HKDF with AES-256-GCM end-to-end encryption for all cross-workspace payloads
- **Cross-workspace execution model** — AI reasons locally, ICE executes remotely; target AI is not involved unless delegation is genuinely needed
- **Wake-proxy for sleeping workspaces** — Sleeping workspaces are woken on-demand when an inbound intent token or delegation arrives
- **Wake-on-request (K8s API)** — Bridge tools (`intent_bridge`, `bridge_workspace`) detect sleeping target workspaces (HTTP 503) and automatically scale them from 0→1 replicas via the Kubernetes API, then retry with fresh HMAC signatures every 5s for up to 250s
- **X-Contract-Action header** — Bridge requests now include an `X-Contract-Action` header carrying the signed action name, allowing the receiver's auth middleware to verify the correct HMAC payload instead of hardcoding `message_send`
- **Verbose bridge retry logging** — Both `intent_bridge` and `bridge_workspace` log each retry attempt with elapsed time and HTTP status for operational visibility
- **429 auto-fallback** — When Vertex AI returns `RESOURCE_EXHAUSTED` (429), automatically retries with `gemini-3.5-flash` and restores the original model after a 10-minute cooldown. Streams a brief notice to the user during fallback
- **Debt domain transaction tools** — `plaid.getBalances` and `plaid.getTransactions` capabilities added to the debt domain module, matching the checking/savings toolset for credit card and loan transaction access
- **Plaid sign normalization** — Universal `normalizeAmount()` negates all Plaid amounts at sync time, converting from Plaid convention (positive=money out) to standard accounting (positive=money in, negative=money out)
- **Pendragon tools plugin (v1.0.1)** — `@pendragon/tools-plaid` published to Google Artifact Registry with 3 domain modules (checking, debt, investments), Chinese Wall account-type isolation, and domain-scoped capability registration

### Changed

- **`bridge_workspace` simplified to delegate-only** — The `message` action has been removed; bridges now support only `delegate` for tasks requiring the target AI to reason. For structured operations, use `intent_bridge`
- **Contract auth strict enforcement** — Transport action whitelist restricted to protocol-level actions only (`message`, `delegate`, `message_send`, `tasks_get`, `tasks_cancel`). All intent operations (`discover`, `query:*`, `tool:*`, `capability:*`, `aggregate`) must be explicitly listed in the contract's `allowedActions`

## [1.0.0] — 2026-05-16

### Added

- **Multiplayer AI workspace** — Real-time collaborative chat with AI assistants via Socket.IO
- **Multi-provider AI** — Vertex AI, OpenAI, Anthropic, and Google AI with streaming tool calling
- **Tool system** — Calculator, web search, URL reader, code execution, file I/O, BigQuery, Snowflake, Databricks
- **Per-workspace tool allowlists** — Control which tools are available in each workspace
- **Meta-tools** — `describe_workspace` and `verify_workspace` for AI self-discovery
- **Usage tracking** — Per-request token counts, tool call metrics, user attribution
- **Usage API** — `GET /api/workspace/usage` with by-user and by-model breakdowns
- **Token display** — Inline token usage indicator in chat UI
- **Dual database support** — PostgreSQL (production) and SQLite (development)
- **GKE deployment** — One-command deploy with Cloud SQL proxy, Workload Identity, nginx ingress
- **Cloud Run deployment** — Single-workspace serverless option
- **Docker Compose quickstart** — `docker compose up` to run locally
- **Schema injection** — YAML schema files auto-injected into AI system prompt
- **Presence system** — Live user avatars, typing indicators, @mention notifications
- **Code explorer** — In-browser file tree for cloned repositories
- **CI/CD** — GitHub Actions for tests (Node 20+22) and Artifact Registry Docker image publishing
