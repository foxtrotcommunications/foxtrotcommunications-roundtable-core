import { useState } from 'react';
import { TOOL_ICONS } from './utils';
import ChartRenderer from './ChartRenderer';
import type { ToolCall, ToolResult, QueryResult, ChartResult, FileResult, ShellResult, SearchResult, FileListResult, FindFileResult, WriteResult, GitCommitResult } from '../../types/message';

interface Props {
  call: ToolCall;
  result?: ToolResult;
  defaultCollapsed?: boolean;
}

export default function ToolCard({ call, result, defaultCollapsed }: Props) {
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const icon = TOOL_ICONS[call.name] || '🔧';
  const label = call.name.replace(/_/g, ' ');
  const status = result
    ? (result.result && typeof result.result === 'object' && 'error' in result.result ? 'error' : 'done')
    : 'running';

  // Smart arg preview
  const args = call.args as Record<string, string>;
  const preview = args.url || args.filepath || args.filename || args.directory ||
    (args.command ? `$ ${args.command}` : '') || args.query || args.message || '';

  return (
    <div
      className={`tool-card${expanded ? ' expanded' : ''}`}
      style={{ minHeight: 36, flexShrink: 0 }}
    >
      <div className="tool-card-header" onClick={() => setExpanded(!expanded)}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', marginRight: 2 }}>▶</span>
        <span className="tool-card-icon">{icon}</span>
        <span className="tool-card-name">{label}</span>
        {preview && (
          <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>
            {preview}
          </span>
        )}
        <span className={`tool-card-status ${status}`}>
          {status === 'running' ? 'running…' : status}
        </span>
      </div>
      {expanded && result && (
        <div style={{ padding: '0 14px 12px', fontSize: 13, color: 'var(--text-secondary)' }}>
          <ToolResultBody result={result.result} />
        </div>
      )}
    </div>
  );
}

