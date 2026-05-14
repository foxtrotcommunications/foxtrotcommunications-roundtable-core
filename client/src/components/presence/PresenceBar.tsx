import { useState } from 'react';
import type { PresenceUser } from '../../types/workspace';
import { getUserColor } from '../chat/utils';

interface Props { users: PresenceUser[]; }

export default function PresenceBar({ users }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="presence-bar">
      <button
        className="presence-toggle"
        onClick={() => setExpanded(!expanded)}
        title={`${users.length} user${users.length !== 1 ? 's' : ''} online`}
      >
        <div className="presence-avatars">
          {users.slice(0, 3).map(u => {
            const name = u.displayName || u.username;
            return (
              <div
                key={u.userId}
                className="presence-avatar"
                style={{ background: getUserColor(u.username) }}
              >
                {name.charAt(0).toUpperCase()}
                <div className="presence-dot" />
              </div>
            );
          })}
        </div>
        <span className="presence-count">
          {users.length} online
        </span>
      </button>

      {expanded && (
        <div className="presence-dropdown">
          <div className="presence-dropdown-header">Online now</div>
          {users.map(u => {
            const name = u.displayName || u.username;
            return (
              <div key={u.userId} className="presence-user-row">
                <div
                  className="presence-avatar-sm"
                  style={{ background: getUserColor(u.username) }}
                >
                  {name.charAt(0).toUpperCase()}
                  <div className="presence-dot" />
                </div>
                <div className="presence-user-info">
                  <span className="presence-user-name">{name}</span>
                  <span className="presence-user-status">
                    {u.activity === 'composing' ? 'typing…' : 'online'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
