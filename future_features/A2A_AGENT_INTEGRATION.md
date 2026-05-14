# A2A Agent Integration — Implementation Plan

> **Note:** This is an internal roadmap document. URLs, agent names, and repo paths reference Foxtrot Communications' internal services as examples. When implementing, replace these with your own agent endpoints.

**Roundtable as a Multi-Agent Multiplayer Workspace**

> Enable Roundtable workspaces to discover, register, and invoke remote AI agents via the [A2A protocol](https://github.com/a2aproject/A2A). Multiple humans and multiple agents collaborate in the same real-time workspace.

---

## Vision

```
Roundtable Workspace
├── 👤 User A (human)
├── 👤 User B (human)
├── 🧙 Merlin (agent) — clinical intelligence, OMOP queries, BQML
├── 🛡️ Pridwen (agent) — governance, PII detection
├── ⚔️ Excalibur (agent) — schema classification
├── 🔧 Custom Agent (agent) — customer's own A2A-compatible agent
│
└── 🤖 Roundtable AI (orchestrator) — routes to the right agent
```

User asks: *"What's our readmission rate for heart failure, and flag any PII in the results."*

1. Orchestrator AI calls `ask_merlin` → Merlin resolves concept, generates SQL, returns results
2. Orchestrator AI calls `ask_pridwen` → Pridwen scans result columns for PII
3. Orchestrator synthesizes both into one response
4. All users see the answer in real-time

---

## Architecture

### Current State

```
User message → Roundtable AI → local tools (14 built-in) → response
                                  ├── query_bigquery
                                  ├── web_search
                                  ├── shell_exec
                                  └── ... (11 more)
```

### Target State

```
User message → Roundtable AI → tools (local + remote agents) → response
                                  ├── query_bigquery (local)
                                  ├── web_search (local)
                                  ├── ask_merlin (A2A agent)
                                  ├── ask_pridwen (A2A agent)
                                  ├── ask_excalibur (A2A agent)
                                  └── custom_agent (A2A agent)
```

**Key insight:** Agents are tools. The existing tool registry (`server/tools/index.js`) already provides the interface — `{ name, description, parameters, execute() }`. An A2A agent is just a tool whose `execute()` sends a JSON-RPC request to a remote service instead of running local code.

### A2A Protocol Flow

```
1. Admin adds agent URL in workspace settings
2. Roundtable fetches GET <agent_url>/.well-known/agent-card.json
3. Agent Card describes: name, skills[], capabilities, auth
4. Each skill is registered as a tool in the workspace tool set
5. AI orchestrator sees agent skills alongside local tools
6. When AI calls an agent skill → Roundtable sends JSON-RPC tasks/send
7. Agent processes request (may use its own tool loop internally)
8. Agent returns result → Roundtable renders in chat
```

---

## Protocol Reference

A2A uses **JSON-RPC 2.0 over HTTPS**. Key operations:

| Method | Purpose |
|--------|---------|
| `GET /.well-known/agent-card.json` | Agent discovery |
| `tasks/send` | Send a task and get a response |
| `tasks/stream` | Send a task with SSE streaming |
| `tasks/get` | Poll task status |
| `tasks/cancel` | Cancel a running task |

### Agent Card Schema (from existing Forge card)

```json
{
  "name": "Forge - AI Data Classification Agent",
  "protocolVersion": "1.0",
  "description": "...",
  "url": "https://forge.foxtrotcommunications.net/a2a/v1",
  "preferredTransport": "JSONRPC",
  "provider": {
    "organization": "Foxtrot Communications Corporation",
    "url": "https://forge.foxtrotcommunications.net"
  },
  "capabilities": {
    "streaming": false,
    "pushNotifications": false
  },
  "skills": [
    {
      "id": "classify-schema",
      "name": "Schema Classification",
      "description": "Analyzes data warehouse table schemas...",
      "tags": ["data-classification", "pii-detection"],
      "examples": ["Scan my BigQuery dataset for sensitive data"],
      "inputModes": ["application/json", "text/plain"],
      "outputModes": ["application/json"]
    }
  ]
}
```

---

## Implementation Phases

### Phase 1: Agent-as-Tool Foundation (3-4 days)

The minimum viable integration: a generic `remoteAgent` tool factory that calls any HTTP endpoint.

#### 1.1 Remote Agent Tool Factory

**New file: `server/tools/remoteAgent.js`**

Creates a Roundtable tool from an agent's skill definition. One tool per skill.

```javascript
// server/tools/remoteAgent.js
const fetch = require('node-fetch');

/**
 * Create a Roundtable tool from an A2A agent skill.
 *
 * @param {object} skill — A2A skill object from Agent Card
 * @param {object} agentConfig — { url, name, authType, authToken }
 * @returns {object} Roundtable tool { name, description, parameters, execute }
 */
function createAgentTool(skill, agentConfig) {
  // Tool name: agent_name__skill_id (e.g., merlin__clinical_query)
  const toolName = `${sanitizeName(agentConfig.name)}__${sanitizeName(skill.id)}`;

  return {
    name: toolName,
    description: `[${agentConfig.name}] ${skill.description}`,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: `Request for ${skill.name}. ${skill.examples?.[0] || ''}`,
        },
        context: {
          type: 'string',
          description: 'Optional additional context',
        },
      },
      required: ['prompt'],
    },

    async execute({ prompt, context }, workspaceConfig = {}) {
      const taskId = `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const body = {
        jsonrpc: '2.0',
        method: 'tasks/send',
        id: taskId,
        params: {
          id: taskId,
          message: {
            role: 'user',
            parts: [{ type: 'text', text: context ? `${prompt}\n\nContext: ${context}` : prompt }],
          },
          metadata: {
            skill_id: skill.id,
            source: 'roundtable',
            workspace_id: workspaceConfig?.workspaceId || 'unknown',
          },
        },
      };

      const headers = { 'Content-Type': 'application/json' };
      if (agentConfig.authType === 'bearer') {
        headers['Authorization'] = `Bearer ${agentConfig.authToken}`;
      }

      const response = await fetch(agentConfig.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        timeout: 60000,
      });

      if (!response.ok) {
        return { error: `Agent ${agentConfig.name} returned ${response.status}` };
      }

      const result = await response.json();

      // Extract text from A2A response artifacts/parts
      if (result?.result?.artifacts) {
        return {
          agent: agentConfig.name,
          skill: skill.name,
          response: extractTextFromArtifacts(result.result.artifacts),
          raw: result.result,
        };
      }

      return { agent: agentConfig.name, skill: skill.name, response: result };
    },
  };
}

