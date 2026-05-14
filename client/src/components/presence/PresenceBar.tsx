import type { PresenceUser } from '../../types/workspace';
import { getUserColor } from '../chat/utils';

interface Props { users: PresenceUser[]; }

export default function PresenceBar({ users }: Props) {
  return (
    <div className="presence-bar">
      {users.map(u => {
        const name = u.displayName || u.username;
        return (
          <div
            key={u.userId}
            className="presence-avatar"
            title={name}
            style={{ background: getUserColor(u.username) }}
          >
            {name.charAt(0).toUpperCase()}
            <div className="presence-dot" />
          </div>
        );
      })}
    </div>
  );
}
