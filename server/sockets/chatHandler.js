// server/sockets/chatHandler.js — Message handling + AI streaming with tools (workspace-based)
const workspaceService = require('../services/workspaceService');
const { streamCompletion } = require('../services/aiProvider');
const config = require('../config');

// Active generation state is tracked per-socket (on the socket object itself),
// so multiple users in the same workspace can each have independent AI calls.
// socket.abortController — AbortController for the current stream
// socket.isGenerating   — boolean guard against double-submission

function setupChatHandlers(io, socket) {
  const wsChannel = `ws:${config.workspaceId}`;

  socket.on('send-message', async ({ content, activeRepo }) => {
    try {
      // Save and broadcast every message
      const userMessage = await workspaceService.saveMessage(socket.userId, 'user', content);
      io.to(wsChannel).emit('new-message', userMessage);

      // Only invoke AI when the message contains @ai (case-insensitive)
      const mentionsAI = /@ai\b/i.test(content);
      if (!mentionsAI) return;

      // Per-socket guard — only one active generation per user
      if (socket.isGenerating) {
        socket.emit('error-message', { error: 'Your AI request is still processing. Please wait or stop it first.' });
        return;
      }

      const workspace = await workspaceService.getWorkspace();

      // AI provider config from workspace or defaults
      const aiProvider = (workspace && workspace.ai_provider) || 'vertexai';
      const aiModel = (workspace && workspace.ai_model) || 'gemini-2.5-flash';
      const toolsEnabled = workspace ? (workspace.tools_enabled ?? true) : true;

      // Resolve enabled tool names from workspace config (null = all tools)
      let enabledToolNames = null;
      if (workspace && workspace.enabled_tools) {
        try {
          const parsed = JSON.parse(workspace.enabled_tools);
          if (Array.isArray(parsed) && parsed.length > 0) enabledToolNames = parsed;
        } catch (_) {}
      }

      // Vertex AI uses ADC — no API key needed, just GCP_PROJECT
      let apiKey = '';
      if (aiProvider === 'vertexai') {
        if (!config.vertexai.project) {
          io.to(wsChannel).emit('ai-error', { error: 'GCP_PROJECT not set. Required for Vertex AI.' });
          return;
        }
      } else {
        const userKey = await workspaceService.getUserApiKey(socket.userId, aiProvider);
        const serverKey = config.ai[aiProvider] || '';
        apiKey = userKey || serverKey;

        if (!apiKey) {
          io.to(wsChannel).emit('ai-error', { error: `No API key for ${aiProvider}. Add one in Settings.` });
          return;
        }
      }

      const history = await workspaceService.getConversationHistory(50);
      const messages = [];

      // Build system prompt with workspace context
      let systemPrompt = (workspace && workspace.system_prompt) || '';
      try {
        const workspaceDir = require('path').resolve(__dirname, '..', '..', 'workspace');
        const fs = require('fs');
        if (fs.existsSync(workspaceDir)) {
          const repos = fs.readdirSync(workspaceDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && fs.existsSync(require('path').join(workspaceDir, e.name, '.git')));
          if (repos.length > 0) {
            let ctx = '\n\n--- WORKSPACE CONTEXT ---\nYou have DIRECT ACCESS to these cloned repositories via your tools. ALWAYS use your tools to find and read code. NEVER say a file does not exist without first using find_file to search for it.\n\nTOOL USAGE:\n- find_file: Search for any file by name across repos. USE THIS FIRST when a user mentions a file.\n- list_files: List directory contents. Use directory="reponame/path" for subdirectories.\n- read_file: Read file contents. Use filepath="reponame/path/to/file"\n- write_file: Edit files. Use filepath="reponame/path/to/file"\n- git_commit: Commit, push, and create PRs. Use directory="reponame"\n\nWhen a user mentions a filename, ALWAYS use find_file first to locate it, then read_file to read it. Do NOT guess paths or say a file does not exist.\n';

            // Inject the active repo context
            if (activeRepo) {
              ctx += '\n** ACTIVE REPOSITORY: ' + activeRepo + ' **\nThe user is currently viewing this repo in the code panel. When they mention files, assume they mean files in "' + activeRepo + '/" unless they specify otherwise. For file operations, prefix paths with "' + activeRepo + '/".\n';
            }

            ctx += '\nAvailable repos:\n';
            for (const repo of repos) {
              const repoPath = require('path').join(workspaceDir, repo.name);
              const entries = fs.readdirSync(repoPath, { withFileTypes: true })
                .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
                .slice(0, 20)
                .map(e => '  ' + (e.isDirectory() ? '[dir]' : '[file]') + ' ' + e.name)
                .join('\n');
              ctx += '[repo] ' + repo.name + '/\n' + entries + '\n\n';
            }
            systemPrompt += ctx;
          }
        }
      } catch (e) { /* ignore workspace scan errors */ }

      // Always prepend GCP / tool environment context
      const gcpProject = config.vertexai?.project || process.env.GCP_PROJECT || '';
      const gcpRegion  = process.env.GCP_LOCATION || 'us-central1';
      const envCtx = `You are a helpful AI assistant with direct access to tools. Key environment facts:
- GCP Project: ${gcpProject}
- GCP Region: ${gcpRegion}
- BigQuery billing project: ${gcpProject} (use this as the project when running queries)
- For BigQuery public datasets use fully-qualified names: \`project.dataset.table\` (e.g. \`bigquery-public-data.usa_names.usa_1910_2013\`)
- ALWAYS call tools directly when asked. Never ask the user for config values the environment already provides (project ID, region, etc.).
- If a tool call fails with a transient error, try again with the same or corrected inputs. Do NOT tell the user you cannot do something without first attempting it with a tool.`;

      systemPrompt = envCtx + (systemPrompt ? '\n\n' + systemPrompt : '');

      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

      for (const msg of history) {
        if (msg.role === 'tool') continue;
        messages.push({ role: msg.role, content: msg.content });
      }

      // Set up per-socket AbortController
      const abortController = new AbortController();
      socket.abortController = abortController;
      socket.isGenerating = true;

      // Broadcast to the workspace that this user's AI is active
      io.to(wsChannel).emit('ai-start', { userId: socket.userId, username: socket.username });

      let fullText = '';
      try {
        for await (const event of streamCompletion(
          aiProvider, aiModel, messages, apiKey, toolsEnabled,
          abortController.signal, enabledToolNames
        )) {
          if (abortController.signal.aborted) break;

          switch (event.type) {
            case 'text-delta':
              fullText += event.content;
              io.to(wsChannel).emit('ai-chunk', { content: event.content, userId: socket.userId });
              break;
            case 'tool-call':
              console.log(`[Tool] Calling: ${event.name}`, JSON.stringify(event.args));
              io.to(wsChannel).emit('tool-call', { name: event.name, args: event.args, callId: event.callId });
              break;
            case 'tool-result':
              console.log(`[Tool] Result from ${event.name}:`, JSON.stringify(event.result).substring(0, 200));
              await workspaceService.saveMessage(null, 'tool', JSON.stringify(event.result), event.name, event.callId);
              io.to(wsChannel).emit('tool-result', { name: event.name, callId: event.callId, result: event.result });
              // Notify code panel when workspace files change
              if (['write_file', 'git_clone', 'git_commit', 'shell_exec'].includes(event.name)) {
                io.to(wsChannel).emit('workspace-changed', { tool: event.name });
              }
              break;
            case 'error':
              io.to(wsChannel).emit('ai-error', { error: event.error });
              break;
            case 'done':
              if (event.fullText) await workspaceService.saveMessage(null, 'assistant', event.fullText);
              break;
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(`[Chat] AI stream error in workspace ${config.workspaceId}:`, err);
          io.to(wsChannel).emit('ai-error', { error: `AI generation failed: ${err.message}` });
        }
      } finally {
        socket.isGenerating = false;
        socket.abortController = null;
        io.to(wsChannel).emit('ai-complete', { fullText, userId: socket.userId });
      }
    } catch (err) {
      console.error('[Chat] Error:', err);
      socket.emit('error-message', { error: 'Failed to send message' });
    }
  });

  socket.on('stop-generation', () => {
    if (socket.abortController) {
      socket.abortController.abort();
      console.log(`[Chat] Generation stopped by ${socket.username}`);
    }
  });

  // Clean up on disconnect
  socket.on('disconnect', () => {
    if (socket.abortController) {
      socket.abortController.abort();
    }
  });
}

module.exports = { setupChatHandlers };
