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

/**
 * Clone a live DOM SVG and inline all computed styles so the exported
 * file is fully self-contained (no dependency on page stylesheets).
 */
function cloneAndInlineStyles(liveSvg: SVGSVGElement): SVGSVGElement {
  const clone = liveSvg.cloneNode(true) as SVGSVGElement;

  // Get all elements from both live and cloned trees
  const liveEls = liveSvg.querySelectorAll('*');
  const cloneEls = clone.querySelectorAll('*');

  // CSS properties relevant to SVG rendering
  const svgProps = [
    'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap',
    'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity',
    'font-family', 'font-size', 'font-weight', 'font-style',
    'text-anchor', 'dominant-baseline', 'visibility', 'display',
    'color', 'transform',
  ];

  liveEls.forEach((liveEl, i) => {
    const cloneEl = cloneEls[i];
    if (!cloneEl) return;

    const computed = window.getComputedStyle(liveEl);
    const inlineStyles: string[] = [];

    for (const prop of svgProps) {
      const val = computed.getPropertyValue(prop);
      if (val && val !== '' && val !== 'none' && val !== 'normal') {
        inlineStyles.push(`${prop}: ${val}`);
      }
    }

    if (inlineStyles.length > 0) {
      cloneEl.setAttribute('style', inlineStyles.join('; '));
    }
  });

  // Remove internal <style> tags — all styles are now inlined
  clone.querySelectorAll('style').forEach(s => s.remove());

  return clone;
}

/** Dark-to-light color mapping for export */
const DARK_TO_LIGHT: [RegExp, string][] = [
  [/#0f172a/gi, '#ffffff'],   // dark bg → white
  [/#1e293b/gi, '#1e293b'],   // keep dark text dark
  [/#334155/gi, '#e2e8f0'],   // cluster border → light
  [/#e2e8f0/gi, '#334155'],   // light text → dark
  [/#94a3b8/gi, '#64748b'],   // light gray → darker
  [/#c7d2fe/gi, '#dbeafe'],   // node fill → light blue
  [/#6366f1/gi, '#3b82f6'],   // indigo border → blue
  [/#fde68a/gi, '#fef3c7'],   // secondary → lighter
  [/#d97706/gi, '#b45309'],   // secondary border
  [/#bbf7d0/gi, '#dcfce7'],   // tertiary → lighter
  [/#16a34a/gi, '#15803d'],   // tertiary border
];

function remapToLightTheme(svgString: string): string {
  // Use unique placeholders to avoid cascading replacements
  let result = svgString;
  const placeholders: [string, string][] = [];

  DARK_TO_LIGHT.forEach(([regex, replacement], i) => {
    const placeholder = `__PLACEHOLDER_${i}__`;
    result = result.replace(regex, placeholder);
    placeholders.push([placeholder, replacement]);
  });

  for (const [placeholder, replacement] of placeholders) {
    result = result.replace(new RegExp(placeholder, 'g'), replacement);
  }

  return result;
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
    // Grab the live SVG from the DOM — this has all nodes rendered correctly
    const liveSvg = containerRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!liveSvg) return;

    // Clone and inline all computed styles
    const clone = cloneAndInlineStyles(liveSvg);

    // Ensure xmlns
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

    // Add white background
    const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bgRect.setAttribute('width', '100%');
    bgRect.setAttribute('height', '100%');
    bgRect.setAttribute('fill', '#ffffff');
    clone.insertBefore(bgRect, clone.firstChild);

    // Serialize and remap dark colors to light
    const serializer = new XMLSerializer();
    let svgData = serializer.serializeToString(clone);
    svgData = remapToLightTheme(svgData);

    const blob = new Blob([svgData], { type: 'image/svg+xml' });
    triggerDownload(URL.createObjectURL(blob), `diagram-${Date.now()}.svg`, true);
  }, []);

  return (
    <CollapsibleBlock label="Diagram" icon="🔀" onDownload={handleDownload} downloadLabel="SVG">
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
