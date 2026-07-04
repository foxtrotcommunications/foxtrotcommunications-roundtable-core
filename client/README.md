# Roundtable Client

The Roundtable workspace client — a real-time collaborative AI chat interface.

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| **React 19** | UI framework |
| **Vite 8** | Build tool and dev server |
| **TypeScript** | Type safety |
| **Socket.IO** | Real-time WebSocket communication with the server |
| **Chart.js / react-chartjs-2** | Chart rendering (bar, line, pie, treemap) |
| **ECharts** | Advanced interactive visualizations |
| **react-markdown** | Markdown message rendering with GFM support |
| **KaTeX** | LaTeX math rendering in messages |
| **Mermaid** | Diagram rendering in messages |
| **react-router-dom** | Client-side routing |

## Development

```bash
cd client
npm install
npm run dev
```

The Vite dev server proxies API and WebSocket requests to the Express backend on port 3000.

## Build

```bash
npm run build     # TypeScript check + Vite production build → client/dist/
```

In Docker, the client is built in a separate stage (`client-build`) and the output is copied into the final image. See the root `Dockerfile` for details.

## Project Structure

```
client/
├── src/
│   ├── components/    # React components (Chat, Settings, CodeExplorer, etc.)
│   ├── App.tsx        # Root application component
│   └── main.tsx       # Entry point
├── public/            # Static assets
├── index.html         # HTML entry point
├── vite.config.ts     # Vite configuration
└── tsconfig.json      # TypeScript configuration
```
