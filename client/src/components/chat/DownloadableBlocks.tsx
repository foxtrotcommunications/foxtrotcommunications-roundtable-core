import { useCallback, useRef, type ReactNode } from 'react';
import mermaid from 'mermaid';
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

/** Re-render mermaid code with a light theme and return the SVG string */
async function renderLightThemeSvg(code: string): Promise<string> {
  // Use a unique ID to avoid collisions with the displayed diagram
  const exportId = `mermaid-export-${Date.now()}`;

  // Save current config, render with light theme, then we don't need to restore
  // because mermaid.render() uses the current config at call time
  const prevConfig = mermaid.mermaidAPI.getConfig();

  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      primaryColor: '#dbeafe',
      primaryTextColor: '#1e293b',
      primaryBorderColor: '#3b82f6',
      secondaryColor: '#fef3c7',
      secondaryTextColor: '#1e293b',
      secondaryBorderColor: '#d97706',
      tertiaryColor: '#dcfce7',
      tertiaryTextColor: '#1e293b',
      tertiaryBorderColor: '#16a34a',
      lineColor: '#475569',
      textColor: '#1e293b',
      background: '#ffffff',
      mainBkg: '#dbeafe',
      nodeBorder: '#3b82f6',
      clusterBkg: '#f1f5f9',
      clusterBorder: '#cbd5e1',
      titleColor: '#1e293b',
      edgeLabelBackground: '#ffffff',
      nodeTextColor: '#1e293b',
      actorTextColor: '#1e293b',
      signalTextColor: '#1e293b',
      labelTextColor: '#475569',
      fontSize: '14px',
      fontFamily: '"Inter", system-ui, sans-serif',
    },
    flowchart: {
      htmlLabels: false,
      curve: 'basis',
      padding: 15,
      nodeSpacing: 30,
      rankSpacing: 50,
    },
    securityLevel: 'strict',
  });

  try {
    const { svg } = await mermaid.render(exportId, code.trim());
    return svg;
  } finally {
    // Restore the dark theme config for on-screen rendering
    mermaid.initialize({
      startOnLoad: false,
      theme: prevConfig.theme,
      themeVariables: prevConfig.themeVariables,
      flowchart: prevConfig.flowchart,
      securityLevel: prevConfig.securityLevel,
    });

    // Clean up any temporary element mermaid may have inserted
    const tempEl = document.getElementById(`d${exportId}`);
    if (tempEl) tempEl.remove();
  }
}

/** Convert SVG string to PNG and trigger download */
function svgToPng(svgString: string, filename: string, bgColor = '#ffffff') {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) return;

  svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svgEl.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  const bbox = svgEl.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  const width = bbox ? bbox[2] : parseFloat(svgEl.getAttribute('width') || '800');
  const height = bbox ? bbox[3] : parseFloat(svgEl.getAttribute('height') || '600');

  // Add background rect
  const bgRect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bgRect.setAttribute('width', '100%');
  bgRect.setAttribute('height', '100%');
  bgRect.setAttribute('fill', bgColor);
  svgEl.insertBefore(bgRect, svgEl.firstChild);

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
      // Fallback: download as SVG
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml' });
      triggerDownload(URL.createObjectURL(svgBlob), filename.replace('.png', '.svg'), true);
    }
  };
  img.onerror = () => {
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
  const handleDownload = useCallback(async () => {
    try {
      // Re-render with light theme specifically for export
      const lightSvg = await renderLightThemeSvg(code);

      // Parse and add white background
      const parser = new DOMParser();
      const doc = parser.parseFromString(lightSvg, 'image/svg+xml');
      const svgEl = doc.querySelector('svg');
      if (!svgEl) return;

      svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const bgRect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bgRect.setAttribute('width', '100%');
      bgRect.setAttribute('height', '100%');
      bgRect.setAttribute('fill', '#ffffff');
      svgEl.insertBefore(bgRect, svgEl.firstChild);

      const serializer = new XMLSerializer();
      const svgData = serializer.serializeToString(svgEl);
      const blob = new Blob([svgData], { type: 'image/svg+xml' });
      triggerDownload(URL.createObjectURL(blob), `diagram-${Date.now()}.svg`, true);
    } catch (err) {
      console.error('Failed to render light-theme diagram for export:', err);
    }
  }, [code]);

  return (
    <CollapsibleBlock label="Diagram" icon="🔀" onDownload={handleDownload} downloadLabel="SVG">
      <MermaidRenderer code={code} />
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
