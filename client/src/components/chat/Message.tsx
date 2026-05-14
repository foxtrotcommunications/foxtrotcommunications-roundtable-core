import MessageContent from './MessageContent';
import { getUserColor, formatTime } from './utils';
import type { ChatMessage } from '../../types/message';

interface Props { message: ChatMessage; highlighted?: boolean; }

export default function Message({ message, highlighted }: Props) {
  const isAssistant = message.role === 'assistant';
  const name = isAssistant ? 'AI Assistant' : (message.display_name || message.username || 'User');
  const initial = isAssistant ? 'AI' : name.charAt(0).toUpperCase();
  const colorKey = message.username || message.display_name || 'user';

  return (
    <div className={`message${highlighted ? ' message-mentioned' : ''}`} data-msg-id={message.id}>
      <div
        className={`message-avatar ${message.role}`}
        style={isAssistant ? undefined : { background: getUserColor(colorKey) }}
      >
        {initial}
      </div>
      <div className="message-body">
        <div className="message-header">
          <span className="message-sender">{name}</span>
          <span className="message-time">{formatTime(message.created_at)}</span>
        </div>
        <div className="message-content">
          <MessageContent content={message.content} />
        </div>
      </div>
    </div>
  );
}