function ToolResultBody({ result }: { result: ToolResult['result'] }) {
  // Guard: if result is not an object, render it directly
  if (!result || typeof result !== 'object') {
    return <div className="tool-card-result" style={{ color: 'var(--text-secondary)' }}>{String(result)}</div>;
  }

  // Unwrap nested result wrapper if present (e.g., { name, callId, result: actualData })
  let r = result as unknown as Record<string, unknown>;
  if ('result' in r && typeof r.result === 'object' && r.result !== null && ('name' in r || 'callId' in r)) {
    r = r.result as Record<string, unknown>;
  }

  // Error — handle both string and object errors
  if ('error' in r && r.error) {
    const errorMsg = typeof r.error === 'string' ? r.error : JSON.stringify(r.error, null, 2);
    return <div className="tool-result-error">❌ {errorMsg}</div>;
  }

  // Chart result (from render_chart tool)
  if ('chartType' in r) {
    return <ChartRenderer config={r as unknown as ChartResult} />;
  }

  // Query result (BigQuery / Snowflake / Databricks)
  if ('rows' in r && 'columns' in r) {
    const qr = r as unknown as QueryResult;
    return <QueryResultTable data={qr} />;
  }

  // Search results
  if ('results' in r && Array.isArray(r.results)) {
    const sr = r as unknown as SearchResult;
    return (
      <div>
        {sr.summary && <div className="search-summary">{sr.summary}</div>}
        {sr.results.length > 0 && (
          <>
            <div className="search-sources-label">Sources</div>
            <div className="search-results">
              {sr.results.map((item, i) => (
                <div key={i} className="search-result-item">
                  <span className="search-result-title">
                    {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title || item.url}</a> : item.title}
                  </span>
                  {item.snippet && <div className="search-result-snippet">{item.snippet}</div>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  // File content
  if ('content' in r && 'filepath' in r) {
    const fr = r as unknown as FileResult;
    return (
      <div>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 12 }}>📄 {fr.filepath}</strong>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fr.lines} lines</span>
        </div>
        <pre style={{ marginTop: 4 }}><code className={`language-${fr.language || 'plaintext'}`}>{fr.content}</code></pre>
      </div>
    );
  }

  // Shell output
  if ('stdout' in r) {
    const sr = r as unknown as ShellResult;
    return (
      <div>
        <div style={{ marginTop: 8 }}><strong style={{ fontSize: 12 }}>Output:</strong></div>
        <pre style={{ marginTop: 4 }}><code className="language-bash">{sr.stdout || '(no output)'}</code></pre>
        {sr.stderr && <pre style={{ borderColor: 'rgba(239,68,68,0.2)' }}><code>{sr.stderr}</code></pre>}
      </div>
    );
  }

  // Find file
  if ('matches' in r && Array.isArray(r.matches)) {
    const fr = r as unknown as FindFileResult;
    return (
      <div>
        <div style={{ marginTop: 8 }}><strong style={{ fontSize: 12 }}>🔎 Found {fr.total} match{fr.total !== 1 ? 'es' : ''}</strong></div>
        <pre style={{ marginTop: 4 }}><code>{fr.matches.map(m => `📄 ${m}`).join('\n') || '(no matches)'}</code></pre>
      </div>
    );
  }

  // File listing
  if ('entries' in r) {
    const fl = r as unknown as FileListResult;
    const tree = fl.entries.map(e => `${e.type === 'directory' ? '📁' : '📄'} ${e.name}${e.size ? ` (${(e.size / 1024).toFixed(1)}KB)` : ''}`).join('\n');
    return (
      <div>
        <div style={{ marginTop: 8 }}>
          <strong style={{ fontSize: 12 }}>📁 {fl.directory || '.'}</strong>{' '}
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fl.total} items</span>
        </div>
        <pre style={{ marginTop: 4 }}><code>{tree}</code></pre>
      </div>
    );
  }

  // Write / clone result
  if ('action' in r && ('filepath' in r || 'path' in r)) {
    const wr = r as unknown as WriteResult;
    return (
      <div className="tool-result-success">
        ✅ {wr.action} <strong>{wr.filepath || wr.path}</strong>
        {wr.lines ? ` · ${wr.lines} lines` : ''}
        {wr.bytes ? ` · ${(wr.bytes / 1024).toFixed(1)}KB` : ''}
      </div>
    );
  }

  // Git commit
  if ('commitHash' in r) {
    const gr = r as unknown as GitCommitResult;
    return (
      <div className="tool-result-success">
        ✅ Committed <code>{gr.commitHash}</code> on <strong>{gr.branch}</strong> · {gr.filesChanged} file(s)
        {gr.pushed && ' · pushed'}
        {gr.prUrl && <><br /><a href={gr.prUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-secondary)' }}>🔗 {gr.prUrl}</a></>}
        {gr.pushError && <><br /><span style={{ color: 'var(--error)' }}>Push failed: {gr.pushError}</span></>}
      </div>
    );
  }

  // Download result
  if ('downloadUrl' in r && typeof r.downloadUrl === 'string') {
    return (
      <div className="tool-result-success" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <a
          href={r.downloadUrl as string}
          download={r.filename as string || 'download.csv'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', borderRadius: 8,
            background: 'var(--accent-primary)', color: '#fff',
            textDecoration: 'none', fontWeight: 600, fontSize: 13,
            transition: 'opacity 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
        >
          ⬇️ Download {r.filename as string || 'file'}
        </a>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {r.rowCount as number} rows · expires in {r.expiresIn as string}
        </span>
      </div>
    );
  }

  // Calculator / code runner
  if ('result' in r && r.result !== undefined) {
    return <div className="tool-result-success">= <strong>{String(r.result)}</strong></div>;
  }

  // Fallback — always show something visible
  return <div className="tool-card-result" style={{ color: 'var(--text-secondary)' }}><pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(r, null, 2)}</pre></div>;
}

function QueryResultTable({ data }: { data: QueryResult }) {
  const [viewMode, setViewMode] = useState<'table' | 'chart'>('table');
  const maxDisplay = 50;
  const displayRows = data.rows.slice(0, maxDisplay);

  // Auto-detect best chart type from data shape
  const autoChartConfig = (): ChartResult | null => {
    if (!data.columns.length || !data.rows.length) return null;

    const numericCols = data.columns.filter(col =>
      data.rows.every(row => {
        const val = row[String(col)];
        return val === null || val === undefined || !isNaN(Number(val));
      })
    );
    const labelCol = data.columns.find(col => !numericCols.includes(col)) || data.columns[0];

    if (numericCols.length === 0) return null;

    const labels = data.rows.slice(0, 50).map(row => String(row[String(labelCol)] ?? ''));
    const datasets = numericCols
      .filter(col => col !== labelCol)
      .slice(0, 5) // max 5 datasets
      .map(col => ({
        label: String(col),
        data: data.rows.slice(0, 50).map(row => Number(row[String(col)]) || 0),
      }));

    if (datasets.length === 0) return null;

    // Heuristic: detect time series
    const firstLabel = labels[0]?.toLowerCase() || '';
    const isTimeSeries = /^\d{4}[-/]/.test(firstLabel) || /date|time|month|year|day|week/i.test(String(labelCol));
    const chartType = isTimeSeries ? 'line' : data.rows.length <= 8 && datasets.length === 1 ? 'pie' : 'bar';

    return {
      chartType,
      title: data.sql ? `Results: ${data.sql.slice(0, 60)}` : 'Query Results',
      labels,
      datasets,
    };
  };

  if (viewMode === 'chart') {
    const chartConfig = autoChartConfig();
    if (chartConfig) {
      return <ChartRenderer config={chartConfig} onToggleTable={() => setViewMode('table')} />;
    }
    setViewMode('table'); // Fallback if chart can't be generated
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: "'SF Mono', monospace" }}>{data.sql || ''}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {data.rows.length > 0 && data.columns.length > 0 && (
            <button className="chart-toggle" onClick={() => setViewMode('chart')} title="View as chart">📊</button>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{data.totalRows} row{data.totalRows !== 1 ? 's' : ''}{data.truncated ? ' (truncated)' : ''}</span>
        </div>
      </div>
      {data.columns.length === 0 || data.rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>No rows returned.</div>
      ) : (
        <div style={{ overflowX: 'auto', borderRadius: 6, border: '1px solid var(--border-subtle)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: "'SF Mono', Monaco, monospace" }}>
            <thead>
              <tr style={{ background: 'var(--bg-elevated)' }}>
                {data.columns.map(col => (
                  <th key={String(col)} style={{ padding: '7px 12px', textAlign: 'left', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {String(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--bg-secondary)' }}>
                  {data.columns.map(col => {
                    const val = row[String(col)];
                    return (
                      <td key={String(col)} style={{ padding: '6px 12px', borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {val === null || val === undefined ? <span style={{ color: 'var(--text-muted)' }}>null</span> : String(val)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {displayRows.length < data.rows.length && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Showing {displayRows.length} of {data.rows.length} rows</div>
      )}
    </div>
  );
}
