# React Migration — Implementation Plan

**Migrate Roundtable's frontend from vanilla JS to React + Vite**

---

## Why Migrate

The current frontend is 7 vanilla JS files (1,485 LOC) + 1 CSS file (343 LOC) + 2 HTML files. This works today, but it's hitting limits:

| Problem | Current Impact | React Solution |
|---------|---------------|----------------|
| **No component model** | `chat.js` is 507 lines with rendering, state, formatting, and DOM manipulation interleaved | Components: `<ChatMessage>`, `<ToolCard>`, `<CodeBlock>` |
| **Manual DOM updates** | `innerHTML +=` everywhere, full re-renders on every chunk | React reconciliation, targeted re-renders |
| **No state management** | Global mutable objects (`Chat.streamingContent`, `App.currentUser`) scattered across files | React state/context, predictable data flow |
| **Scaling risk** | Adding A2A agents tab, Plotly charts, RBAC UI will push vanilla JS past maintainability | Component composition, code splitting |
| **Contributor barrier** | Custom vanilla patterns (`Chat.init()`, `Settings.open()`) require reading all code to understand | Standard React patterns that any frontend dev knows |
| **No type safety** | Zero IDE assistance, runtime errors only | TypeScript + React gives full type checking |

### What Works Fine (Don't Over-Engineer)

- **Server is unchanged.** Express + Socket.IO + PostgreSQL stay exactly as-is.
- **Socket events are unchanged.** The frontend just listens/emits the same events.
- **CSS can be preserved.** The existing design system (CSS custom properties, dark theme) migrates directly.
- **API layer is unchanged.** REST endpoints stay the same.

---

## Current Frontend Inventory

| File | LOC | Responsibility | React Equivalent |
|------|-----|---------------|-----------------|
| `app.js` | 107 | Init, routing, toast, modal | `<App>` root + React context |
| `chat.js` | 507 | Message rendering, streaming, tool cards, code blocks, markdown | `<ChatView>`, `<Message>`, `<ToolCard>`, `<StreamingMessage>` |
| `settings.js` | 273 | Settings modal, tabs, save/load | `<SettingsModal>`, `<AgentTab>`, `<ToolsTab>`, `<DataSourcesTab>` |
| `codePanel.js` | 393 | File tree, file viewer, resize | `<CodePanel>`, `<FileTree>`, `<FileViewer>` |
| `socket.js` | 78 | Socket.IO connection + event wiring | `useSocket()` hook |
| `auth.js` | 57 | Login/register form | `<LoginPage>` |
| `presence.js` | 39 | Online user indicators | `<PresenceBar>` |
| `api.js` | 31 | Fetch wrapper | `api.ts` utility module |
| `style.css` | 343 | Full design system | Migrates as-is (CSS modules or global) |
| `app.html` | 223 | Main app shell | JSX in `<App>` |
| `index.html` | — | Login page | `<LoginPage>` |

---

## Technology Choices

| Choice | Decision | Rationale |
|--------|----------|-----------|
| **Framework** | React 19 | Industry standard, largest ecosystem, Anvil already uses React |
| **Build tool** | Vite | Fast dev server, HMR, small bundle, easy config |
| **Language** | TypeScript | Type safety for socket events, tool result types, API responses |
| **Styling** | CSS Modules + existing CSS custom properties | Preserves current design, scoped styles, no new dependency |
| **State** | React Context + `useReducer` | Sufficient for current complexity. No Redux needed. |
| **Socket.IO** | `socket.io-client` + custom hook | Same protocol, React-idiomatic wrapper |
| **Markdown** | `react-markdown` + `rehype-highlight` | Replaces manual `marked` + `DOMPurify` + `hljs` with React-native solution |
| **Charts** | `react-plotly.js` (future) | For A2A agent visualization output |
| **Testing** | Vitest + React Testing Library | Fast, Vite-native, component testing |

---

## Component Architecture

