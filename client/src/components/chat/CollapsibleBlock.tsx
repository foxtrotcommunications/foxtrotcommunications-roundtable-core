import { useState, type ReactNode } from 'react';

interface Props {
  label: string;
  icon?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export default function CollapsibleBlock({ label, icon = '📊', defaultOpen = true, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`collapsible-block ${open ? 'collapsible-open' : 'collapsible-closed'}`}>
      <button
        className="collapsible-header"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="collapsible-icon">{icon}</span>
        <span className="collapsible-label">{label}</span>
        <span className={`collapsible-chevron ${open ? 'chevron-open' : ''}`}>▶</span>
      </button>
      {open && (
        <div className="collapsible-content">
          {children}
        </div>
      )}
    </div>
  );
}
