import { useRef, useEffect, useState, type KeyboardEvent } from 'react';
import Message from './Message';
import ToolCard from './ToolCard';
import MessageContent from './MessageContent';
import type { ChatMessage, ToolCall, ToolResult } from '../../types/message';
import type { PresenceUser } from '../../types/workspace';

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  streamingContent: string;
  toolCalls: Map<string, { call: ToolCall; result?: ToolResult }>;
  onSendMessage: (content: string, activeRepo?: string) => void;
  onStopGeneration: () => void;
  onTyping: () => void;
  typingUsers: PresenceUser[];
}

export default function ChatView({
  messages, streaming, streamingContent, toolCalls,
  onSendMessage, onStopGeneration, onTyping, typingUsers,
}: Props) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [inputValue, setInputValue] = useState('');

  // Auto-scroll to bottom on new messages / streaming
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages, streamingContent, toolCalls.size]);

  const handleSend = () => {
    const content = inputValue.trim();
    if (!content || streaming) return;
    onSendMessage(content);
    setInputValue('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (value: string) => {
    setInputValue(value);
    if (value.trim()) onTyping();
    // Auto-resize
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px';
    }
  };

  // Typing indicator text
  const typingText = typingUsers.length > 0
    ? `${typingUsers.map(u => u.displayName || u.username).join(', ')} ${typingUsers.length === 1 ? 'is' : 'are'} typing...`
    : '';

  return (
    <>
      <div className="chat-messages" ref={messagesRef}>
        {messages.length === 0 && !streaming && (
          <div className="empty-state">
            <div className="empty-state-icon">💬</div>
            <h3>Welcome to Roundtable</h3>
            <p>Send a message to start. Use <span className="mention mention-ai">@ai</span> to invoke the AI assistant.</p>
          </div>
        )}

        {messages.map(msg => {
          if (msg.role === 'tool') {
            try {
              const result = JSON.parse(msg.content);
              return (
                <ToolCard
                  key={msg.id}
                  call={{ name: msg.tool_name || 'tool', args: {}, callId: msg.tool_call_id || `hist-${msg.id}` }}
                  result={{ callId: msg.tool_call_id || `hist-${msg.id}`, result }}
                  defaultCollapsed
                />
              );
            } catch { return null; }
          }
          return <Message key={msg.id} message={msg} />;
        })}

        {/* Live tool calls during streaming */}
        {streaming && Array.from(toolCalls.values()).map(({ call, result }) => (
          <ToolCard key={call.callId} call={call} result={result} />
        ))}

        {/* Streaming AI response */}
        {streaming && (
          <div className="message">
            <div className="message-avatar assistant">AI</div>
            <div className="message-body">
              <div className="message-header">
                <span className="message-sender">AI Assistant</span>
                <span className="message-time">now</span>
              </div>
              <div className="message-content">
                {streamingContent ? (
                  <MessageContent content={streamingContent} />
                ) : (
                  <div className="streaming-indicator">
                    <span className="streaming-dot" />
                    <span className="streaming-dot" />
                    <span className="streaming-dot" />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Typing indicator */}
      <div className="typing-bar" style={{ opacity: typingText ? 1 : 0 }}>
        {typingText}
      </div>

      {/* Input area */}
      <div className="chat-input-area">
        <div className="chat-input-wrapper">
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder="Message the workspace… Use @ai to invoke AI"
            rows={1}
            value={inputValue}
            onChange={e => handleInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {streaming ? (
            <button className="chat-send-btn" onClick={onStopGeneration} title="Stop generation">
              <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            </button>
          ) : (
            <button className="chat-send-btn" onClick={handleSend} disabled={!inputValue.trim()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
            </button>
          )}
        </div>
      </div>
    </>
  );
}
