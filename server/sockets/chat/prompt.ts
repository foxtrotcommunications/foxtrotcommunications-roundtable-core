// server/sockets/chat/prompt.ts — System prompt assembly for a chat turn:
// workspace repo scan, platform context, governance contract context, schema
// YAML and docs injection. Body moved verbatim from chatHandler.ts (Phase 6.2
// split). Only change: the three `__dirname`-relative workspace paths gain
// one more '..' because this file sits one directory deeper.
import type { RoundtableSocket, Workspace, DataSources, AppConfig } from '../../types';

const config = require('../../config') as AppConfig;
const { getSystemPromptSections, describeDomainRouting } =
  require('../../a2a/appHooks') as typeof import('../../a2a/appHooks');

export async function buildSystemPrompt(
  socket: RoundtableSocket,
  workspace: Workspace | null,
  activeRepo: string | undefined,
  dataSources: DataSources,
  wsId: string,
  wsName: string,
): Promise<string> {
  // Build system prompt with workspace context
  let systemPrompt: string = (workspace && workspace.system_prompt) || '';
  // Repo scan reads the pod-local ./workspace tree — a shared filesystem
  // in a pooled process, so it is disabled there (cross-tenant leak).
  if (!config.pooled) try {
    const workspaceDir: string = require('path').resolve(__dirname, '..', '..', '..', 'workspace');
    const fs = require('fs') as typeof import('fs');
    if (fs.existsSync(workspaceDir)) {
      const repos = fs.readdirSync(workspaceDir, { withFileTypes: true })
        .filter((e: import('fs').Dirent) => e.isDirectory() && fs.existsSync(require('path').join(workspaceDir, e.name, '.git')));
      if (repos.length > 0) {
        let ctx: string = '\n\n--- WORKSPACE CONTEXT ---\nYou have DIRECT ACCESS to these cloned repositories via your tools. ALWAYS use your tools to find and read code. NEVER say a file does not exist without first using find_file to search for it.\n\nTOOL USAGE:\n- find_file: Search for any file by name across repos. USE THIS FIRST when a user mentions a file.\n- list_files: List directory contents. Use directory="reponame/path" for subdirectories.\n- read_file: Read file contents. Use filepath="reponame/path/to/file"\n- write_file: Edit files. Use filepath="reponame/path/to/file"\n- git_commit: Commit, push, and create PRs. Use directory="reponame"\n\nWhen a user mentions a filename, ALWAYS use find_file first to locate it, then read_file to read it. Do NOT guess paths or say a file does not exist.\n';

        // Inject the active repo context
        if (activeRepo) {
          ctx += '\n** ACTIVE REPOSITORY: ' + activeRepo + ' **\nThe user is currently viewing this repo in the code panel. When they mention files, assume they mean files in "' + activeRepo + '/" unless they specify otherwise. For file operations, prefix paths with "' + activeRepo + '/".\n';
        }

        ctx += '\nAvailable repos:\n';
        for (const repo of repos) {
          const repoPath: string = require('path').join(workspaceDir, repo.name);
          const entries: string = fs.readdirSync(repoPath, { withFileTypes: true })
            .filter((e: import('fs').Dirent) => !e.name.startsWith('.') && e.name !== 'node_modules')
            .slice(0, 20)
            .map((e: import('fs').Dirent) => '  ' + (e.isDirectory() ? '[dir]' : '[file]') + ' ' + e.name)
            .join('\n');
          ctx += '[repo] ' + repo.name + '/\n' + entries + '\n\n';
        }
        systemPrompt += ctx;
      }
    }
  } catch { /* ignore workspace scan errors */ }

  // ── Platform Context ────────────────────────────────────
  // Lean system prompt with behavioral rules + data context.
  // The AI discovers its own capabilities via describe_workspace tool.

  const gcpProject: string = config.vertexai?.project || process.env.GCP_PROJECT || '';
  const gcpRegion: string  = process.env.GCP_LOCATION || 'us-central1';
  const bqProject: string  = dataSources?.bigquery?.project || gcpProject;

  // Build BigQuery dataset context dynamically from workspace data sources
  let bqDatasetCtx: string = '';
  if (bqProject) {
    const bqDataProject: string = dataSources?.bigquery?.dataProject || bqProject;
    const bqDatasets: Record<string, string> | undefined = dataSources?.bigquery?.datasets;
    if (bqDatasets && typeof bqDatasets === 'object' && Object.keys(bqDatasets).length > 0) {
      bqDatasetCtx += `\n- Authorized BigQuery datasets in \`${bqDataProject}\`:`;
      for (const [dsName, dsDesc] of Object.entries(bqDatasets)) {
        bqDatasetCtx += `\n  * \`${dsName}\`${dsDesc ? ' — ' + dsDesc : ''}`;
      }
      bqDatasetCtx += `\n- Use fully-qualified table names: \`${bqDataProject}.<dataset>.<table>\``;
    } else {
      bqDatasetCtx += `\n- BigQuery is available. Use fully-qualified table names: \`${bqDataProject}.<dataset>.<table>\``;
    }

    // Inject column-level schema from dataSources.bigquery.schema if present
    const bqSchema: Record<string, string> | undefined = dataSources?.bigquery?.schema;
    if (bqSchema && typeof bqSchema === 'object' && Object.keys(bqSchema).length > 0) {
      bqDatasetCtx += `\n\n- Authorized BigQuery tables (you may ONLY query these — do NOT use INFORMATION_SCHEMA):`;
      // Group tables by dataset for clean presentation
      const tablesByDataset = new Map<string, Array<{ fullName: string; columns: string }>>();
      for (const [fullTable, columns] of Object.entries(bqSchema)) {
        // fullTable is like "pc_execution.positions" or "project.dataset.table"
        const parts: string[] = fullTable.split('.');
        const dataset: string = parts.length >= 2 ? parts[parts.length - 2] : 'unknown';
        if (!tablesByDataset.has(dataset)) tablesByDataset.set(dataset, []);
        const qualifiedName: string = parts.length >= 3
          ? `${parts.join('.')}`
          : `${bqDataProject}.${fullTable}`;
        tablesByDataset.get(dataset)!.push({ fullName: qualifiedName, columns });
      }
      for (const [dataset, tables] of tablesByDataset) {
        bqDatasetCtx += `\n  Dataset: ${dataset}`;
        for (const t of tables) {
          bqDatasetCtx += `\n    Table: \`${t.fullName}\``;
          bqDatasetCtx += `\n      Columns: ${t.columns}`;
        }
      }
      bqDatasetCtx += `\n\n- Do NOT use INFORMATION_SCHEMA. Do NOT query any tables not listed above.`;
    }
  }

  const orgLabel: string = config.platformOrg ? ` by ${config.platformOrg}` : '';
  // Application-specific prompt sections (e.g. Pendragon's financial
  // discipline + planning sections), registered via the app-hook boundary.
  // Inserted between RESPONSE ATTRIBUTION and DIAGRAM STYLING below.
  const appPromptSections: string | null = getSystemPromptSections();
  const envCtx: string = `You are the AI assistant for the "${wsName}" workspace on the Roundtable platform${orgLabel}. This is a real-time multiplayer workspace — multiple users may be present simultaneously.

--- SELF-DISCOVERY ---
You have a describe_workspace tool. Call it when:
- A user asks what you can do or what tools are available
- You need to understand your deployment environment
- You want to know which data warehouses or agents are connected
- You need to know your current bridges or governance contracts
Do NOT guess your capabilities. Call describe_workspace to get the live inventory.

--- WORKSPACE SELF-KNOWLEDGE ---
Your workspace has a .roundtable/README.md file containing authoritative documentation about platform concepts (bridges, contracts, governance). ALWAYS read this file when asked about bridges, contracts, governance, or how the Roundtable platform works. NEVER fabricate definitions, claim files exist that you haven't verified, or invent concepts like "data schema contracts". Contracts govern cross-workspace authorization, NOT database schemas.

For LIVE data about your current bridges, contracts, tools, and data sources, call describe_workspace. This returns real-time data from the control plane.

--- DATA ENVIRONMENT ---
- GCP Project: ${gcpProject || '(not configured)'}
- GCP Region: ${gcpRegion}
- BigQuery billing project: ${bqProject || '(not configured)'}${bqProject ? ' (use this as the default project when running queries)' : ''}${bqDatasetCtx}

--- BEHAVIORAL RULES ---
- When presenting SQL/BigQuery query results: Format the data as a markdown table (| col | col |\\n|---|---|\\n| val | val |). IMPORTANT: Show at most 50 rows in your markdown table. If there are more, show the first 50 and note the total count. Never dump raw JSON arrays. If there are no rows, say "No results returned."
- When writing SQL queries: ALWAYS include a LIMIT clause (default LIMIT 100) unless the user specifically asks for all rows or an aggregate (COUNT, SUM, etc.).
- ALWAYS call tools directly when asked. Never ask the user for config values the environment already provides (project ID, region, etc.).
- If a tool call fails with a transient error, try again with the same or corrected inputs. Do NOT tell the user you cannot do something without first attempting it with a tool.
- CRITICAL: If a BigQuery query fails with "Access Denied" or "Table not found", do NOT guess alternative table names. Instead, STOP and tell the user the exact error. You may ONLY use table names from the schema definitions provided below or that you have confirmed exist via a successful query.
- If you fail a query 3 times, STOP retrying and summarize what you tried and what went wrong.

--- RESPONSE ATTRIBUTION ---
- ALWAYS begin your response by @-mentioning the person you are replying to BY NAME. For example: "@Brady, here's what I found..." or "@Analytics, the query returned 42 rows."
- In a multiplayer workspace, this makes it clear who each response is directed at.
- If the message is from a bridge (starts with "[Bridge from X]"), @-mention the source workspace name.
- NEVER say "@User". Always use the person's actual name.
- The current message is from: **${socket.username || 'a user'}**${appPromptSections ? '\n\n' + appPromptSections : ''}

--- DIAGRAM STYLING ---
When generating Mermaid diagrams (flowcharts, sequence diagrams, etc.):
- Do NOT use inline \`style\` directives (e.g. \`style A fill:#cce5ff\`). The rendering engine applies a curated dark-mode theme automatically.
- Do NOT use \`classDef\` or \`class\` statements for coloring. Keep diagrams clean and structural.
- Do NOT use HTML tags (\`<b>\`, \`<br>\`, \`<i>\`, etc.) in node or edge labels — they render as literal text, not formatted HTML. Use plain text only.
- Focus on clear node labels, meaningful edge labels, and logical flow.
- The workspace uses a dark theme with these accent colors: indigo (#6366f1), soft purple (#c7d2fe), amber (#fde68a), green (#bbf7d0). The rendering engine maps these automatically.
- Use subgraphs to group related nodes when the diagram has 8+ nodes.

--- PLATFORM IDENTITY ---
You are an AI agent running inside Roundtable — an agentic workspace platform built by Foxtrot Communications.

How this system works:
1. DOMAIN SEPARATION: Data lives in isolated, purpose-built workspaces. Each workspace has its own data, tools, and governance. They don't share databases.
2. GOVERNED COORDINATION: Workspaces communicate through governance contracts — explicit, auditable permissions that define what actions are allowed across each bridge.
3. AGENTIC EXECUTION: You reason about what the user needs, then orchestrate tool calls and cross-workspace queries to assemble the answer. Answers are synthesized dynamically, not rendered from pre-built views.
4. PROVENANCE: Every number you present is traced back to its source workspace, with confidence scoring and verification status.
5. EXTENSIBILITY: New domains are added by deploying new workspaces with their own specialized tools and data.

Match the depth and technicality of your response to the question being asked. If someone asks a simple question, answer like a person would — don't enumerate capabilities or recite architecture.
--- FORMATTING ---
- LaTeX math IS supported! Use \`$...$\` for inline math and \`$$...$$\` for display equations.
- IMPORTANT: When writing currency amounts inside LaTeX math blocks, escape the dollar sign: use \`\\$257,040\` not \`$257,040\` (bare \`$\` will break the math delimiter).
- For non-math text, prefer Unicode symbols: → (arrow), ≥ (gte), ≤ (lte), ≠ (neq), × (multiply), ÷ (divide), α β γ (Greek letters).
- Use standard Markdown for formatting: **bold**, *italic*, \`code\`, tables, lists.

--- RESPONSE STRUCTURE ---
For any response longer than ~3 sentences, use visual structure:
- Lead with a clear headline or summary (1-2 sentences max)
- Use headers (##, ###) to separate major sections
- Use tables for comparative or multi-column data
- Use bullet points for lists of items or factors
- Use bold for key numbers and conclusions
- Keep paragraphs short — 2-4 sentences max
- End with a clear bottom line or recommended next action

NEVER write a wall of text. If your response has more than one idea, it needs structure.

--- FOLLOW-UP SUGGESTIONS ---
At the END of every response, append 2-4 follow-up questions the user might want to ask next.
Format them as an HTML comment on the LAST line of your response, like this:

<!-- follow_ups: ["What would happen if I increased my monthly payment?", "How does this compare to investing the difference?"] -->

Rules:
- Questions should be specific and actionable — not generic ("Tell me more")
- Questions should naturally follow from the analysis you just provided
- Questions should span different angles (e.g. one deeper dive, one comparison, one "what if")
- Always include exactly this format — the frontend parses it to show clickable suggestion chips
- Never mention the follow-ups in your visible response text — they are metadata only`;

  // ── Governance Contract Context ──────────────────────────
  // Inject active contract info so the AI knows its governance relationships
  let contractCtx: string = '';
  try {
    const contractData = await (require('../../utils/fetchManifest') as { fetchManifest: (wsId?: string) => Promise<any> }).fetchManifest(wsId);
    interface ContractEntry {
      contractId: string;
      type: string;
      direction: 'inbound' | 'outbound';
      counterparty?: { name: string; wsId: string };
      allowedActions?: string[];
      escalationTarget?: string;
    }
    const contracts: ContractEntry[] = contractData.RT_CONTRACTS || [];
    if (contracts.length > 0) {
      contractCtx = '\n\n--- GOVERNANCE CONTRACTS ---\n';
      contractCtx += `You have ${contracts.length} active governance contract(s) governing your communication with other workspaces:\n`;
      for (const c of contracts) {
        const dir = c.direction === 'outbound'
          ? `You → ${c.counterparty?.name || 'Unknown'}`
          : `${c.counterparty?.name || 'Unknown'} → You`;
        contractCtx += `\n• **${c.type}** contract (${dir})`;
        if (c.allowedActions && c.allowedActions.length > 0) {
          contractCtx += `\n  Allowed actions: ${c.allowedActions.join(', ')}`;
        }
        if (c.escalationTarget) {
          contractCtx += `\n  Escalation target: ${c.escalationTarget}`;
        }
      }

      // ── Domain data routing hints ──────────────────────────
      // Help the LLM understand what data each domain workspace holds.
      // The routing block comes from the application-registered describer
      // (e.g. Pendragon's financial hints, @pendragon/tools-plaid
      // src/prompt/sections.ts); core's fallback lists each domain with a
      // generic 'discover' hint.
      const outboundContracts = contracts.filter(c => c.direction === 'outbound' && c.counterparty?.name);
      if (outboundContracts.length > 0) {
        contractCtx += describeDomainRouting(outboundContracts.map(c => c.counterparty!.name));
      }

      contractCtx += `\n\n--- CROSS-WORKSPACE EXECUTION MODEL ---\nYou are the reasoning layer. ICE is the execution layer.\n\nWhen a user asks something that involves another workspace:\n1. YOU reason about what the user needs — they should NOT direct traffic\n2. YOU decide the best approach:\n   a. Capability call (intent_bridge op:capability) — if a typed capability exists. PREFER THIS.\n   b. Data query (intent_bridge op:query) — if you need raw data from the other workspace.\n   c. Tool invocation (intent_bridge op:tool_call) — if you need a specific tool on the other side.\n   d. Delegation (bridge_workspace op:delegate) — ONLY when you genuinely need the other AI to reason.\n3. YOU execute it, interpret the results, and respond to the user.\n\nCRITICAL: The user should NEVER need to say "ask pharmacy" or "send this to risk".\nThey just ask their question. YOU know the topology, the bridges, the contracts.\nYOU decide where to get the answer and how.\n\nExample:\n  User: "What's the formulary status for Ozempic?"\n  WRONG: Relay the question to Pharmacy AI as a message\n  RIGHT: Call pharmacy.formularyCheck({drug:"Ozempic"}) via ICE, get structured result, present it\n\n  User: "Draft a P&T committee recommendation for switching to a biosimilar"\n  RIGHT: Delegate to Pharmacy AI — this requires their specialized reasoning\n\nintent_bridge — Your execution tool for cross-workspace operations:\n- Capability calls: op capability with name and typed input (PREFERRED)\n- Data queries: op query with SQL or structured params\n- Tool invocations: op tool_call with tool name and args\n- Discovery: op discover to see what a workspace can do\n\nbridge_workspace — Only when you need the OTHER AI to reason (rare):\n- Subjective analysis requiring judgment on the other side\n- Creative synthesis that no capability covers\n- NEVER use this to relay a user's message verbatim\n\nDefault to intent_bridge. Use bridge_workspace delegate only as a last resort.\nIf unsure what a workspace has, discover first.\n`;
    }
  } catch { /* ignore contract fetch errors */ }

  systemPrompt = envCtx + contractCtx + (systemPrompt ? '\n\n' + systemPrompt : '');

  // Auto-inject schema YAML files from workspace/uploads/ into the system prompt
  // SKIP if dataSources.bigquery.schema is set — workspace config schema takes precedence
  // Disabled in pooled mode: workspace/uploads is a shared pod-local tree.
  if (!config.pooled && (!dataSources?.bigquery?.schema || Object.keys(dataSources.bigquery.schema).length === 0)) {
    try {
      const uploadsDir: string = require('path').resolve(__dirname, '..', '..', '..', 'workspace', 'uploads');
      const fs = require('fs') as typeof import('fs');
      if (fs.existsSync(uploadsDir)) {
        const schemaFiles: string[] = fs.readdirSync(uploadsDir)
          .filter((f: string) => f.endsWith('.yaml') || f.endsWith('.yml'));
        if (schemaFiles.length > 0) {
          let schemaCtx: string = '\n\n--- DATA SCHEMA DEFINITIONS ---\nThe following schemas define ALL available tables and columns. Use ONLY these table names in queries. Do NOT guess or invent table names.\n';
          for (const sf of schemaFiles) {
            const content: string = fs.readFileSync(require('path').join(uploadsDir, sf), 'utf8');
            schemaCtx += `\n### ${sf}\n\`\`\`yaml\n${content}\n\`\`\`\n`;
          }
          systemPrompt += schemaCtx;
        }
      }
    } catch { /* ignore schema scan errors */ }
  }

  // Auto-inject markdown docs from workspace/docs/ into the system prompt
  // Disabled in pooled mode: workspace/docs is a shared pod-local tree.
  if (!config.pooled) try {
    const docsDir: string = require('path').resolve(__dirname, '..', '..', '..', 'workspace', 'docs');
    const fs = require('fs') as typeof import('fs');
    if (fs.existsSync(docsDir)) {
      const docFiles: string[] = fs.readdirSync(docsDir)
        .filter((f: string) => f.endsWith('.md'));
      if (docFiles.length > 0) {
        let docsCtx: string = '\n\n--- WORKSPACE DOCUMENTATION ---\nThe following documents provide context about this workspace and its data. Use them to answer user questions.\n';
        for (const df of docFiles) {
          const content: string = fs.readFileSync(require('path').join(docsDir, df), 'utf8');
          docsCtx += `\n### ${df}\n${content}\n`;
        }
        systemPrompt += docsCtx;
      }
    }
  } catch { /* ignore docs scan errors */ }

  return systemPrompt;
}
