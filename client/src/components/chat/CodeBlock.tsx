import { useCallback, useRef, useState, useMemo, type ReactNode } from 'react';

interface Props { language: string; children: string; }

// ─── JSON Syntax Highlighter ─────────────────────────────────────
function highlightJSON(json: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Regex to match JSON tokens
  const tokenRegex = /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b)|(\bnull\b)|([{}\[\],:])/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = tokenRegex.exec(json)) !== null) {
    // Add any whitespace/text before the match
    if (match.index > lastIndex) {
      nodes.push(json.slice(lastIndex, match.index));
    }

    if (match[1]) {
      // Property key
      nodes.push(
        <span key={key} className="json-key">{match[1]}</span>,
        <span key={key + 'c'} className="json-punct">:</span>
      );
      key += 2;
    } else if (match[2]) {
      // String value
      nodes.push(<span key={key++} className="json-string">{match[2]}</span>);
    } else if (match[3]) {
      // Number
      nodes.push(<span key={key++} className="json-number">{match[3]}</span>);
    } else if (match[4]) {
      // Boolean
      nodes.push(<span key={key++} className="json-boolean">{match[4]}</span>);
    } else if (match[5]) {
      // Null
      nodes.push(<span key={key++} className="json-null">{match[5]}</span>);
    } else if (match[6]) {
      // Punctuation
      nodes.push(<span key={key++} className="json-punct">{match[6]}</span>);
    }
    lastIndex = tokenRegex.lastIndex;
  }
  // Trailing text
  if (lastIndex < json.length) {
    nodes.push(json.slice(lastIndex));
  }
  return nodes;
}

// ─── Interactive JSON Tree ──────────────────────────────────────
function JsonNode({ name, value, depth = 0 }: { name?: string; value: any; depth?: number }) {
  const isObject = value !== null && typeof value === 'object';
  const isArray = Array.isArray(value);
  const [collapsed, setCollapsed] = useState(depth > 2);
  const entries = isObject ? Object.entries(value) : [];
  const bracket = isArray ? ['[', ']'] : ['{', '}'];

  if (!isObject) {
    let cls = 'json-string';
    let display = JSON.stringify(value);
    if (typeof value === 'number') cls = 'json-number';
    else if (typeof value === 'boolean') cls = 'json-boolean';
    else if (value === null) { cls = 'json-null'; display = 'null'; }

    return (
      <div className="json-line" style={{ paddingLeft: depth * 16 }}>
        {name !== undefined && <span className="json-key">"{name}"</span>}
        {name !== undefined && <span className="json-punct">: </span>}
        <span className={cls}>{display}</span>
      </div>
    );
  }

  return (
    <div className="json-node">
      <div
        className="json-line json-toggle"
        style={{ paddingLeft: depth * 16 }}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="json-caret">{collapsed ? '▶' : '▼'}</span>
        {name !== undefined && <span className="json-key">"{name}"</span>}
        {name !== undefined && <span className="json-punct">: </span>}
        <span className="json-punct">{bracket[0]}</span>
        {collapsed && (
          <span className="json-collapsed-hint">
            {isArray ? `${entries.length} items` : `${entries.length} keys`}
          </span>
        )}
        {collapsed && <span className="json-punct">{bracket[1]}</span>}
      </div>
      {!collapsed && (
        <>
          {entries.map(([k, v]) => (
            <JsonNode
              key={k}
              name={isArray ? undefined : k}
              value={v}
              depth={depth + 1}
            />
          ))}
          <div className="json-line" style={{ paddingLeft: depth * 16 }}>
            <span className="json-punct">{bracket[1]}</span>
          </div>
        </>
      )}
    </div>
  );
}

export default function CodeBlock({ language, children }: Props) {
  const codeRef = useRef<HTMLElement>(null);
  const [viewMode, setViewMode] = useState<'tree' | 'raw'>('tree');

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(children || '');
  }, [children]);

  // Try to parse JSON for the tree view
  const jsonData = useMemo(() => {
    if (language.toLowerCase() !== 'json') return null;
    try {
      return JSON.parse(children.trim());
    } catch {
      return null;
    }
  }, [language, children]);

  const isJson = language.toLowerCase() === 'json' && jsonData !== null;

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span>{language.toUpperCase()}</span>
        <div className="code-block-actions">
          {isJson && (
            <button
              className={`code-view-btn ${viewMode === 'tree' ? 'active' : ''}`}
              onClick={() => setViewMode(viewMode === 'tree' ? 'raw' : 'tree')}
              title={viewMode === 'tree' ? 'Show raw' : 'Show tree'}
            >
              {viewMode === 'tree' ? '{ }' : '🌳'}
            </button>
          )}
          <button className="code-copy-btn" onClick={handleCopy}>Copy</button>
        </div>
      </div>
      {isJson && viewMode === 'tree' ? (
        <div className="json-tree">
          <JsonNode value={jsonData} />
        </div>
      ) : (
        <pre><code ref={codeRef} className={`language-${language}`}>
          {isJson ? <>{highlightJSON(children)}</> : children}
        </code></pre>
      )}
    </div>
  );
}
