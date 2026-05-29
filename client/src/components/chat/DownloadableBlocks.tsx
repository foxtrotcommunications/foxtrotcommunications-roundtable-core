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
  setTimeout(() => {
    document.body.removeChild(a);
    if (revokeUrl) URL.revokeObjectURL(url);
  }, 100);
}

/** Dark→light color map for export (placeholder-based to avoid cascading) */
const DARK_TO_LIGHT: [string, string][] = [
  ['#0f172a', '#ffffff'],   // dark bg → white
  ['#0a0b0f', '#ffffff'],   // app bg → white
  ['#12131a', '#f8fafc'],   // secondary bg → near-white
  ['#1a1b25', '#f1f5f9'],   // tertiary bg → light gray
  ['#1e2030', '#f1f5f9'],   // elevated bg → light gray
  ['#1e293b', '#f8fafc'],   // cluster/edge bg → near-white
  ['#334155', '#e2e8f0'],   // cluster border → light
  ['#e2e8f0', '#334155'],   // light text → dark
  ['#e2e4f0', '#1e293b'],   // text primary → dark
  ['#8b8fa8', '#64748b'],   // text secondary
  ['#94a3b8', '#64748b'],   // light gray → darker
  ['#c7d2fe', '#dbeafe'],   // node fill → light blue
  ['#6366f1', '#3b82f6'],   // indigo border → blue
  ['#818cf8', '#6366f1'],   // accent secondary
  ['#fde68a', '#fef3c7'],   // secondary node → lighter
  ['#d97706', '#b45309'],   // secondary border
  ['#bbf7d0', '#dcfce7'],   // tertiary node → lighter
  ['#16a34a', '#15803d'],   // tertiary border
];

/**
 * Clone a live DOM SVG, inline all computed styles, and remap to light theme.
 * Returns a fully self-contained SVG string ready for canvas rendering.
 */
function cloneForLightExport(liveSvg: SVGSVGElement): string {
  const clone = liveSvg.cloneNode(true) as SVGSVGElement;

  // Inline computed styles from the live DOM
  const liveEls = liveSvg.querySelectorAll('*');
  const cloneEls = clone.querySelectorAll('*');

  const svgProps = [
    'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-dashoffset',
    'stroke-linecap', 'stroke-linejoin', 'opacity', 'fill-opacity',
    'stroke-opacity', 'font-family', 'font-size', 'font-weight',
    'font-style', 'text-anchor', 'dominant-baseline', 'visibility',
    'display', 'color', 'transform',
  ];

  liveEls.forEach((liveEl, i) => {
    const cloneEl = cloneEls[i];
    if (!cloneEl) return;

    const computed = window.getComputedStyle(liveEl);
    const styles: string[] = [];

    for (const prop of svgProps) {
      const val = computed.getPropertyValue(prop);
      if (val && val !== '' && val !== 'none' && val !== 'normal' && val !== '0') {
        styles.push(`${prop}: ${val}`);
      }
    }

    if (styles.length > 0) {
      cloneEl.setAttribute('style', styles.join('; '));
    }
  });

  // Remove <style> tags — all styles are now inlined
  clone.querySelectorAll('style').forEach(s => s.remove());

  // Ensure xmlns
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  // Add white background
  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bgRect.setAttribute('width', '100%');
  bgRect.setAttribute('height', '100%');
  bgRect.setAttribute('fill', '#ffffff');
  clone.insertBefore(bgRect, clone.firstChild);

  // Serialize
  const serializer = new XMLSerializer();
  let svgData = serializer.serializeToString(clone);

  // Remap dark colors to light using placeholders (avoids cascading)
  DARK_TO_LIGHT.forEach(([dark, _], i) => {
    svgData = svgData.replace(new RegExp(dark.replace('#', '\\#'), 'gi'), `__PH${i}__`);
  });
  DARK_TO_LIGHT.forEach(([_, light], i) => {
    svgData = svgData.replace(new RegExp(`__PH${i}__`, 'g'), light);
  });

  return svgData;
}

/** Export light-mode SVG as PNG via canvas */
function exportAsPng(svgData: string, filename: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgData, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) return;

  const bbox = svgEl.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  const width = bbox ? bbox[2] : parseFloat(svgEl.getAttribute('width') || '800');
  const height = bbox ? bbox[3] : parseFloat(svgEl.getAttribute('height') || '600');

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
      // Fallback: download as SVG if canvas fails
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
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDownload = useCallback(() => {
    const liveSvg = containerRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!liveSvg) return;

    // Clone live SVG, inline styles, remap to light theme
    const svgData = cloneForLightExport(liveSvg);

    // Export as PNG
    exportAsPng(svgData, `diagram-${Date.now()}.png`);
  }, []);

  return (
    <CollapsibleBlock label="Diagram" icon="🔀" onDownload={handleDownload} downloadLabel="PNG">
      <div ref={containerRef}>
        <MermaidRenderer code={code} />
      </div>
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
