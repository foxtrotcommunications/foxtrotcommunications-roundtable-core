import { useState, useEffect } from 'react';
import hljs from 'highlight.js';
import ReactMarkdown from 'react-markdown';

interface FileData {
  path: string;
  content: string;
  lines: number;
  language?: string;
  size: number;
  truncated?: boolean;
}

interface Props {
  repo: string;
  filePath: string | null;
  wordWrap: boolean;
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'];
const VIDEO_EXTS = ['mp4', 'webm', 'ogg'];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export default function FileViewer({ repo, filePath, wordWrap }: Props) {
  const [file, setFile] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!filePath) { setFile(null); return; }

    const ext = filePath.split('.').pop()?.toLowerCase() || '';

    // Images and videos don't need the file API
    if (IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext)) {
      setFile({ path: filePath, content: '', lines: 0, language: ext, size: 0 });
      return;
    }

    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/workspace/${encodeURIComponent(repo)}/file?path=${encodeURIComponent(filePath)}`,
          { credentials: 'same-origin' }
        );
        const data = await res.json();
        setFile(data);
      } catch {
        setFile({ path: filePath, content: 'Failed to load file', lines: 0, size: 0 });
      }
      setLoading(false);
    };
    load();
  }, [repo, filePath]);

  if (!filePath) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-empty">
          <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.4 }}>📄</div>
          Select a file to view
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-loading">Loading...</div>
      </div>
    );
  }

  if (!file) return null;

  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const rawUrl = `/api/workspace/${encodeURIComponent(repo)}/raw?path=${encodeURIComponent(filePath)}`;

  // Image viewer
  if (IMAGE_EXTS.includes(ext)) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <span className="file-viewer-path">{filePath}</span>
          <span className="file-viewer-meta">{ext.toUpperCase()}</span>
        </div>
        <div className="file-viewer-media">
          <img src={rawUrl} alt={filePath} />
        </div>
      </div>
    );
  }

  // Video viewer
  if (VIDEO_EXTS.includes(ext)) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <span className="file-viewer-path">{filePath}</span>
          <span className="file-viewer-meta">{ext.toUpperCase()}</span>
        </div>
        <div className="file-viewer-media">
          <video controls src={rawUrl} style={{ maxWidth: '100%' }} />
        </div>
      </div>
    );
  }

  // Markdown viewer
  const isMarkdown = ['md', 'mdx'].includes(ext);
  if (isMarkdown) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <span className="file-viewer-path">{filePath}</span>
          <span className="file-viewer-meta">{file.lines} lines · {formatSize(file.size)}</span>
        </div>
        <div className="rendered-markdown" style={{ margin: 0, borderRadius: 0, maxHeight: 'none' }}>
          <ReactMarkdown>{file.content}</ReactMarkdown>
        </div>
      </div>
    );
  }

  // Code viewer with syntax highlighting
  const lang = file.language || ext || 'plaintext';
  let highlighted = file.content;
  try {
    if (hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(file.content, { language: lang }).value;
    }
  } catch { /* fallback to plain text */ }

  return (
    <div className="file-viewer">
      <div className="file-viewer-header">
        <span className="file-viewer-path">{filePath}</span>
        <span className="file-viewer-meta">{file.lines} lines · {formatSize(file.size)}</span>
      </div>
      <pre className={`file-viewer-code${wordWrap ? ' word-wrap' : ''}`}>
        <code
          className={`language-${lang}`}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}
