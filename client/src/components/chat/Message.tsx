import MessageContent from './MessageContent';
import { getUserColor, formatTime } from './utils';
import type { ChatMessage } from '../../types/message';

interface Props { message: ChatMessage; highlighted?: boolean; }

/**
 * Parse bridge attribution from message content.
 * Matches: [Bridge from WorkspaceName] ...
 */
function parseBridgeSource(content: string): { source: string; cleanContent: string } | null {
  const match = content.match(/^\[Bridge from (\w[\w\s]*?)\]\s*/);
  if (!match) return null;
  return { source: match[1], cleanContent: content.slice(match[0].length) };
}

export default function Message({ message, highlighted }: Props) {
  const isAssistant = message.role === 'assistant';
  const bridgeInfo = !isAssistant ? parseBridgeSource(message.content) : null;
  const isBridged = !!bridgeInfo;

  const name = isAssistant
    ? 'AI Assistant'
    : isBridged
      ? bridgeInfo.source
      : (message.display_name || message.username || 'User');

  const initial = isAssistant ? 'AI' : isBridged ? '🔗' : name.charAt(0).toUpperCase();
  const colorKey = message.username || message.display_name || 'user';

  const displayContent = isBridged ? bridgeInfo.cleanContent : message.content;

  return (
    <div className={`message${highlighted ? ' message-mentioned' : ''}${isBridged ? ' message-bridged' : ''}`} data-msg-id={message.id}>
      <div
        className={`message-avatar ${message.role}${isBridged ? ' bridged' : ''}`}
        style={isAssistant ? undefined : isBridged ? undefined : { background: getUserColor(colorKey) }}
      >
        {initial}
      </div>
      <div className="message-body">
        <div className="message-header">
          {isBridged && <span className="bridge-source-tag">🔗 bridge</span>}
          <span className="message-sender">{name}</span>
          <span className="message-time">{formatTime(message.created_at)}</span>
        </div>
        <div className="message-content">
          <MessageContent content={displayContent} />
        </div>
      </div>
    </div>
  );
}
