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

  // Remap dark-theme inline colors to light-theme for readable PNG export.
  // Walk every element and swap fill/stroke attributes + inline styles.
  const darkToLight: Record<string, string> = {
    '#0f172a': '#ffffff',  // bg → white
    '#1e293b': '#334155',  // dark slate (used for text AND bg) → medium dark
    '#334155': '#94a3b8',  // cluster border → lighter
    '#e2e8f0': '#1e293b',  // light text → dark
    '#94a3b8': '#475569',  // light gray → darker gray
    '#c7d2fe': '#e0e7ff',  // node fill → lighter
  };

  function remapColor(c: string | null): string | null {
    if (!c) return null;
    const lower = c.toLowerCase();
    return darkToLight[lower] || null;
  }

  const allEls = svgEl.querySelectorAll('*');
  allEls.forEach(el => {
    // Remap fill attribute
    const fill = el.getAttribute('fill');
    const newFill = remapColor(fill);
    if (newFill) el.setAttribute('fill', newFill);

    // Remap stroke attribute
    const stroke = el.getAttribute('stroke');
    const newStroke = remapColor(stroke);
    if (newStroke) el.setAttribute('stroke', newStroke);

    // Remap inline style fill/stroke
    const style = el.getAttribute('style');
    if (style) {
      let newStyle = style;
      for (const [from, to] of Object.entries(darkToLight)) {
        newStyle = newStyle.replace(new RegExp(from.replace('#', '\\#'), 'gi'), to);
      }
      if (newStyle !== style) el.setAttribute('style', newStyle);
    }
  });

  // Force all text elements to be dark
  svgEl.querySelectorAll('text, tspan').forEach(el => {
    el.setAttribute('fill', '#1e293b');
    const s = el.getAttribute('style');
    if (s) el.setAttribute('style', s.replace(/fill:\s*[^;]+/g, 'fill: #1e293b'));
  });

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
