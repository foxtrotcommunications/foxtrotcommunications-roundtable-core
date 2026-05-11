// server/sockets/chatHandler.js — Message handling + AI streaming with tools (workspace-based)
const workspaceService = require('../services/workspaceService');
const { streamCompletion } = require('../services/aiProvider');
const config = require('../config');

let activeGeneration = false;

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

      if (activeGeneration) {
        socket.emit('error-message', { error: 'AI is still responding. Please wait.' });
        return;
      }

      const workspace = await workspaceService.getWorkspace();

      // AI provider config from workspace or defaults
      const aiProvider = (workspace && workspace.ai_provider) || 'vertexai';
      const aiModel = (workspace && workspace.ai_model) || 'gemini-1.5-flash-002';
      const toolsEnabled = workspace ? workspace.tools_enabled : true;

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

      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      for (const msg of history) {
        if (msg.role === 'tool') continue;
        messages.push({ role: msg.role, content: msg.content });
      }

      activeGeneration = true;
      io.to(wsChannel).emit('ai-start', {});

      let fullText = '';
      try {
        for await (const event of streamCompletion(aiProvider, aiModel, messages, apiKey, toolsEnabled)) {
          switch (event.type) {
            case 'text-delta':
              fullText += event.content;
              io.to(wsChannel).emit('ai-chunk', { content: event.content });
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
        console.error(`[Chat] AI stream error in workspace ${config.workspaceId}:`, err);
        io.to(wsChannel).emit('ai-error', { error: `AI generation failed: ${err.message}` });
      } finally {
        activeGeneration = false;
        io.to(wsChannel).emit('ai-complete', { fullText });
      }
    } catch (err) {
      console.error('[Chat] Error:', err);
      socket.emit('error-message', { error: 'Failed to send message' });
    }
  });

  socket.on('stop-generation', () => {
    activeGeneration = false;
  });
}

module.exports = { setupChatHandlers };
