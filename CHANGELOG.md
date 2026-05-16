# Changelog

All notable changes to Roundtable will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **CI/CD** — GitHub Actions for tests (Node 20+22) and GHCR Docker image publishing
