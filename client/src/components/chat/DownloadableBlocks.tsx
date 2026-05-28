import { useCallback, useRef, type ReactNode } from 'react';
import CollapsibleBlock from './CollapsibleBlock';

/** Trigger a file download — works reliably in cross-origin iframes */
function triggerDownload(url: string, filename: string, revokeUrl = false) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Defer cleanup so the browser has time to start the download
  setTimeout(() => {
    document.body.removeChild(a);
    if (revokeUrl) URL.revokeObjectURL(url);
  }, 100);
}
/** Convert SVG string to PNG and trigger download */
function downloadSvgAsPng(svgString: string, filename: string) {
  // Parse the SVG and ensure it has proper dimensions and xmlns
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) return;

  // Ensure xmlns is set
  svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svgEl.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  // Get dimensions
  const bbox = svgEl.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  const width = bbox ? bbox[2] : parseFloat(svgEl.getAttribute('width') || '800');
  const height = bbox ? bbox[3] : parseFloat(svgEl.getAttribute('height') || '600');

  // Inject light-theme CSS overrides for readable PNG export.
  // Targets mermaid CSS classes directly rather than fragile hex remapping.
  const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = `
    /* White background */
    .mermaid-container, svg { background: #ffffff; }
    /* All text → dark */
    text, .label, .edgeLabel span, .edgeLabel p,
    .nodeLabel, .cluster-label { fill: #1e293b !important; color: #1e293b !important; }
    /* Edge labels background → white */
    .edgeLabel rect, .labelBkg { fill: #ffffff !important; stroke: none !important; }
    /* Lines and arrows → dark */
    .edgePath .path, .flowchart-link { stroke: #475569 !important; }
    .arrowheadPath, marker path { fill: #475569 !important; stroke: #475569 !important; }
    /* Node shapes — keep light purple fills with indigo borders */
    .node rect, .node polygon, .node circle, .node ellipse,
    .node .label-container { fill: #e0e7ff !important; stroke: #6366f1 !important; }
    /* Cluster/subgraph backgrounds */
    .cluster rect { fill: #f1f5f9 !important; stroke: #cbd5e1 !important; }
  `;
  svgEl.insertBefore(style, svgEl.firstChild);

  // Add a white background rect
  const bgRect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bgRect.setAttribute('width', '100%');
  bgRect.setAttribute('height', '100%');
  bgRect.setAttribute('fill', '#ffffff');
  svgEl.insertBefore(bgRect, svgEl.firstChild);

  // Serialize to a data URI (avoids Blob URL CORS/taint issues)
  const serializer = new XMLSerializer();
  const svgData = serializer.serializeToString(svgEl);
  const dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);

  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    ctx.drawImage(img, 0, 0, width, height);
    try {
      canvas.toBlob((blob) => {
        if (!blob) return;
        triggerDownload(URL.createObjectURL(blob), filename, true);
      }, 'image/png');
    } catch {
      // Fallback: download as SVG if canvas export fails
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml' });
      triggerDownload(URL.createObjectURL(svgBlob), filename.replace('.png', '.svg'), true);
    }
  };
  img.onerror = () => {
    // Fallback: download as SVG
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml' });
    triggerDownload(URL.createObjectURL(svgBlob), filename.replace('.png', '.svg'), true);
  };
  img.src = dataUri;
}

/** Extract table data to CSV and trigger download */
function downloadTableAsCsv(tableEl: HTMLTableElement | null, filename: string) {
  if (!tableEl) return;
  const rows = tableEl.querySelectorAll('tr');
  const csvRows: string[] = [];
  rows.forEach(row => {
    const cells = row.querySelectorAll('th, td');
    const rowData: string[] = [];
    cells.forEach(cell => {
      // Escape quotes and wrap in quotes
      const text = (cell.textContent || '').replace(/"/g, '""');
      rowData.push(`"${text}"`);
    });
    csvRows.push(rowData.join(','));
  });
  const csv = csvRows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  triggerDownload(URL.createObjectURL(blob), filename, true);
}

// ─── Mermaid Download Wrapper ───────────────────────

interface MermaidBlockProps {
  code: string;
  MermaidRenderer: React.ComponentType<{ code: string; onSvgReady?: (svg: string) => void }>;
}

export function MermaidBlock({ code, MermaidRenderer }: MermaidBlockProps) {
  const svgRef = useRef<string>('');

  const handleSvgReady = useCallback((svg: string) => {
    svgRef.current = svg;
  }, []);

  const handleDownload = useCallback(() => {
    if (svgRef.current) {
      downloadSvgAsPng(svgRef.current, `diagram-${Date.now()}.png`);
    }
  }, []);

  return (
    <CollapsibleBlock label="Diagram" icon="🔀" onDownload={handleDownload} downloadLabel="PNG">
      <MermaidRenderer code={code} onSvgReady={handleSvgReady} />
    </CollapsibleBlock>
  );
}

// ─── Table Download Wrapper ─────────────────────────

interface TableBlockProps {
  children: ReactNode;
}

export function TableBlock({ children }: TableBlockProps) {
  const tableRef = useRef<HTMLTableElement>(null);

  const handleDownload = useCallback(() => {
    downloadTableAsCsv(tableRef.current, `table-${Date.now()}.csv`);
  }, []);

  return (
    <CollapsibleBlock label="Table" icon="📋" onDownload={handleDownload} downloadLabel="CSV">
      <div className="table-scroll-wrapper">
        <table ref={tableRef}>{children}</table>
      </div>
    </CollapsibleBlock>
  );
}