```
src/
├── main.tsx                    # Entry point
├── App.tsx                     # Root layout + providers
├── api.ts                      # REST API client (typed)
├── socket.ts                   # Socket.IO client singleton
│
├── hooks/
│   ├── useSocket.ts            # Socket connection + event subscriptions
│   ├── useChat.ts              # Chat state: messages, streaming, tool calls
│   ├── usePresence.ts          # Online users, typing indicators, cursors
│   ├── useWorkspace.ts         # Workspace config, AI provider, model
│   └── useAuth.ts              # Current user, login/logout
│
├── context/
│   ├── AuthContext.tsx          # User session
│   ├── WorkspaceContext.tsx     # Workspace config + settings
│   └── SocketContext.tsx        # Socket.IO instance
│
├── components/
│   ├── chat/
│   │   ├── ChatView.tsx        # Main chat container (messages + input)
│   │   ├── ChatInput.tsx       # Textarea + send button + @mention
│   │   ├── Message.tsx         # Single message (user or AI)
│   │   ├── StreamingMessage.tsx # AI response during streaming
│   │   ├── ToolCard.tsx        # Collapsible tool call/result card
│   │   ├── QueryResultTable.tsx # BigQuery/Snowflake/Databricks result table
│   │   ├── SearchResults.tsx   # Web search result cards
│   │   ├── CodeBlock.tsx       # Syntax-highlighted code with copy button
│   │   └── MessageContent.tsx  # Markdown rendering + @mention highlighting
│   │
│   ├── code-panel/
│   │   ├── CodePanel.tsx       # Resizable side panel
│   │   ├── FileTree.tsx        # Directory tree with expand/collapse
│   │   └── FileViewer.tsx      # File content viewer with highlighting
│   │
│   ├── settings/
│   │   ├── SettingsModal.tsx   # Modal shell + tab navigation
│   │   ├── AgentTab.tsx        # AI provider + model + system prompt
│   │   ├── ToolsTab.tsx        # Tool enable/disable grid
│   │   ├── DataSourcesTab.tsx  # BigQuery/Snowflake/Databricks config
│   │   ├── ApiKeysTab.tsx      # Per-provider API key management
│   │   └── AgentsTab.tsx       # A2A agent discovery + registration (new)
│   │
│   ├── presence/
│   │   ├── PresenceBar.tsx     # Online user avatars
│   │   ├── TypingIndicator.tsx # "user is typing..." bar
│   │   └── UserCursor.tsx      # Scroll-position cursor label
│   │
│   └── common/
│       ├── Modal.tsx           # Reusable modal overlay
│       ├── Toast.tsx           # Toast notification
│       ├── Avatar.tsx          # User avatar with gradient
│       └── ResizeHandle.tsx    # Draggable resize divider
│
├── pages/
│   ├── LoginPage.tsx           # Auth page (login + register)
│   └── WorkspacePage.tsx       # Main workspace (chat + code panel)
│
├── types/
│   ├── message.ts              # Message, ToolCall, ToolResult types
│   ├── workspace.ts            # Workspace, DataSources, Agent types
│   ├── socket-events.ts        # All socket event payloads (typed)
│   └── agent.ts                # A2A AgentCard, Skill types
│
└── styles/
    ├── globals.css              # CSS custom properties (migrated from style.css)
    ├── chat.module.css
    ├── settings.module.css
    ├── code-panel.module.css
    └── common.module.css
```

---

## Key Type Definitions

```typescript
// types/message.ts
export interface ChatMessage {
  id: number;
  workspace_id: string;
  user_id: number | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  username?: string;
  display_name?: string;
  tool_name?: string;
  tool_call_id?: string;
  created_at: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  callId: string;
}

export interface ToolResult {
  callId: string;
  result: QueryResult | FileResult | ShellResult | SearchResult | GenericResult;
}

export interface QueryResult {
  sql: string;
  rows: Record<string, unknown>[];
  columns: string[];
  totalRows: number;
  truncated: boolean;
  billingProject?: string;
}

// types/socket-events.ts
export interface ServerToClientEvents {
  'new-message': (msg: ChatMessage) => void;
  'ai-start': (data: { userId: number; username: string }) => void;
  'ai-chunk': (data: { content: string }) => void;
  'ai-tool-call': (data: ToolCall) => void;
  'ai-tool-result': (data: ToolResult) => void;
  'ai-done': (data: { fullText: string }) => void;
  'ai-error': (data: { error: string }) => void;
  'presence-update': (data: PresenceData) => void;
  'typing': (data: { userId: number; username: string }) => void;
}

export interface ClientToServerEvents {
  'send-message': (data: { content: string; activeRepo?: string }) => void;
  'stop-generation': () => void;
  'cursor-position': (data: { messageId: string }) => void;
}
```

