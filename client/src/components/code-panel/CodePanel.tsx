import { useState, useEffect, useCallback, useRef } from 'react';
import FileTree from './FileTree';
import FileViewer from './FileViewer';

interface Repo { name: string; branch: string; }

interface Props {
  isOpen: boolean;
  onActiveRepoChange: (repo: string | null) => void;
  addToast?: (message: string, type?: 'success' | 'error') => void;
  onClose?: () => void;
}

export default function CodePanel({ isOpen, onActiveRepoChange, addToast, onClose }: Props) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [wordWrap, setWordWrap] = useState(() => localStorage.getItem('code-word-wrap') === 'true');
  const [uploading, setUploading] = useState(false);
  const [treeKey, setTreeKey] = useState(0); // force re-render after upload
  const [dragOver, setDragOver] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    const handler = () => { loadRepos(); setTreeKey(k => k + 1); };
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

  // Upload files
  const uploadFiles = async (files: FileList | File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      for (const file of Array.from(files)) {
        formData.append('files', file);
      }
      const uploadUrl = selectedRepo
        ? `/api/workspace/${encodeURIComponent(selectedRepo)}/upload`
        : '/api/workspace/upload?dir=uploads';
      const res = await fetch(
        uploadUrl,
        { method: 'POST', body: formData, credentials: 'same-origin' }
      );
      if (!res.ok) {
        const err = await res.json();
        addToast?.(`Upload failed: ${err.error}`, 'error');
      } else {
        const data = await res.json();
        const count = data.uploaded?.length || 0;
        addToast?.(`${count} file${count !== 1 ? 's' : ''} uploaded`, 'success');
      }
      // Refresh the tree + repo list (new dirs appear)
      setTreeKey(k => k + 1);
      loadRepos();
    } catch (err) {
      console.error('Upload error:', err);
    }
    setUploading(false);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) uploadFiles(e.target.files);
    // Reset so the same file can be re-uploaded
    e.target.value = '';
  };

  // Drag and drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files);
    }
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
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {dragOver && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 10,
            background: 'rgba(99, 102, 241, 0.15)',
            border: '2px dashed var(--accent-primary)',
            borderRadius: 'var(--radius-md)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--accent-secondary)' }}>
              📥 Drop files to upload
            </div>
          </div>
        )}

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
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileInputChange}
          />
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title="Upload files"
            style={{ fontSize: 14 }}
          >{uploading ? '⏳' : '📤'}</button>
          <button
            className={`btn btn-ghost btn-sm code-panel-wrap-btn${wordWrap ? ' active' : ''}`}
            onClick={handleWordWrapToggle}
            title="Toggle word wrap"
          >↩</button>
          {onClose && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={onClose}
              title="Close panel"
              style={{ fontSize: 14, marginLeft: 'auto' }}
            >✕</button>
          )}
        </div>

        {/* Body */}
        <div className="code-panel-body" style={{ position: 'relative' }}>
          {repos.length === 0 ? (
            <div className="file-tree-empty">
              <div style={{ fontSize: 24, marginBottom: 8 }}>📂</div>
              <div>No repos cloned yet</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Ask <span className="mention mention-ai">@ai</span> to clone a repository
                <br />or drag & drop files here
              </div>
            </div>
          ) : selectedRepo && (
            <>
              <div ref={treeRef} style={{ height: 220, flexShrink: 0, overflow: 'hidden' }}>
                <FileTree
                  key={treeKey}
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
                onFileDeleted={() => {
                  setSelectedFile(null);
                  setTreeKey(k => k + 1);
                  addToast?.('File deleted', 'success');
                }}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}
