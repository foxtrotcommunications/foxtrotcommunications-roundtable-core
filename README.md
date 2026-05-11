# 🎙️ Roundtable

**Real-time multiplayer AI chat sharing platform.**

Multiple users collaborate on AI conversations together in real-time — like Google Docs meets ChatGPT. Create a room, invite your team, and chat with AI as a group. Every message and AI response streams live to all participants.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

## Features

- **Multiplayer AI Chat** — Multiple users in the same AI conversation, real-time
- **Multi-Provider** — OpenAI, Anthropic (Claude), and Google (Gemini) support
- **Tool Use** — AI can search the web, read URLs, run calculations, and execute code
- **BYOK** — Bring Your Own Key; each user configures their own API keys
- **Rooms** — Create rooms with invite codes, choose provider/model per room
- **Presence** — See who's online in each room
- **Streaming** — AI responses stream token-by-token to all participants
- **Self-Hosted** — Run locally, in Docker, or on Kubernetes
- **Embeddable** — Embed in other apps (like Anvil) via iframe with `EMBED_MODE=true`
- **No Build Step** — Pure HTML/CSS/JS frontend, zero build toolchain

## Quick Start

```bash
# Clone
git clone https://github.com/bb-ftcomm/foxtrotcommunications-roundtable.git
cd foxtrotcommunications-roundtable

# Configure
cp .env.example .env
# Edit .env with your SESSION_SECRET and optional AI API keys

# Install & run
npm install
npm run dev

# Open http://localhost:3000
```

## Docker

```bash
cp .env.example .env
# Edit .env

docker compose up
# Open http://localhost:3000
```

## Kubernetes

```bash
# Build and push the image
docker build -t your-registry/roundtable:latest .
docker push your-registry/roundtable:latest

# Update k8s/deployment.yaml with your image
# Update k8s/configmap.yaml with your config

kubectl apply -f k8s/
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `SESSION_SECRET` | (required) | Secret for session cookies |
| `DB_PATH` | `./data/roundtable.db` | SQLite database file path |
| `EMBED_MODE` | `false` | Allow iframe embedding |
| `OPENAI_API_KEY` | (optional) | Server-level OpenAI fallback key |
| `ANTHROPIC_API_KEY` | (optional) | Server-level Anthropic fallback key |
| `GOOGLE_AI_API_KEY` | (optional) | Server-level Google AI fallback key |

Users can also add their own API keys in the Settings panel.

## Built-in Tools

When tools are enabled for a room, the AI can use:

| Tool | Description |
|------|-------------|
| **Web Search** | Search the web via DuckDuckGo (no API key needed) |
| **URL Reader** | Fetch and extract text from web pages |
| **Calculator** | Evaluate math expressions (powered by mathjs) |
| **Code Runner** | Execute JavaScript in a sandboxed environment |

## Architecture

```
Browser (Vanilla JS + Socket.IO) ←→ Express + Socket.IO Server ←→ SQLite
                                          ↓
                                    AI Providers
                                  (OpenAI / Anthropic / Google)
```

- **Backend**: Node.js, Express, Socket.IO
- **Database**: SQLite via sql.js (pure JS, no native deps)
- **Frontend**: Vanilla HTML/CSS/JS (no build step)
- **Real-time**: Socket.IO for WebSocket communication

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## License

[Apache License 2.0](LICENSE)

Built by [Foxtrot Communications](https://github.com/bb-ftcomm)
