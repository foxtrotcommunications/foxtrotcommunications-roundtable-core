# Documentation

## Architecture

Roundtable uses a **workspace-per-pod** architecture where each workspace runs as an independent container with:

- **Express** server with Socket.IO for real-time multiplayer
- **React** client (Vite) built at Docker build time (multi-stage build)
- **PostgreSQL** for persistence (messages, users, workspaces, usage tracking); **SQLite** auto-fallback when no `DATABASE_URL` is set (local dev)
- **AI Provider integration** (Vertex AI, OpenAI, Anthropic, Google AI)
- **Tool system** with per-workspace allowlists

## Deployment Guides

| Guide | Description |
|---|---|
| [README](../README.md) | Quick start with Docker Compose or local dev |
| `deploy-gke.sh --setup` | Full GKE cluster setup with Cloud SQL + Workload Identity |
| `deploy-cloudrun.sh` | Cloud Run single-workspace deployment |
| `deploy-k8s.sh` | Generic Kubernetes deployment |

## Schema Files

Place `.yaml` schema files in `workspace/uploads/` to give the AI knowledge of your data warehouse tables. See `schemas/example_northwind.yaml` for the format.

## Configuration

See `.env.example` for all available environment variables.

## Cross-Workspace Communication

Roundtable supports two types of cross-workspace communication, both governed by cryptographic contracts.
The wire protocol is **A2A** (JSON-RPC 2.0 over HTTP).

### Bridge Tools

| Tool | Purpose | Latency | LLM Tokens |
|------|---------|---------|------------|
| `bridge_workspace` | AI-to-AI reasoning delegation (E2E encrypted) | ~3-5s | Full inference on receiver |
| `intent_bridge` | Compiled intent execution (ICE protocol) | ~15ms hot / ~250s cold (max) | Zero |

### Wake-on-Request

Workspaces scaled to zero replicas are automatically woken when a bridge request arrives. The calling workspace:
1. Detects a 502 or 503 (sleeping target)
2. Scales the target deployment via K8s API
3. Retries every 5s with fresh HMAC signatures (up to `MAX_WAKE_WAIT_MS` = 250 000 ms ≈ ~250s)
4. Returns results once the target is healthy

### Contract Governance

Every cross-workspace action requires an active governance contract with explicit `allowedActions`. Actions are enforced at two layers:

1. **Transport layer** — `X-Contract-Action` header verified against contract `allowedActions` in the auth middleware
2. **Intent layer** — `intent/execute` handler checks the specific operation (e.g., `query:query_bigquery`) against the contract

Transport-level actions (`message`, `delegate`) are auto-allowed for active contracts. All intent operations must be explicitly listed.

Example contract `allowedActions`:
```json
["message", "delegate", "signal_transfer", "discover", "query:query_bigquery"]
```