function sanitizeName(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function extractTextFromArtifacts(artifacts) {
  const texts = [];
  for (const artifact of artifacts) {
    for (const part of artifact.parts || []) {
      if (part.type === 'text') texts.push(part.text);
      else if (part.type === 'data') texts.push(JSON.stringify(part.data, null, 2));
    }
  }
  return texts.join('\n');
}

module.exports = { createAgentTool };
```

#### 1.2 Agent Discovery Service

**New file: `server/services/agentDiscovery.js`**

Fetches and validates Agent Cards from remote URLs.

```javascript
// server/services/agentDiscovery.js
const fetch = require('node-fetch');

/**
 * Fetch an A2A Agent Card from a remote URL.
 * Tries /.well-known/agent-card.json per A2A spec,
 * falls back to /agent-card.json and the URL itself.
 */
async function discoverAgent(baseUrl) {
  const urls = [
    `${baseUrl.replace(/\/$/, '')}/.well-known/agent-card.json`,
    `${baseUrl.replace(/\/$/, '')}/agent-card.json`,
    baseUrl,  // direct URL to card
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { timeout: 10000 });
      if (!res.ok) continue;
      const card = await res.json();
      if (card.name && card.skills && Array.isArray(card.skills)) {
        return { card, discoveryUrl: url };
      }
    } catch (_) { continue; }
  }

  throw new Error(`No valid Agent Card found at ${baseUrl}`);
}

/**
 * Validate an Agent Card has the minimum required fields.
 */
