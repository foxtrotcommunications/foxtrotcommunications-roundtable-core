// public/js/chat.js — Chat UI rendering + streaming + cursor presence
const Chat = {
  messagesEl: null,
  streamingEl: null,
  streamingContent: '',
  isStreaming: false,
  userCursors: new Map(), // userId → { element, timeout }

  init() {
    this.messagesEl = document.getElementById('chat-messages');
    // Track scroll position for cursor sharing
    if (this.messagesEl) {
      let scrollDebounce;
      this.messagesEl.addEventListener('scroll', () => {
        clearTimeout(scrollDebounce);
        scrollDebounce = setTimeout(() => {
          Socket.sendScrolling();
          // Find the message closest to the viewport center
          const centerY = this.messagesEl.scrollTop + this.messagesEl.clientHeight / 2;
          const msgs = this.messagesEl.querySelectorAll('.message[data-msg-id]');
          let closest = null, closestDist = Infinity;
          msgs.forEach((m) => {
            const dist = Math.abs(m.offsetTop - centerY);
            if (dist < closestDist) { closestDist = dist; closest = m; }
          });
          if (closest) Socket.sendCursorPosition(closest.dataset.msgId);
        }, 200);
      });
    }
  },

  clear() {
    if (this.messagesEl) this.messagesEl.innerHTML = '';
    this.streamingEl = null;
    this.streamingContent = '';
    this.isStreaming = false;
    this.userCursors.forEach((v) => { if (v.element) v.element.remove(); });
    this.userCursors.clear();
  },

  async loadHistory() {
    this.clear();
    try {
      const messages = await API.getMessages();
      for (const msg of messages) this.renderMessage(msg, false);
      this.scrollToBottom();
    } catch (err) { console.error('Failed to load messages:', err); }
  },

  addMessage(msg) {
    this.renderMessage(msg, true);
    this.scrollToBottom();
  },

  renderMessage(msg, animate) {
    // Render tool results from history as tool cards
    if (msg.role === 'tool') {
      try {
        const result = JSON.parse(msg.content);
        const toolName = msg.tool_name || 'tool';
        const callId = msg.tool_call_id || `hist-${msg.id}`;
        const icons = { git_clone: '📦', read_file: '📄', write_file: '✏️', list_files: '📁', shell_exec: '⚡', web_search: '🔍', read_url: '🌐', calculator: '🧮', run_code: '▶️' };
        const icon = icons[toolName] || '🔧';
        const label = toolName.replace(/_/g, ' ');
        this.showToolCall({ name: toolName, args: {}, callId });
        this.showToolResult({ callId, result });
        // Collapse historical tool cards
        const card = document.getElementById(`tool-${callId}`);
        if (card) card.classList.remove('expanded');
      } catch (e) { /* skip malformed tool messages */ }
      return;
    }

    const el = document.createElement('div');
    el.className = 'message';
    if (msg.id) el.dataset.msgId = msg.id;
    if (!animate) el.style.animation = 'none';

    const isAssistant = msg.role === 'assistant';
    const initial = isAssistant ? 'AI' : (msg.display_name || msg.username || '?').charAt(0).toUpperCase();
    const name = isAssistant ? 'AI Assistant' : (msg.display_name || msg.username || 'User');
    let time = '';
    if (msg.created_at) {
      // Postgres returns '2026-05-11 22:20:33.783' — normalize to ISO 8601
      let ts = String(msg.created_at).replace(' ', 'T');
      if (!ts.endsWith('Z') && !ts.includes('+')) ts += 'Z';
      const d = new Date(ts);
      time = isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    // Unique color per user — use username as key to match presence bar
    const colorKey = msg.username || msg.display_name || 'user';
    const avatarStyle = isAssistant ? '' : `style="background:${this.getUserColor(colorKey)}"`;

    el.innerHTML = `
      <div class="message-avatar ${msg.role}" ${avatarStyle}>${initial}</div>
      <div class="message-body">
        <div class="message-header">
          <span class="message-sender">${this.escapeHtml(name)}</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-content">${this.formatContent(msg.content)}</div>
      </div>
    `;
    this.messagesEl.appendChild(el);
  },

  // ─── User Cursor Presence ─────────────────────────
  showUserCursor(data) {
    const { userId, username, displayName, messageId } = data;
    const targetMsg = this.messagesEl?.querySelector(`.message[data-msg-id="${messageId}"]`);
    if (!targetMsg) return;

    let cursor = this.userCursors.get(userId);
    if (!cursor) {
      const el = document.createElement('div');
      el.className = 'user-cursor-label';
      const colors = ['#ec4899', '#f59e0b', '#10b981', '#8b5cf6', '#06b6d4'];
      const color = colors[userId % colors.length];
      el.style.cssText = `position:absolute;right:8px;top:-2px;background:${color};color:white;font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;z-index:10;pointer-events:none;opacity:0.85;transition:top 0.3s ease;`;
      el.textContent = displayName || username;
      cursor = { element: el, timeout: null };
      this.userCursors.set(userId, cursor);
    }

    // Move cursor label to the target message
    targetMsg.style.position = 'relative';
    if (cursor.element.parentNode) cursor.element.parentNode.removeChild(cursor.element);
    targetMsg.appendChild(cursor.element);

    // Fade out after 5s of inactivity
    clearTimeout(cursor.timeout);
    cursor.element.style.opacity = '0.85';
    cursor.timeout = setTimeout(() => { cursor.element.style.opacity = '0'; }, 5000);
  },

  showStreaming(active) {
    this.isStreaming = active;
    const sendBtn = document.getElementById('chat-send');
    if (sendBtn) sendBtn.disabled = active;

    if (active) {
      this.streamingContent = '';
      this.streamingEl = document.createElement('div');
      this.streamingEl.className = 'message';
      this.streamingEl.innerHTML = `
        <div class="message-avatar assistant">AI</div>
        <div class="message-body">
          <div class="message-header"><span class="message-sender">AI Assistant</span><span class="message-time">now</span></div>
          <div class="message-content"><div class="streaming-indicator"><span class="streaming-dot"></span><span class="streaming-dot"></span><span class="streaming-dot"></span></div></div>
        </div>`;
      this.messagesEl.appendChild(this.streamingEl);
      this.scrollToBottom();
    }
  },

  appendAIChunk(content) {
    this.streamingContent += content;
    if (this.streamingEl) {
      this.streamingEl.querySelector('.message-content').innerHTML = this.formatContent(this.streamingContent);
      this.scrollToBottom();
    }
  },

  showToolCall(data) {
    const card = document.createElement('div');
    card.className = 'tool-card expanded'; // Start expanded so users see what's happening
    card.id = `tool-${data.callId}`;

    const icons = { git_clone: '📦', git_commit: '📝', read_file: '📄', write_file: '✏️', list_files: '📁', find_file: '🔎', shell_exec: '⚡', web_search: '🔍', read_url: '🌐', calculator: '🧮', run_code: '▶️' };
    const icon = icons[data.name] || '🔧';
    const label = data.name.replace(/_/g, ' ');

    // Smart argument display
    let argsPreview = '';
    if (data.args.url) argsPreview = data.args.url;
    else if (data.args.filepath) argsPreview = data.args.filepath;
    else if (data.args.filename) argsPreview = data.args.filename;
    else if (data.args.directory) argsPreview = data.args.directory;
    else if (data.args.command) argsPreview = `$ ${data.args.command}`;
    else if (data.args.query) argsPreview = data.args.query;
    else if (data.args.message) argsPreview = data.args.message;

    card.innerHTML = `
      <div class="tool-card-header" onclick="this.parentElement.classList.toggle('expanded')">
        <span class="tool-card-icon">${icon}</span>
        <span class="tool-card-name">${label}</span>
        ${argsPreview ? `<span style="color:var(--text-muted);font-size:12px;margin-left:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px;">${this.escapeHtml(argsPreview)}</span>` : ''}
        <span class="tool-card-status running">running…</span>
      </div>
      <div class="tool-card-body"></div>`;
    this.messagesEl.appendChild(card);
    this.scrollToBottom();
  },

  showToolResult(data) {
    const card = document.getElementById(`tool-${data.callId}`);
    if (!card) return;

    const status = card.querySelector('.tool-card-status');
    status.textContent = data.result.error ? 'error' : 'done';
    status.className = `tool-card-status ${data.result.error ? 'error' : 'done'}`;

    const body = card.querySelector('.tool-card-body');

    // Smart result rendering based on tool type
    if (data.result.results && Array.isArray(data.result.results)) {
      // Web search results — render summary + source cards
      let html = '';
      if (data.result.summary) {
        html += `<div class="search-summary">${this.escapeHtml(data.result.summary)}</div>`;
      }
      if (data.result.results.length === 0 && !data.result.summary) {
        html += `<div class="tool-result-empty">No results found.</div>`;
      } else if (data.result.results.length > 0) {
        html += `<div class="search-sources-label">Sources</div>`;
        html += `<div class="search-results">${data.result.results.map(r => {
          // Clean up redirect URLs to show just the domain
          let displayUrl = r.url || '';
          const titleText = r.title || displayUrl;
          try { displayUrl = titleText || new URL(r.url).hostname; } catch (e) {}
          return `<div class="search-result-item">
            <span class="search-result-title">${r.url ? `<a href="${this.escapeHtml(r.url)}" target="_blank" rel="noopener">${this.escapeHtml(titleText)}</a>` : this.escapeHtml(titleText)}</span>
            ${r.snippet ? `<div class="search-result-snippet">${this.escapeHtml(r.snippet)}</div>` : ''}
          </div>`;
        }).join('')}</div>`;
      }
      body.innerHTML += html;
    } else if (data.result.content && data.result.filepath) {
      // File content
      const lang = data.result.language || 'plaintext';
      const filepath = data.result.filepath || '';
      const isMarkdown = filepath.endsWith('.md') || filepath.endsWith('.mdx') || lang === 'markdown';

      if (isMarkdown && window.marked) {
        // Render markdown files as formatted HTML
        body.innerHTML += `
          <div style="margin-top:8px;display:flex;align-items:center;justify-content:space-between;">
            <strong style="font-size:12px;">📄 ${this.escapeHtml(filepath)}</strong>
            <span style="font-size:11px;color:var(--text-muted);">${data.result.lines} lines</span>
          </div>
          <div class="rendered-markdown">${this.formatContent(data.result.content)}</div>`;
      } else {
        // Code files — show with syntax highlighting
        body.innerHTML += `
          <div style="margin-top:8px;display:flex;align-items:center;justify-content:space-between;">
            <strong style="font-size:12px;">📄 ${this.escapeHtml(filepath)}</strong>
            <span style="font-size:11px;color:var(--text-muted);">${data.result.lines} lines</span>
          </div>
          <pre style="margin-top:4px;"><code class="language-${lang}">${this.escapeHtml(data.result.content)}</code></pre>`;
      }
    } else if (data.result.stdout !== undefined) {
      // Shell output
      body.innerHTML += `
        <div style="margin-top:8px;"><strong style="font-size:12px;">Output:</strong></div>
        <pre style="margin-top:4px;"><code class="language-bash">${this.escapeHtml(data.result.stdout || '(no output)')}</code></pre>`;
      if (data.result.stderr) {
        body.innerHTML += `<pre style="border-color:rgba(239,68,68,0.2);"><code>${this.escapeHtml(data.result.stderr)}</code></pre>`;
      }
    } else if (data.result.matches && Array.isArray(data.result.matches)) {
      // find_file results
      const matchList = data.result.matches.map(m => `📄 ${m}`).join('\n');
      body.innerHTML += `
        <div style="margin-top:8px;"><strong style="font-size:12px;">🔎 Found ${data.result.total} match${data.result.total !== 1 ? 'es' : ''}</strong></div>
        <pre style="margin-top:4px;"><code>${this.escapeHtml(matchList || '(no matches)')}</code></pre>`;
    } else if (data.result.entries) {
      // File listing
      const tree = data.result.entries.map(e => `${e.type === 'directory' ? '📁' : '📄'} ${e.name}${e.size ? ` (${(e.size/1024).toFixed(1)}KB)` : ''}`).join('\n');
      body.innerHTML += `
        <div style="margin-top:8px;"><strong style="font-size:12px;">📁 ${this.escapeHtml(data.result.directory || '.')}</strong> <span style="font-size:11px;color:var(--text-muted);">${data.result.total} items</span></div>
        <pre style="margin-top:4px;"><code>${this.escapeHtml(tree)}</code></pre>`;
    } else if (data.result.action && data.result.filepath) {
      // Write/clone result — clean summary
      body.innerHTML += `
        <div class="tool-result-success">
          ✅ ${this.escapeHtml(data.result.action)} <strong>${this.escapeHtml(data.result.filepath)}</strong>
          ${data.result.lines ? ` · ${data.result.lines} lines` : ''}
          ${data.result.bytes ? ` · ${(data.result.bytes/1024).toFixed(1)}KB` : ''}
        </div>`;
    } else if (data.result.action && data.result.path) {
      // Git clone result
      body.innerHTML += `
        <div class="tool-result-success">
          ✅ Repository ${this.escapeHtml(data.result.action)} to <strong>${this.escapeHtml(data.result.path)}</strong>
        </div>`;
    } else if (data.result.commitHash) {
      // Git commit result
      let commitHtml = `✅ Committed <code>${this.escapeHtml(data.result.commitHash)}</code> on <strong>${this.escapeHtml(data.result.branch)}</strong> · ${data.result.filesChanged} file(s)`;
      if (data.result.pushed) commitHtml += ' · pushed';
      if (data.result.prUrl) commitHtml += `<br><a href="${this.escapeHtml(data.result.prUrl)}" target="_blank" rel="noopener" style="color:var(--accent-secondary);">🔗 ${this.escapeHtml(data.result.prUrl)}</a>`;
      if (data.result.pushError) commitHtml += `<br><span style="color:var(--error);">Push failed: ${this.escapeHtml(data.result.pushError)}</span>`;
      if (data.result.prError) commitHtml += `<br><span style="color:var(--error);">PR failed: ${this.escapeHtml(data.result.prError)}</span>`;
      body.innerHTML += `<div class="tool-result-success">${commitHtml}</div>`;
    } else if (data.result.error) {
      body.innerHTML += `<div class="tool-result-error">❌ ${this.escapeHtml(data.result.error)}</div>`;
    } else if (data.result.result !== undefined) {
      // Calculator / code runner
      body.innerHTML += `
        <div class="tool-result-success">= <strong>${this.escapeHtml(String(data.result.result))}</strong></div>`;
    } else {
      // Fallback — compact JSON
      body.innerHTML += `<div class="tool-card-result">${this.escapeHtml(JSON.stringify(data.result, null, 2))}</div>`;
    }

    // Apply syntax highlighting
    body.querySelectorAll('pre code').forEach((block) => {
      if (window.hljs) hljs.highlightElement(block);
    });

    this.scrollToBottom();
  },

  showAIError(error) {
    const el = document.createElement('div');
    el.className = 'message';
    el.innerHTML = `
      <div class="message-avatar assistant" style="background:linear-gradient(135deg,#dc2626,#ef4444)">!</div>
      <div class="message-body">
        <div class="message-header"><span class="message-sender" style="color:var(--error)">Error</span></div>
        <div class="message-content" style="color:var(--error)">${this.escapeHtml(error)}</div>
      </div>`;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  },

  finalizeAIResponse() { this.streamingEl = null; this.streamingContent = ''; },

  scrollToBottom() {
    if (this.messagesEl) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  },

  formatContent(text) {
    if (!text) return '';

    // Use marked for full markdown rendering
    if (window.marked) {
      marked.setOptions({
        gfm: true,
        breaks: true,
        highlight: function(code, lang) {
          if (window.hljs && lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
          }
          return code;
        },
      });

      // Custom renderer for code blocks with copy button
      const renderer = new marked.Renderer();
      renderer.code = function({ text: code, lang }) {
        const id = 'code-' + Math.random().toString(36).substr(2, 6);
        const langLabel = lang || 'code';
        let highlighted = code;
        if (window.hljs && lang && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(code, { language: lang }).value;
        }
        return `<div class="code-block-wrapper">
          <div class="code-block-header">
            <span>${langLabel}</span>
            <button class="code-copy-btn" onclick="Chat.copyCode('${id}')">📋 Copy</button>
          </div>
          <pre><code id="${id}" class="language-${lang || 'plaintext'}">${highlighted}</code></pre>
        </div>`;
      };

      let html = marked.parse(text, { renderer });
      // Highlight @mentions — @ai gets accent, others get subtle highlight
      html = html.replace(/@(ai)\b/gi, '<span class="mention mention-ai">@$1</span>');
      html = html.replace(/@(\w+)/g, (match, name) => {
        if (name.toLowerCase() === 'ai') return match; // already handled
        return `<span class="mention">@${name}</span>`;
      });
      return html;
    }

    // Fallback: basic regex rendering
    let html = this.escapeHtml(text);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
      const id = 'code-' + Math.random().toString(36).substr(2, 6);
      return `<div class="code-block-wrapper">
        <div class="code-block-header"><span>${lang || 'code'}</span>
          <button class="code-copy-btn" onclick="Chat.copyCode('${id}')">📋 Copy</button></div>
        <pre><code id="${id}" class="language-${lang || 'plaintext'}">${code}</code></pre></div>`;
    });
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/\n/g, '<br>');
    return html;
  },

  copyCode(id) {
    const el = document.getElementById(id);
    if (el) {
      navigator.clipboard.writeText(el.textContent).then(() => App.showToast('Code copied!', 'success'));
    }
  },

  escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; },

  // Consistent color per username from a curated palette
  getUserColor(username) {
    const gradients = [
      'linear-gradient(135deg, #6366f1, #8b5cf6)', // Indigo → Violet
      'linear-gradient(135deg, #ec4899, #f43f5e)', // Pink → Rose
      'linear-gradient(135deg, #f59e0b, #ef4444)', // Amber → Red
      'linear-gradient(135deg, #06b6d4, #3b82f6)', // Cyan → Blue
      'linear-gradient(135deg, #8b5cf6, #d946ef)', // Violet → Fuchsia
      'linear-gradient(135deg, #14b8a6, #06b6d4)', // Teal → Cyan
      'linear-gradient(135deg, #f97316, #facc15)', // Orange → Yellow
      'linear-gradient(135deg, #2563eb, #7c3aed)', // Blue → Purple
    ];
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
      hash = ((hash << 5) - hash + username.charCodeAt(i)) | 0;
    }
    return gradients[Math.abs(hash) % gradients.length];
  },
};
