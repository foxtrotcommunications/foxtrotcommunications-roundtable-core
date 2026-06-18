import { memo } from 'react';
import MessageContent from './MessageContent';
import { getUserColor, formatTime } from './utils';
import PinButton from '../insights/PinButton';
import type { ChatMessage } from '../../types/message';

interface Props { message: ChatMessage; highlighted?: boolean; knownMentions?: string[]; }

/**
 * Parse bridge attribution from message content.
 * Matches: [Bridge from WorkspaceName] ...
 */
function parseBridgeSource(content: string): { source: string; cleanContent: string } | null {
  const match = content.match(/^\[Bridge from (\w[\w\s]*?)\]\s*/);
  if (!match) return null;
  return { source: match[1], cleanContent: content.slice(match[0].length) };
}

function Message({ message, highlighted, knownMentions }: Props) {
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
          <MessageContent content={displayContent} knownMentions={knownMentions} provenance={message.provenance} />
        </div>
        {isAssistant && <PinButton messageId={message.id} content={message.content} />}
      </div>
    </div>
  );
}

export default memo(Message);
