import { useState, type ReactNode } from 'react';

interface Props {
  icon: string;
  label: string;
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export default function ProvenanceSection({ icon, label, summary, defaultOpen = false, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`prov-section ${open ? 'prov-section-open' : ''}`}>
      <button className="prov-section-header" onClick={() => setOpen(!open)}>
        <span className="prov-section-icon">{icon}</span>
        <span className="prov-section-label">{label}</span>
        {summary && <span className="prov-section-summary">{summary}</span>}
        <span className={`prov-section-chevron ${open ? 'prov-chevron-open' : ''}`}>▸</span>
      </button>
      {open && <div className="prov-section-content">{children}</div>}
    </div>
  );
}
