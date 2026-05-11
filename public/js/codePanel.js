// public/js/codePanel.js — File browser panel for viewing workspace repos
const CodePanel = {
  isOpen: false,
  currentRepo: null,
  currentFile: null,
  tree: [],
  wordWrap: false,

  init() {
    console.log('[CodePanel] init called');
    // Toggle button handler (header 📁 button)
    const toggleBtn = document.getElementById('btn-code-panel');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => this.toggle());
    }
    // Close button inside panel (▶ arrow)
    const closeBtn = document.getElementById('btn-code-panel-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.toggle());
    }

    // Restore panel open state
    const panel = document.getElementById('code-panel');
    const wasOpen = localStorage.getItem('code-panel-open') === 'true';
    if (wasOpen && panel) {
      this.isOpen = true;
      panel.classList.add('open');
      if (toggleBtn) toggleBtn.classList.add('active');
    }

    // Always load repos so they're ready when panel opens
    this.loadRepos();

    // Word wrap toggle
    this.wordWrap = localStorage.getItem('code-word-wrap') === 'true';
    const wrapBtn = document.getElementById('btn-word-wrap');
    if (wrapBtn) {
      if (this.wordWrap) wrapBtn.classList.add('active');
      wrapBtn.addEventListener('click', () => {
        this.wordWrap = !this.wordWrap;
        wrapBtn.classList.toggle('active', this.wordWrap);
        localStorage.setItem('code-word-wrap', this.wordWrap);
        document.querySelectorAll('.file-viewer-code').forEach(el => {
          el.classList.toggle('word-wrap', this.wordWrap);
        });
      });
    }

    // Vertical resize (panel width)
    this._initPanelResize();
    // Horizontal resize (tree/viewer split)
    this._initTreeResize();
  },

  _initPanelResize() {
    const handle = document.getElementById('resize-panel');
    const panel = document.getElementById('code-panel');
    if (!handle || !panel) return;

    let startX, startW;
    const onMouseMove = (e) => {
      const delta = startX - e.clientX;
      const newW = Math.min(Math.max(startW + delta, 250), window.innerWidth * 0.6);
      panel.style.width = newW + 'px';
      panel.style.minWidth = newW + 'px';
    };
    const onMouseUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      localStorage.setItem('code-panel-width', panel.style.width);
    };
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    // Restore saved width
    const saved = localStorage.getItem('code-panel-width');
    if (saved) { panel.style.width = saved; panel.style.minWidth = saved; }
  },

  _initTreeResize() {
    const handle = document.getElementById('resize-tree');
    const tree = document.getElementById('file-tree');
    if (!handle || !tree) return;

    let startY, startH;
    const onMouseMove = (e) => {
      const delta = e.clientY - startY;
      const newH = Math.min(Math.max(startH + delta, 60), 600);
      tree.style.height = newH + 'px';
    };
    const onMouseUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      localStorage.setItem('code-tree-height', tree.style.height);
    };
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = tree.getBoundingClientRect().height;
      handle.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    // Restore saved height
    const saved = localStorage.getItem('code-tree-height');
    if (saved) tree.style.height = saved;
  },

  toggle() {
    this.isOpen = !this.isOpen;
    const panel = document.getElementById('code-panel');
    const toggleBtn = document.getElementById('btn-code-panel');
    if (panel) {
      panel.classList.toggle('open', this.isOpen);
      if (toggleBtn) toggleBtn.classList.toggle('active', this.isOpen);
      localStorage.setItem('code-panel-open', this.isOpen);

      if (this.isOpen) {
        // Restore saved width if available
        const savedW = localStorage.getItem('code-panel-width');
        if (savedW) { panel.style.width = savedW; panel.style.minWidth = savedW; }
        this.loadRepos();
      } else {
        // Clear inline styles so CSS class controls visibility
        panel.style.width = '';
        panel.style.minWidth = '';
      }
    }
  },

  async loadRepos() {
    try {
      const res = await fetch('/api/workspace');
      const data = await res.json();
      console.log('[CodePanel] loadRepos response:', data);
      const select = document.getElementById('repo-select');
      if (!select) { console.log('[CodePanel] select element not found'); return; }

      if (!data.repos || data.repos.length === 0) {
        console.log('[CodePanel] No repos found');
        select.innerHTML = '<option value="">No repos cloned</option>';
        this.renderEmptyState();
        return;
      }

      console.log('[CodePanel] Found repos:', data.repos.map(r => r.name));

      select.innerHTML = data.repos
        .map((r) => `<option value="${r.name}">${r.name} (${r.branch})</option>`)
        .join('');

      // Auto-select first repo or restore previous selection
      const repoToSelect = this.currentRepo && data.repos.find(r => r.name === this.currentRepo)
        ? this.currentRepo
        : data.repos[0].name;
      this.currentRepo = repoToSelect;
      select.value = repoToSelect;
      this.loadTree(repoToSelect);

      // Remove old listener by replacing element
      const newSelect = select.cloneNode(true);
      select.parentNode.replaceChild(newSelect, select);
      newSelect.addEventListener('change', (e) => {
        this.currentRepo = e.target.value;
        this.loadTree(this.currentRepo);
      });
    } catch (err) {
      console.error('[CodePanel] Failed to load repos:', err);
    }
  },

  async loadTree(repo) {
    const treeEl = document.getElementById('file-tree');
    if (!treeEl) return;
    treeEl.innerHTML = '<div class="file-tree-loading">Loading...</div>';

    try {
      const [treeRes, statusRes] = await Promise.all([
        fetch(`/api/workspace/${encodeURIComponent(repo)}/tree`),
        fetch(`/api/workspace/${encodeURIComponent(repo)}/status`),
      ]);
      const treeData = await treeRes.json();
      let gitStatus = {};
      try { gitStatus = (await statusRes.json()).files || {}; } catch (_) {}

      this.tree = treeData.tree || [];
      this.gitStatus = gitStatus;
      treeEl.innerHTML = this.renderTree(this.tree, 0, gitStatus);
      this.attachTreeListeners(treeEl);
    } catch (err) {
      treeEl.innerHTML = '<div class="file-tree-loading">Failed to load</div>';
    }
  },

  _dirHasChanges(dirPath, gitStatus) {
    return Object.keys(gitStatus).some(f => f.startsWith(dirPath + '/') || f === dirPath);
  },

  renderTree(items, depth = 0, gitStatus = {}) {
    return items
      .map((item) => {
        const indent = depth * 16;
        if (item.type === 'directory') {
          const dirChanged = this._dirHasChanges(item.path, gitStatus);
          return `
          <div class="tree-dir" data-path="${this.escapeAttr(item.path)}" style="padding-left:${indent}px">
            <span class="tree-toggle">▶</span>
            <span class="tree-icon">📁</span>
            <span class="tree-name">${this.escapeHtml(item.name)}</span>
            ${dirChanged ? '<span class="git-dot git-modified" title="Contains changes"></span>' : ''}
          </div>
          <div class="tree-children" data-parent="${this.escapeAttr(item.path)}" style="display:none;">
            ${item.children ? this.renderTree(item.children, depth + 1, gitStatus) : ''}
          </div>`;
        }
        const status = gitStatus[item.path] || '';
        const dotClass = status ? `git-dot git-${status}` : '';
        return `
        <div class="tree-file ${status ? 'git-' + status : ''}" data-path="${this.escapeAttr(item.path)}" style="padding-left:${indent + 16}px">
          <span class="tree-icon">${this.fileIcon(item.name)}</span>
          <span class="tree-name">${this.escapeHtml(item.name)}</span>
          ${dotClass ? `<span class="${dotClass}" title="${status}"></span>` : ''}
          <span class="tree-size">${this.formatSize(item.size)}</span>
        </div>`;
      })
      .join('');
  },

  attachTreeListeners(container) {
    // Directory toggle
    container.querySelectorAll('.tree-dir').forEach((dir) => {
      dir.addEventListener('click', () => {
        const path = dir.dataset.path;
        const children = container.querySelector(`.tree-children[data-parent="${path}"]`);
        const toggle = dir.querySelector('.tree-toggle');
        if (children) {
          const isOpen = children.style.display !== 'none';
          children.style.display = isOpen ? 'none' : 'block';
          toggle.textContent = isOpen ? '▶' : '▼';
          dir.querySelector('.tree-icon').textContent = isOpen ? '📁' : '📂';
        }
      });
    });
    // File click
    container.querySelectorAll('.tree-file').forEach((file) => {
      file.addEventListener('click', () => {
        // Remove previous active
        container.querySelectorAll('.tree-file.active').forEach((f) => f.classList.remove('active'));
        file.classList.add('active');
        this.openFile(file.dataset.path);
      });
    });
  },

  async openFile(filePath) {
    this.currentFile = filePath;
    const viewer = document.getElementById('file-viewer');
    if (!viewer) return;

    const ext = filePath.split('.').pop().toLowerCase();
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'];
    const videoExts = ['mp4', 'webm', 'ogg'];
    const rawUrl = `/api/workspace/${encodeURIComponent(this.currentRepo)}/raw?path=${encodeURIComponent(filePath)}`;

    // Handle images
    if (imageExts.includes(ext)) {
      viewer.innerHTML = `
        <div class="file-viewer-header">
          <span class="file-viewer-path">${this.escapeHtml(filePath)}</span>
          <span class="file-viewer-meta">${ext.toUpperCase()}</span>
        </div>
        <div class="file-viewer-media">
          <img src="${rawUrl}" alt="${this.escapeHtml(filePath)}" />
        </div>`;
      return;
    }

    // Handle video
    if (videoExts.includes(ext)) {
      viewer.innerHTML = `
        <div class="file-viewer-header">
          <span class="file-viewer-path">${this.escapeHtml(filePath)}</span>
          <span class="file-viewer-meta">${ext.toUpperCase()}</span>
        </div>
        <div class="file-viewer-media">
          <video controls src="${rawUrl}" style="max-width:100%;"></video>
        </div>`;
      return;
    }

    // Handle text files
    viewer.innerHTML = '<div class="file-viewer-loading">Loading...</div>';

    try {
      const res = await fetch(
        `/api/workspace/${encodeURIComponent(this.currentRepo)}/file?path=${encodeURIComponent(filePath)}`,
      );
      const data = await res.json();

      const isMarkdown = ['md', 'mdx'].includes(ext);
      const lang = data.language || ext || 'plaintext';

      let contentHtml;
      if (isMarkdown && window.marked) {
        contentHtml = `<div class="rendered-markdown">${marked.parse(data.content)}</div>`;
      } else {
        let highlighted = this.escapeHtml(data.content);
        if (window.hljs && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(data.content, { language: lang }).value;
        }
        contentHtml = `<pre class="file-viewer-code${this.wordWrap ? ' word-wrap' : ''}"><code class="language-${lang}">${highlighted}</code></pre>`;
      }

      viewer.innerHTML = `
        <div class="file-viewer-header">
          <span class="file-viewer-path">${this.escapeHtml(filePath)}</span>
          <span class="file-viewer-meta">${data.lines} lines · ${this.formatSize(data.size)}</span>
        </div>
        ${contentHtml}`;
    } catch (err) {
      viewer.innerHTML = `<div class="file-viewer-loading">Failed to load file</div>`;
    }
  },

  refresh() {
    if (this.isOpen && this.currentRepo) {
      this.loadTree(this.currentRepo);
      if (this.currentFile) this.openFile(this.currentFile);
    }
    // Also reload repo list in case a new repo was cloned
    this.loadRepos();
  },

  renderEmptyState() {
    const treeEl = document.getElementById('file-tree');
    if (treeEl) {
      treeEl.innerHTML = `
        <div class="file-tree-empty">
          <div style="font-size:24px;margin-bottom:8px;">📂</div>
          <div>No repos cloned yet</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            Ask <span class="mention mention-ai">@ai</span> to clone a repository
          </div>
        </div>`;
    }
  },

  fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const icons = {
      js: '📜', ts: '📘', py: '🐍', rb: '💎', go: '🔵', rs: '🦀',
      html: '🌐', css: '🎨', json: '📋', yml: '⚙️', yaml: '⚙️',
      md: '📝', txt: '📄', sh: '⚡', sql: '🗄️', xml: '📰',
      jpg: '🖼️', png: '🖼️', svg: '🖼️', gif: '🖼️',
      lock: '🔒', env: '🔑',
    };
    return icons[ext] || '📄';
  },

  formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  },

  escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  },

  escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
};