function validateAgentCard(card) {
  const errors = [];
  if (!card.name) errors.push('Missing name');
  if (!card.url) errors.push('Missing url');
  if (!card.skills || !Array.isArray(card.skills) || card.skills.length === 0) {
    errors.push('Missing or empty skills array');
  }
  for (const skill of card.skills || []) {
    if (!skill.id) errors.push(`Skill missing id`);
    if (!skill.description) errors.push(`Skill ${skill.id || '?'} missing description`);
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { discoverAgent, validateAgentCard };
```

#### 1.3 Agent Registry (in-memory + DB)

**New file: `server/services/agentRegistry.js`**

Manages registered agents per workspace and generates tools from their skills.

```javascript
// server/services/agentRegistry.js
const { createAgentTool } = require('../tools/remoteAgent');
const { discoverAgent, validateAgentCard } = require('./agentDiscovery');

// In-memory cache: workspaceId → Map<agentName, { card, config, tools[] }>
const registryCache = new Map();

/**
 * Register an A2A agent in a workspace.
 * Fetches the Agent Card, validates it, and creates tools for each skill.
 */
async function registerAgent(workspaceId, agentUrl, authConfig = {}) {
  const { card } = await discoverAgent(agentUrl);
  const validation = validateAgentCard(card);
  if (!validation.valid) {
    throw new Error(`Invalid Agent Card: ${validation.errors.join(', ')}`);
  }

  const agentConfig = {
    url: card.url,
    name: card.name,
    authType: authConfig.type || 'none',
    authToken: authConfig.token || '',
  };

  // Create one Roundtable tool per agent skill
  const tools = card.skills.map(skill => createAgentTool(skill, agentConfig));

  // Cache
  if (!registryCache.has(workspaceId)) registryCache.set(workspaceId, new Map());
  registryCache.get(workspaceId).set(card.name, { card, config: agentConfig, tools });

  return { name: card.name, skills: card.skills.length, tools: tools.map(t => t.name) };
}

/**
 * Get all agent-tools for a workspace (merged with local tools by chatHandler).
 */
function getAgentTools(workspaceId) {
  const agents = registryCache.get(workspaceId);
  if (!agents) return {};
  const toolMap = {};
  for (const [, agent] of agents) {
    for (const tool of agent.tools) {
      toolMap[tool.name] = tool;
    }
  }
  return toolMap;
}

/**
 * List registered agents for a workspace.
 */
function listAgents(workspaceId) {
  const agents = registryCache.get(workspaceId);
  if (!agents) return [];
  return Array.from(agents.values()).map(a => ({
    name: a.card.name,
    description: a.card.description,
    skills: a.card.skills.map(s => ({ id: s.id, name: s.name })),
    provider: a.card.provider,
  }));
}

function removeAgent(workspaceId, agentName) {
  registryCache.get(workspaceId)?.delete(agentName);
}

module.exports = { registerAgent, getAgentTools, listAgents, removeAgent };
```

#### 1.4 Integrate Agent Tools into Chat Handler

**Modify: `server/sockets/chatHandler.js`**

Merge agent tools into the tool set before each AI call.

```diff
+ const { getAgentTools } = require('../services/agentRegistry');

  // In the send-message handler, after resolving enabledToolNames:
+ // Merge A2A agent tools into the tool set
+ const agentTools = getAgentTools(config.workspaceId);
+ // Agent tools are always available (workspace admin controls registration)
```

**Modify: `server/tools/index.js`**

Add a function to merge agent tools with local tools at runtime.

```diff
+ function mergeAgentTools(localTools, agentTools) {
+   return { ...localTools, ...agentTools };
+ }
+
  module.exports = {
    tools,
    getAvailableTools,
    toOpenAITools,
    toAnthropicTools,
    toGoogleTools,
    executeTool,
+   mergeAgentTools,
  };
```

#### 1.5 Database Migration

**Modify: `server/db/adapters/postgresql.js`**

Add `agents` table to store registered agents per workspace.

```sql
CREATE TABLE IF NOT EXISTS workspace_agents (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  agent_url TEXT NOT NULL,
  agent_card JSONB NOT NULL,
  auth_type TEXT DEFAULT 'none',
  auth_token TEXT DEFAULT '',
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, agent_name)
);
```

---

### Phase 2: Settings UI — Agents Tab (2-3 days)

#### 2.1 New Settings Tab

**Modify: `public/app.html`**

Add an "Agents" tab to the workspace settings modal.

```html
<button class="settings-tab" data-tab="tab-agents" id="stab-agents">Agents</button>

<!-- Tab: Agents -->
<div class="settings-tab-panel" id="tab-agents">
  <p class="settings-desc">
    Connect A2A-compatible AI agents to this workspace. Each agent's skills
    become available as tools the AI can use alongside built-in tools.
  </p>

  <div class="form-group">
    <label for="agent-url">Agent URL</label>
    <input type="text" id="agent-url"
           placeholder="https://merlin.example.com or /.well-known/agent-card.json">
  </div>
  <div style="display:flex;gap:8px;margin-bottom:16px;">
    <button class="btn btn-primary btn-sm" id="btn-discover-agent">Discover Agent</button>
  </div>

  <!-- Discovered agent preview (populated by JS) -->
  <div id="agent-preview" style="display:none;"></div>

  <!-- Registered agents list -->
  <div id="registered-agents"></div>
</div>
```

#### 2.2 REST API Endpoints

**Modify: `server/index.js`**

```javascript
// GET /api/agents — list registered agents
app.get('/api/agents', requireAuth, async (req, res) => { ... });

// POST /api/agents/discover — discover an agent from URL (returns card preview)
app.post('/api/agents/discover', requireAuth, async (req, res) => { ... });

// POST /api/agents/register — register a discovered agent
app.post('/api/agents/register', requireAuth, async (req, res) => { ... });

// DELETE /api/agents/:name — remove an agent
app.delete('/api/agents/:name', requireAuth, async (req, res) => { ... });

// PATCH /api/agents/:name — enable/disable an agent
app.patch('/api/agents/:name', requireAuth, async (req, res) => { ... });
```

#### 2.3 Frontend JS

**New file: `public/js/agents.js`**

Handles agent discovery UI, preview rendering, and registration.

---

### Phase 3: Merlin A2A Endpoint (2-3 days)

Merlin currently has a Flask REST API (`/generate`). Add A2A protocol compliance.

#### 3.1 A2A Endpoint on Merlin

**Modify: `foxtrotcommunications-merlin/app.py`**

```python
@app.route("/a2a/v1", methods=["POST"])
def a2a_handler():
    """A2A JSON-RPC 2.0 endpoint."""
    data = request.get_json()
    method = data.get("method")

    if method == "tasks/send":
        return handle_task_send(data)
    elif method == "tasks/get":
        return handle_task_get(data)
    elif method == "tasks/cancel":
        return handle_task_cancel(data)
    else:
        return jsonify({"jsonrpc": "2.0", "error": {"code": -32601, "message": f"Unknown method: {method}"}}), 400
```

#### 3.2 Agent Card for Merlin (clinical skills)

**New file: `foxtrotcommunications-merlin/.well-known/agent-card.json`**

```json
{
  "name": "Merlin",
  "protocolVersion": "1.0",
  "description": "Clinical intelligence AI — OMOP concept resolution, clinical SQL generation, BQML model training, and executive reporting.",
  "url": "https://foxtrotcommunications-merlin-<hash>.run.app/a2a/v1",
  "capabilities": { "streaming": false, "pushNotifications": false },
  "skills": [
    {
      "id": "clinical-query",
      "name": "Clinical Analytics Query",
      "description": "Generate validated SQL against OMOP CDM 5.4 tables with automatic concept resolution via OHDSI vocabulary lookup. Handles conditions, procedures, drugs, measurements, and demographics.",
      "tags": ["omop", "clinical", "sql", "analytics"],
      "examples": [
        "What is the 30-day readmission rate for heart failure?",
        "Show diabetes prevalence by age group",
        "Compare comorbidity burden between readmitted and non-readmitted patients"
      ]
    },
    {
      "id": "concept-lookup",
      "name": "OMOP Concept Lookup",
      "description": "Resolve clinical terms to standard OMOP concept IDs via fuzzy search against the OHDSI vocabulary. Returns concept_id, concept_name, domain, and vocabulary.",
      "tags": ["omop", "vocabulary", "concept"],
      "examples": [
        "Look up the OMOP concept for Type 2 diabetes",
        "Find the concept ID for lisinopril"
      ]
    },
    {
      "id": "train-model",
      "name": "BQML Model Training",
      "description": "Train a BigQuery ML model from a natural language description. Supports classification, regression, clustering, and time series forecasting on OMOP clinical data.",
      "tags": ["bqml", "machine-learning", "clinical"],
      "examples": [
        "Train a 30-day readmission risk model",
        "Segment patients by utilization patterns"
      ]
    },
    {
      "id": "generate-report",
      "name": "Executive Report",
      "description": "Generate a polished executive analytics report with SVG charts from Avalon dashboard data.",
      "tags": ["reporting", "executive", "analytics"],
      "examples": [
        "Generate an executive summary of readmission trends"
      ]
    }
  ]
}
```

---

### Phase 4: Streaming Support (1-2 weeks, optional)

For long-running agent tasks, use A2A's `tasks/stream` with SSE.

#### 4.1 SSE Streaming from Agent to Roundtable

```
Roundtable → POST tasks/stream → Agent
Agent → SSE: { status: "working", progress: "Resolving concepts..." }
Agent → SSE: { status: "working", progress: "Generating SQL..." }
Agent → SSE: { artifact: { parts: [{ type: "text", text: "..." }] } }
Agent → SSE: { status: "completed" }
```

Roundtable pipes SSE events into the existing `ai-chunk` socket emission so users see progressive updates.

#### 4.2 Agent Presence in Chat

Show agent activity in the workspace presence bar:

```
brady2 🟢  analyst1 🟢  🧙 Merlin (resolving concepts...)
```

---

### Phase 5: External Agent Support (1 week, future)

Allow customers to bring their own A2A-compatible agents.

#### 5.1 Auth Schemes

Support the auth methods defined in Agent Cards:

| Auth Type | Implementation |
|-----------|---------------|
| `none` | No auth header (internal/VPC agents) |
| `bearer` | `Authorization: Bearer <token>` |
| `apiKey` | Custom header with API key |
| `oauth2` | OAuth2 client_credentials flow |

#### 5.2 Agent Marketplace (future)

A directory of verified A2A agents that Roundtable users can one-click install:

```
Marketplace:
  🧙 Merlin — Clinical Intelligence (Foxtrot)
  🛡️ Pridwen — Data Governance (Foxtrot)
  📊 Looker Agent — BI Analytics (Google)
  🔐 Compliance Agent — HIPAA Audit (Custom)
```

---

## File Change Summary

### New Files

| File | Purpose |
|------|---------|
| `server/tools/remoteAgent.js` | Tool factory: creates Roundtable tools from A2A skills |
| `server/services/agentDiscovery.js` | Fetches and validates Agent Cards |
| `server/services/agentRegistry.js` | Per-workspace agent registration and tool generation |
| `public/js/agents.js` | Frontend: agent discovery, preview, and management |

### Modified Files

| File | Change |
|------|--------|
| `server/tools/index.js` | Add `mergeAgentTools()` function |
| `server/sockets/chatHandler.js` | Merge agent tools into AI tool set before each call |
| `server/index.js` | Add `/api/agents/*` REST endpoints |
| `server/db/adapters/postgresql.js` | Add `workspace_agents` table migration |
| `public/app.html` | Add Agents tab to settings modal |

### External Changes (Merlin repo)

| File | Change |
|------|--------|
| `foxtrotcommunications-merlin/app.py` | Add `/a2a/v1` JSON-RPC endpoint |
| `foxtrotcommunications-merlin/.well-known/agent-card.json` | Clinical skills Agent Card |

---

## Effort Estimate

| Phase | Work | Effort |
|-------|------|--------|
| Phase 1: Agent-as-Tool foundation | remoteAgent.js, discovery, registry, chatHandler integration, DB migration | 3-4 days |
| Phase 2: Settings UI | Agents tab, REST endpoints, frontend JS | 2-3 days |
| Phase 3: Merlin A2A endpoint | JSON-RPC handler, Agent Card, skill routing | 2-3 days |
| Phase 4: Streaming (optional) | SSE support, agent presence | 1-2 weeks |
| Phase 5: External agents (future) | OAuth2, marketplace | 1 week |
| **MVP (Phases 1-3)** | | **~1.5 weeks** |

---

## Testing Plan

### Unit Tests

- `remoteAgent.js` — mock HTTP responses, verify tool creation from skills
- `agentDiscovery.js` — mock Agent Card endpoints, test validation
- `agentRegistry.js` — register/remove/list agents, verify tool generation

### Integration Tests

- Register Merlin Agent Card → verify skills appear as tools
- Send `tasks/send` to Merlin → verify concept resolution and SQL response
- Full flow: user message → AI calls agent tool → agent responds → chat renders

### Manual Verification

1. Add Merlin URL in Agents settings tab
2. See Merlin's skills appear in the Tools tab
3. Ask a clinical question → observe AI calling Merlin → see OMOP results
4. Multiple users see the agent response in real-time

---

## Competitive Positioning

| Platform | Multi-User | Multi-Agent | A2A Protocol | Real-Time Shared |
|----------|-----------|-------------|-------------|-----------------|
| ChatGPT Teams | ✅ | ❌ | ❌ | ❌ |
| Claude Projects | ✅ | ❌ | ❌ | ❌ |
| AutoGen/CrewAI | ❌ | ✅ | ❌ | ❌ |
| Slack AI | ✅ | ❌ | ❌ | ✅ |
| MS Copilot Studio | ✅ | 🟡 | ❌ | ❌ |
| **Roundtable** | ✅ | ✅ | ✅ | ✅ |

**Roundtable becomes the only platform combining multi-user + multi-agent + A2A + real-time collaboration.**
