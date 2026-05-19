import { useState, useEffect } from 'react';
import * as api from '../../api';

interface Bridge {
  bridgeId: string;
  targetWsId: string;
  targetName: string;
  permissions: string[];
}

export default function BridgeIndicator() {
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    api.getBridges().then(setBridges).catch(() => {});
  }, []);

  if (bridges.length === 0) return null;

  return (
    <div className="bridge-indicator">
      <button
        className="bridge-toggle"
        onClick={() => setExpanded(!expanded)}
        title={`${bridges.length} bridge${bridges.length !== 1 ? 's' : ''} connected`}
      >
        <span className="bridge-icon">🔗</span>
        <span className="bridge-count">{bridges.length}</span>
        <span className="bridge-pulse" />
      </button>

      {expanded && (
        <div className="bridge-dropdown">
          <div className="bridge-dropdown-header">
            Bridged Workspaces
          </div>
          {bridges.map(b => (
            <div key={b.bridgeId} className="bridge-row">
              <div className="bridge-row-icon">↔</div>
              <div className="bridge-row-info">
                <span className="bridge-row-name">{b.targetName}</span>
                <span className="bridge-row-perms">
                  {b.permissions.join(' · ')}
                </span>
              </div>
              <div className="bridge-row-status">
                <span className="bridge-status-dot" />
                active
              </div>
            </div>
          ))}
          <div className="bridge-dropdown-footer">
            Use <code>@ai</code> to delegate tasks to bridged workspaces
          </div>
        </div>
      )}
    </div>
  );
}
