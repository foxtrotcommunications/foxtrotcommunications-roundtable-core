interface Props {
  hasBridges: boolean;
  bridgeCount?: number;
  isOpen: boolean;
  onClick: () => void;
}

/**
 * Header button that glows when bridges are active.
 * Click toggles the bridge side panel.
 */
export default function BridgeButton({ hasBridges, bridgeCount, isOpen, onClick }: Props) {
  if (!hasBridges) {
    return (
      <button
        className="btn btn-ghost btn-sm bridge-btn"
        onClick={onClick}
        title="No bridges configured — connect workspaces from the Bridges page"
        style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: 0.6 }}
      >
        🔗 <span style={{ fontSize: '0.75rem' }}>Bridges</span>
      </button>
    );
  }

  return (
    <button
      className={`btn btn-ghost btn-sm bridge-btn active${isOpen ? ' open' : ''}`}
      onClick={onClick}
      title={`Bridges — ${bridgeCount ?? 1} connected workspace${(bridgeCount ?? 1) !== 1 ? 's' : ''}`}
      style={{ display: 'flex', alignItems: 'center', gap: 4 }}
    >
      <span className="bridge-btn-icon">🔗</span>
      <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>
        Bridges{bridgeCount !== undefined && bridgeCount > 0 ? ` (${bridgeCount})` : ''}
      </span>
      <span className="bridge-btn-pulse" />
    </button>
  );
}
