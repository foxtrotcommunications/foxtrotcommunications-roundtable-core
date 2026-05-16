# Documentation

## Architecture

Roundtable uses a **workspace-per-pod** architecture where each workspace runs as an independent container with:

- **Express** server with Socket.IO for real-time multiplayer
- **React** client (Vite) built at container start
- **PostgreSQL** for persistence (messages, users, workspaces, usage tracking)
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