---

## Migration Strategy

### Approach: Parallel Build, Not Incremental

The frontend is only 1,485 LOC of JS. It's small enough to rewrite cleanly rather than incrementally wrapping vanilla JS in React.

**Do NOT try to embed React inside the existing vanilla app.** The global mutable state (`Chat`, `Settings`, `Socket`, `App` objects) and direct DOM manipulation are fundamentally incompatible with React's rendering model.

### Phase 1: Scaffold + Core (3-4 days)

1. Initialize Vite + React + TypeScript in a `client/` directory
2. Configure Vite to proxy `/api/*` and `/socket.io/*` to the Express server
3. Build `<App>`, `<LoginPage>`, `<WorkspacePage>` shells
4. Implement `useSocket` hook with typed events
5. Implement `useAuth` hook + `AuthContext`

**Deliverable:** Login works, socket connects, empty chat view renders.

### Phase 2: Chat (3-4 days)

1. `<ChatView>` with `useChat` hook (message list + streaming state)
2. `<ChatInput>` with auto-resize, Enter-to-send, @mention detection
3. `<Message>` component with markdown rendering (`react-markdown`)
4. `<StreamingMessage>` with incremental content updates
5. `<ToolCard>` with expand/collapse and smart result rendering
6. `<QueryResultTable>` for BigQuery/Snowflake/Databricks results
7. `<CodeBlock>` with syntax highlighting and copy button

**Deliverable:** Full chat functionality matches current vanilla JS.

### Phase 3: Settings + Presence (2-3 days)

1. `<SettingsModal>` with tab navigation
2. All 4 existing tabs: Agent, Tools, Data Sources, API Keys
3. `<PresenceBar>` with online user avatars
4. `<TypingIndicator>` bar
5. `<UserCursor>` scroll-position labels

**Deliverable:** Settings and presence match current behavior.

### Phase 4: Code Panel (2-3 days)

1. `<CodePanel>` with resizable split
2. `<FileTree>` with directory expand/collapse
3. `<FileViewer>` with syntax highlighting
4. `<ResizeHandle>` for panel and tree/viewer split

**Deliverable:** Code browser matches current behavior.

### Phase 5: Server Integration (1-2 days)

1. Update Express to serve Vite build output instead of `public/`
2. Configure production build (`vite build` → `client/dist/`)
3. Update Dockerfile to build client during container build
4. Keep `public/` directory as fallback during transition

**Deliverable:** Production deployment works with React frontend.

### Phase 6: New Features (enabled by React) (ongoing)

1. `<AgentsTab>` — A2A agent discovery and registration (from A2A spec)
2. `<PlotlyChart>` — inline Plotly charts from agent responses
3. `<AgentPresence>` — show agent activity in presence bar
4. Keyboard shortcuts, command palette
5. Mobile-responsive layout

---

## Server Changes

### Minimal

The server barely changes. The key modification:

```javascript
// server/index.js — serve Vite build instead of public/

// Development: Vite dev server proxies to Express
// Production: Express serves the built React app
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
  app.get('*', (req, res) => {
    // SPA fallback — serve index.html for all non-API routes
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/socket.io/')) {
      res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
    }
  });
} else {
  // Dev: serve public/ (vanilla JS) as fallback, Vite handles React
  app.use(express.static(path.join(__dirname, '..', 'public')));
}
```

### Vite Dev Proxy

```typescript
// client/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
```

---

## Migration Mapping

### chat.js (507 LOC) → 7 React Components

| Vanilla Function | React Component | Improvement |
|-----------------|-----------------|-------------|
| `Chat.renderMessage()` | `<Message>` | Declarative, no innerHTML |
| `Chat.showStreaming()` + `appendAIChunk()` | `<StreamingMessage>` | State-driven, no DOM mutation |
| `Chat.showToolCall()` + `showToolResult()` | `<ToolCard>` | Self-contained, typed result union |
| `Chat.formatContent()` | `<MessageContent>` with `react-markdown` | No manual regex/DOMPurify/hljs wiring |
| `Chat._processCodeBlocks()` | `<CodeBlock>` | Automatic via `rehype-highlight` plugin |
| `Chat.showUserCursor()` | `<UserCursor>` | Declarative positioning |
| Query result table (lines 296-335) | `<QueryResultTable>` | Reusable, sortable (future) |

