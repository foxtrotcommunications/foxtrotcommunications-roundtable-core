import { useState, useEffect, useCallback, useRef } from 'react';
import FileTree from './FileTree';
import FileViewer from './FileViewer';

interface Repo { name: string; branch: string; }

interface Props {
  isOpen: boolean;
  onActiveRepoChange: (repo: string | null) => void;
}

export default function CodePanel({ isOpen, onActiveRepoChange }: Props) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [wordWrap, setWordWrap] = useState(() => localStorage.getItem('code-word-wrap') === 'true');
  const panelRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // Load repos
  const loadRepos = useCallback(async () => {
    try {
      const res = await fetch('/api/workspace', { credentials: 'same-origin' });
      const data = await res.json();
      setRepos(data.repos || []);
      if (data.repos?.length > 0 && !selectedRepo) {
        const first = data.repos[0].name;
        setSelectedRepo(first);
        onActiveRepoChange(first);
      }
    } catch { /* ignore */ }
  }, [selectedRepo, onActiveRepoChange]);

  useEffect(() => { loadRepos(); }, [loadRepos]);

  // Listen for workspace-changed events to refresh
  useEffect(() => {
    const handler = () => loadRepos();
    window.addEventListener('workspace-changed', handler);
    return () => window.removeEventListener('workspace-changed', handler);
  }, [loadRepos]);

  const handleRepoChange = (repo: string) => {
    setSelectedRepo(repo);
    setSelectedFile(null);
    onActiveRepoChange(repo);
  };

  const handleWordWrapToggle = () => {
    const next = !wordWrap;
    setWordWrap(next);
    localStorage.setItem('code-word-wrap', String(next));
  };

  // Panel resize
  useEffect(() => {
    if (!isOpen) return;
    const saved = localStorage.getItem('code-panel-width');
    if (saved && panelRef.current) {
      panelRef.current.style.width = saved;
      panelRef.current.style.minWidth = saved;
    }
  }, [isOpen]);

  // Tree resize
  useEffect(() => {
    const saved = localStorage.getItem('code-tree-height');
    if (saved && treeRef.current) {
      treeRef.current.style.height = saved;
    }
  }, []);

  return (
    <>
      {/* Vertical resize handle for panel width */}
      {isOpen && (
        <div
          className="resize-handle-v"
          onMouseDown={(e) => {
            e.preventDefault();
            const panel = panelRef.current;
            if (!panel) return;
            const startX = e.clientX;
            const startW = panel.getBoundingClientRect().width;
            const onMove = (ev: MouseEvent) => {
              const delta = startX - ev.clientX;
              const newW = Math.min(Math.max(startW + delta, 250), window.innerWidth * 0.6);
              panel.style.width = newW + 'px';
              panel.style.minWidth = newW + 'px';
            };
            const onUp = () => {
              document.body.style.cursor = '';
              document.body.style.userSelect = '';
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onUp);
              if (panel) localStorage.setItem('code-panel-width', panel.style.width);
            };
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          }}
        />
      )}

      <div
        ref={panelRef}
        className={`code-panel${isOpen ? ' open' : ''}`}
      >
        {/* Header */}
        <div className="code-panel-header">
          <select
            className="code-panel-repo-select"
            value={selectedRepo || ''}
            onChange={(e) => handleRepoChange(e.target.value)}
          >
            {repos.length === 0 && <option value="">No repos cloned</option>}
            {repos.map(r => (
              <option key={r.name} value={r.name}>{r.name} ({r.branch})</option>
            ))}
          </select>
          <button
            className={`btn btn-ghost btn-sm code-panel-wrap-btn${wordWrap ? ' active' : ''}`}
            onClick={handleWordWrapToggle}
            title="Toggle word wrap"
          >↩</button>
        </div>

        {/* Body */}
        <div className="code-panel-body">
          {repos.length === 0 ? (
            <div className="file-tree-empty">
              <div style={{ fontSize: 24, marginBottom: 8 }}>📂</div>
              <div>No repos cloned yet</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Ask <span className="mention mention-ai">@ai</span> to clone a repository
              </div>
            </div>
          ) : selectedRepo && (
            <>
              <div ref={treeRef} style={{ height: 220, flexShrink: 0, overflow: 'hidden' }}>
                <FileTree
                  repo={selectedRepo}
                  selectedFile={selectedFile}
                  onFileSelect={(path) => setSelectedFile(path)}
                />
              </div>

              {/* Horizontal resize handle for tree height */}
              <div
                className="resize-handle-h"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const tree = treeRef.current;
                  if (!tree) return;
                  const startY = e.clientY;
                  const startH = tree.getBoundingClientRect().height;
                  const onMove = (ev: MouseEvent) => {
                    const delta = ev.clientY - startY;
                    const newH = Math.min(Math.max(startH + delta, 60), 600);
                    tree.style.height = newH + 'px';
                  };
                  const onUp = () => {
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    if (tree) localStorage.setItem('code-tree-height', tree.style.height);
                  };
                  document.body.style.cursor = 'row-resize';
                  document.body.style.userSelect = 'none';
                  document.addEventListener('mousemove', onMove);
                  document.addEventListener('mouseup', onUp);
                }}
              />

              <FileViewer
                repo={selectedRepo}
                filePath={selectedFile}
                wordWrap={wordWrap}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}
