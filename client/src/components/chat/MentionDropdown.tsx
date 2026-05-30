import type { PresenceUser } from '../../types/workspace';

interface MentionItem {
  type: 'ai' | 'user' | 'bridge';
  username: string;
  displayName: string;
}

interface BridgeInfo {
  bridgeId: string;
  targetWsId: string;
  targetName: string;
  permissions: string[];
}

interface Props {
  query: string;
  users: PresenceUser[];
  bridges?: BridgeInfo[];
  selectedIndex: number;
  onSelect: (mention: MentionItem) => void;
}

/** Generate a consistent hue from a username string */
function getUserColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `linear-gradient(135deg, hsl(${hue}, 70%, 55%), hsl(${(hue + 40) % 360}, 60%, 45%))`;
}

export default function MentionDropdown({ query, users, bridges = [], selectedIndex, onSelect }: Props) {
  const q = query.toLowerCase();

  // Build list: AI first, then bridges, then online users
  const items: MentionItem[] = [
    { type: 'ai', username: 'ai', displayName: 'AI Assistant' },
  ];

  // Add bridge targets (e.g. @ai-executive, @ai-pharmacy)
  for (const b of bridges) {
    const bridgeUsername = `ai-${b.targetName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}`;
    items.push({ type: 'bridge', username: bridgeUsername, displayName: b.targetName });
  }

  for (const u of users) {
    // Skip duplicates and the AI
    if (u.username.toLowerCase() === 'ai') continue;
    items.push({ type: 'user', username: u.username, displayName: u.displayName || u.username });
  }

  // Filter by query
  const filtered = items.filter(item =>
    !q || item.username.toLowerCase().includes(q) || item.displayName.toLowerCase().includes(q)
  );

  if (filtered.length === 0) return null;

  return (
    <div className="mention-dropdown" role="listbox">
      {filtered.map((item, i) => (
        <div
          key={item.username}
          className={`mention-item${i === selectedIndex ? ' selected' : ''}${item.type === 'ai' ? ' mention-item-ai' : ''}${item.type === 'bridge' ? ' mention-item-bridge' : ''}`}
          role="option"
          aria-selected={i === selectedIndex}
          onMouseDown={e => { e.preventDefault(); onSelect(item); }}
        >
          <div
            className="mention-item-avatar"
            style={{
              background: item.type === 'ai'
                ? 'linear-gradient(135deg, #10b981, #059669)'
                : item.type === 'bridge'
                ? 'linear-gradient(135deg, #8b5cf6, #6d28d9)'
                : getUserColor(item.username),
            }}
          >
            {item.type === 'ai' ? '⚡' : item.type === 'bridge' ? '🔗' : (item.displayName || item.username).charAt(0).toUpperCase()}
          </div>
          <div className="mention-item-info">
            <span className="mention-item-name">{item.displayName}</span>
            <span className="mention-item-username">@{item.username}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export type { MentionItem, BridgeInfo };