### settings.js (273 LOC) → 5 React Components

| Vanilla Function | React Component |
|-----------------|-----------------|
| `Settings.open/close()` | `<SettingsModal open={...}>` |
| Tab switching logic | `<SettingsModal>` with `useState(activeTab)` |
| `Settings.loadAgent/saveAgent()` | `<AgentTab>` with form state |
| `Settings.loadTools/saveTools()` | `<ToolsTab>` with checkbox state |
| `Settings.loadDataSources/saveDataSources()` | `<DataSourcesTab>` with form state |

### socket.js (78 LOC) → useSocket hook

```typescript
// hooks/useSocket.ts
export function useSocket() {
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    const s = io({ withCredentials: true });
    setSocket(s);
    return () => { s.disconnect(); };
  }, []);

  // Typed event subscription
  const on = useCallback(<E extends keyof ServerToClientEvents>(
    event: E,
    handler: ServerToClientEvents[E]
  ) => {
    socket?.on(event, handler);
    return () => { socket?.off(event, handler); };
  }, [socket]);

  return { socket, on, emit: socket?.emit.bind(socket) };
}
```

---

## File Structure (Final)

```
foxtrotcommunications-roundtable/
├── client/                      # NEW — React frontend
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api.ts
│   │   ├── socket.ts
│   │   ├── hooks/               # 5 hooks
│   │   ├── context/             # 3 contexts
│   │   ├── components/          # ~20 components
│   │   ├── pages/               # 2 pages
│   │   ├── types/               # 4 type files
│   │   └── styles/              # CSS modules
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
│
├── server/                      # UNCHANGED
│   ├── index.js                 # Minor: serve client/dist in prod
│   ├── sockets/
│   ├── services/
│   ├── tools/
│   └── db/
│
├── public/                      # KEPT as fallback during migration
│   ├── js/
│   ├── css/
│   ├── app.html
│   └── index.html
│
├── package.json                 # Add client build scripts
└── Dockerfile                   # Add client build step
```

---

## Effort Estimate

| Phase | Work | Effort |
|-------|------|--------|
| Phase 1: Scaffold + Core | Vite + React + TypeScript, auth, socket hook | 3-4 days |
| Phase 2: Chat | Messages, streaming, tool cards, markdown, code blocks | 3-4 days |
| Phase 3: Settings + Presence | Settings modal (5 tabs), presence bar, typing | 2-3 days |
| Phase 4: Code Panel | File tree, file viewer, resize handles | 2-3 days |
| Phase 5: Server Integration | Vite build, Dockerfile, production serving | 1-2 days |
| **Total** | | **~2-3 weeks** |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| **Streaming performance** | React 19 concurrent rendering + `useDeferredValue` for markdown parsing during streaming |
| **Socket.IO reconnection** | `useSocket` hook handles reconnect + re-subscribe automatically |
| **Large message history** | Virtualized list (`react-window`) if history exceeds ~500 messages |
| **Bundle size** | Vite tree-shaking + lazy loading for CodePanel and Settings |
| **Regression** | Keep `public/` directory working during migration; feature flag to switch between old/new UI |
| **Parallel development** | A2A and other features can be built directly in React; no need to build in vanilla first |

---

## Decision: Why Not Svelte/Vue/etc.

| Option | Pros | Cons |
|--------|------|------|
| **React** | Anvil already uses React; largest ecosystem; TypeScript support; contributor familiarity | Slightly more boilerplate than Svelte |
| Svelte | Smaller bundle, less boilerplate | Different framework from Anvil; smaller ecosystem; fewer contributors know it |
| Vue | Good middle ground | Different framework from Anvil; two paradigms to maintain |

**React wins because Anvil (53K LOC) is already React.** Using the same framework across both frontends means shared patterns, shared component libraries (future), and contributors who can work on either codebase.
