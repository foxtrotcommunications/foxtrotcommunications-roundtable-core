import { useState, useEffect } from 'react';
import * as api from '../../api';

interface Bridge {
  bridgeId: string;
  targetWsId: string;
  targetName: string;
  permissions: string[];
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function BridgePanel({ isOpen, onClose }: Props) {
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [loading, setLoading] = useState(true);


  useEffect(() => {
    api.getBridges()
      .then(setBridges)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);



  return (
    <div className={`bridge-panel ${isOpen ? 'open' : ''}`}>
      <div className="bridge-panel-header">
        <div className="bridge-panel-title">
          <span className="bridge-panel-icon">🔗</span>
          <span>Bridges</span>
          {bridges.length > 0 && (
            <span className="bridge-panel-badge">{bridges.length}</span>
          )}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
      </div>

      <div className="bridge-panel-body">
        {loading ? (
          <div className="bridge-panel-loading">
            <div className="bridge-panel-spinner" />
            <span>Checking bridges…</span>
          </div>
        ) : bridges.length === 0 ? (
          <div className="bridge-panel-empty">
            <span className="bridge-panel-empty-icon">🔗</span>
            <p>No active bridges</p>
            <p className="bridge-panel-empty-sub">
              Bridges connect this workspace to others, enabling AI-to-AI delegation and shared context.
            </p>
          </div>
        ) : (
          <>
            <div className="bridge-panel-status-bar">
              <span className="bridge-panel-status-dot" />
              <span>{bridges.length} active bridge{bridges.length !== 1 ? 's' : ''}</span>

            </div>

            {bridges.map(b => (
              <div key={b.bridgeId} className="bridge-card">
                <div className="bridge-card-header">
                  <div className="bridge-card-status-dot" />
                  <span className="bridge-card-name">{b.targetName}</span>
                </div>

                <div className="bridge-card-details">
                  <div className="bridge-card-row">
                    <span className="bridge-card-label">Direction</span>
                    <span className="bridge-card-value">↔ Bidirectional</span>
                  </div>
                  <div className="bridge-card-row">
                    <span className="bridge-card-label">Capabilities</span>
                    <div className="bridge-card-caps">
                      {b.permissions.map(p => (
                        <span key={p} className="bridge-cap-tag">{p}</span>
                      ))}
                    </div>
                  </div>

                  <div className="bridge-card-row">
                    <span className="bridge-card-label">Status</span>
                    <span className="bridge-card-value bridge-card-active">● Active</span>
                  </div>
                </div>

                <div className="bridge-card-hint">
                  <code>@ai-{b.targetName.toLowerCase()} review this query</code>
                </div>
              </div>
            ))}

            <div className="bridge-panel-footer">
              <div className="bridge-panel-footer-title">How to use bridges</div>
              <p>Use <code>@ai-{'{name}'}</code> to talk directly to a bridged workspace's AI:</p>
              <div className="bridge-panel-example">
                <code>@ai-engineering review this query</code>
              </div>
              <p>You can also use <code>@ai</code> and ask it to delegate — it knows about your bridges.</p>
              <p>Messages and results are replicated to both workspaces.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
