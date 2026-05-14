import { useState, useEffect, useCallback } from 'react';

interface TreeItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  children?: TreeItem[];
}

interface Props {
  repo: string;
  selectedFile: string | null;
  onFileSelect: (path: string) => void;
}

const FILE_ICONS: Record<string, string> = {
  js: '📜', ts: '📘', tsx: '📘', jsx: '📜', py: '🐍', rb: '💎', go: '🔵', rs: '🦀',
  html: '🌐', css: '🎨', json: '📋', yml: '⚙️', yaml: '⚙️',
  md: '📝', txt: '📄', sh: '⚡', sql: '🗄️', xml: '📰',
  jpg: '🖼️', png: '🖼️', svg: '🖼️', gif: '🖼️',
  lock: '🔒', env: '🔑',
};

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return FILE_ICONS[ext] || '📄';
}

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export default function FileTree({ repo, selectedFile, onFileSelect }: Props) {
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [gitStatus, setGitStatus] = useState<Record<string, string>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const loadTree = useCallback(async () => {
    setLoading(true);
    try {
      const [treeRes, statusRes] = await Promise.all([
        fetch(`/api/workspace/${encodeURIComponent(repo)}/tree`, { credentials: 'same-origin' }),
        fetch(`/api/workspace/${encodeURIComponent(repo)}/status`, { credentials: 'same-origin' }),
      ]);
      const treeData = await treeRes.json();
      let status: Record<string, string> = {};
      try { status = (await statusRes.json()).files || {}; } catch { /* ignore */ }
      setTree(treeData.tree || []);
      setGitStatus(status);
    } catch {
      setTree([]);
    }
    setLoading(false);
  }, [repo]);

  useEffect(() => { loadTree(); }, [loadTree]);

  const toggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const dirHasChanges = (dirPath: string): boolean => {
    return Object.keys(gitStatus).some(f => f.startsWith(dirPath + '/') || f === dirPath);
  };

  const renderItems = (items: TreeItem[], depth: number) => {
    return items.map(item => {
      const indent = depth * 16;

      if (item.type === 'directory') {
        const isExpanded = expandedDirs.has(item.path);
        const hasChanges = dirHasChanges(item.path);
        return (
          <div key={item.path}>
            <div
              className="tree-dir"
              style={{ paddingLeft: indent }}
              onClick={() => toggleDir(item.path)}
            >
              <span className="tree-toggle">{isExpanded ? '▼' : '▶'}</span>
              <span className="tree-icon">{isExpanded ? '📂' : '📁'}</span>
              <span className="tree-name">{item.name}</span>
              {hasChanges && <span className="git-dot git-modified" title="Contains changes" />}
            </div>
            {isExpanded && item.children && (
              <div>{renderItems(item.children, depth + 1)}</div>
            )}
          </div>
        );
      }

      const status = gitStatus[item.path] || '';
      return (
        <div
          key={item.path}
          className={`tree-file${selectedFile === item.path ? ' active' : ''}${status ? ` git-${status}` : ''}`}
          style={{ paddingLeft: indent + 16 }}
          onClick={() => onFileSelect(item.path)}
        >
          <span className="tree-icon">{fileIcon(item.name)}</span>
          <span className="tree-name">{item.name}</span>
          {status && <span className={`git-dot git-${status}`} title={status} />}
          <span className="tree-size">{formatSize(item.size)}</span>
        </div>
      );
    });
  };

  if (loading) {
    return <div className="file-tree"><div className="file-tree-loading">Loading...</div></div>;
  }

  return (
    <div className="file-tree" style={{ overflowY: 'auto', height: '100%' }}>
      {tree.length === 0 ? (
        <div className="file-tree-loading">No files found</div>
      ) : (
        renderItems(tree, 0)
      )}
    </div>
  );
}
