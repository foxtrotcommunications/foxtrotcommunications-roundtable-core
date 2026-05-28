import { useState, type ReactNode, type MouseEvent } from 'react';

interface Props {
  label: string;
  icon?: string;
  defaultOpen?: boolean;
  onDownload?: () => void;
  downloadLabel?: string;
  children: ReactNode;
}

export default function CollapsibleBlock({
  label,
  icon = '📊',
  defaultOpen = true,
  onDownload,
  downloadLabel = 'PNG',
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  const handleDownload = (e: MouseEvent) => {
    e.stopPropagation(); // Don't toggle collapse
    onDownload?.();
  };

  return (
    <div className={`collapsible-block ${open ? 'collapsible-open' : 'collapsible-closed'}`}>
      <button
        className="collapsible-header"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="collapsible-icon">{icon}</span>
        <span className="collapsible-label">{label}</span>
        {onDownload && (
          <span
            className="collapsible-download"
            onClick={handleDownload}
            role="button"
            tabIndex={0}
            title={`Download as ${downloadLabel}`}
          >
            ⬇ {downloadLabel}
          </span>
        )}
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
