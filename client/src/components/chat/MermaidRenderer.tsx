import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

// Initialize mermaid with a dark theme that matches the app
mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  themeVariables: {
    // Node colors
    primaryColor: '#c7d2fe',
    primaryTextColor: '#1e293b',
    primaryBorderColor: '#6366f1',
    secondaryColor: '#fde68a',
    secondaryTextColor: '#1e293b',
    secondaryBorderColor: '#d97706',
    tertiaryColor: '#bbf7d0',
    tertiaryTextColor: '#1e293b',
    tertiaryBorderColor: '#16a34a',
    // Lines and labels
    lineColor: '#94a3b8',
    textColor: '#e2e8f0',
    // Background
    background: '#0f172a',
    mainBkg: '#c7d2fe',
    nodeBorder: '#6366f1',
    clusterBkg: '#1e293b',
    clusterBorder: '#334155',
    titleColor: '#e2e8f0',
    edgeLabelBackground: '#1e293b',
    // Node text — dark on light pastel nodes
    nodeTextColor: '#1e293b',
    // Edge label text — light on dark background
    actorTextColor: '#e2e8f0',
    signalTextColor: '#e2e8f0',
    labelTextColor: '#e2e8f0',
    fontSize: '14px',
    fontFamily: '"Inter", system-ui, sans-serif',
  },
  flowchart: {
    htmlLabels: true,
    curve: 'basis',
    padding: 15,
    nodeSpacing: 30,
    rankSpacing: 50,
  },
  securityLevel: 'strict',
});

interface Props {
  code: string;
  onSvgReady?: (svg: string) => void;
}

let mermaidIdCounter = 0;

export default function MermaidRenderer({ code, onSvgReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${Date.now()}-${mermaidIdCounter++}`);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        const { svg: rendered } = await mermaid.render(idRef.current, code.trim());
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
          onSvgReady?.(rendered);
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message || 'Failed to render diagram');
          setSvg('');
        }
        // Clean up any leftover error containers mermaid may have inserted
        const errEl = document.getElementById(`d${idRef.current}`);
        if (errEl) errEl.remove();
      }
    }

    render();
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error-label">⚠️ Diagram rendering failed</div>
        <pre className="mermaid-error-detail">{error}</pre>
        <pre className="mermaid-source">{code}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="mermaid-loading">
        <span className="mermaid-loading-spinner" />
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mermaid-container"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
