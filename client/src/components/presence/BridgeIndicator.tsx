

interface Props {
  hasBridges: boolean;
  isOpen: boolean;
  onClick: () => void;
}

/**
 * Header button that glows when bridges are active.
 * Click toggles the bridge side panel.
 */
export default function BridgeButton({ hasBridges, isOpen, onClick }: Props) {
  if (!hasBridges) {
    return (
      <button
        className="btn btn-ghost btn-sm bridge-btn"
        onClick={onClick}
        title="Bridges"
      >
        🔗
      </button>
    );
  }

  return (
    <button
      className={`btn btn-ghost btn-sm bridge-btn active${isOpen ? ' open' : ''}`}
      onClick={onClick}
      title="Bridges — connected"
    >
      <span className="bridge-btn-icon">🔗</span>
      <span className="bridge-btn-pulse" />
    </button>
  );
}
