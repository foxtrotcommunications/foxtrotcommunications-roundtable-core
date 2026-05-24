import { useRef, useEffect, useState, type KeyboardEvent } from 'react';
import Message from './Message';
import ToolCard from './ToolCard';
import MessageContent from './MessageContent';
import type { ChatMessage, ToolCall, ToolResult } from '../../types/message';
import type { PresenceUser } from '../../types/workspace';
import type { TokenUsage } from '../../hooks/useSocket';

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  streamingContent: string;
  toolCalls: Map<string, { call: ToolCall; result?: ToolResult }>;
  lastUsage: TokenUsage | null;
  onSendMessage: (content: string, activeRepo?: string) => void;
  onStopGeneration: () => void;
  onTyping: () => void;
  typingUsers: PresenceUser[];
  currentUsername?: string;
  bridgeProcessing?: boolean;
  bridgeStreamingContent?: string;
  bridgeSourceName?: string;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return n.toString();
}

export default function ChatView({
  messages, streaming, streamingContent, toolCalls, lastUsage,
  onSendMessage, onStopGeneration, onTyping, typingUsers, currentUsername,
  bridgeProcessing, bridgeStreamingContent, bridgeSourceName,
}: Props) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [inputValue, setInputValue] = useState('');
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Track scroll position to show/hide scroll-to-bottom button
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const handleScroll = () => {
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
      setShowScrollButton(!isNearBottom);
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Listen for postMessage from parent page (embed demo prompt injection)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'roundtable:setPrompt' && typeof e.data.text === 'string') {
        setInputValue(e.data.text);
        inputRef.current?.focus();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Auto-scroll to bottom on new messages / streaming — only if user is near bottom
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamingContent, streaming]);

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

  const scrollToBottom = () => {
    if (messagesRef.current) {
      messagesRef.current.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' });
    }
  };

  return (
    <>
      <div className="chat-messages" ref={messagesRef}>
        {messages.length === 0 && !streaming && (
          <div className="welcome-state">
            <div className="welcome-header">
              <div className="welcome-logo">⚡</div>
              <h2>Welcome to Roundtable</h2>
              <p className="welcome-subtitle">
                Your AI workspace is ready. Use <span className="mention mention-ai">@ai</span> to start a conversation with your AI assistant.
              </p>
            </div>

            <div className="welcome-capabilities">
              <div className="capability-card">
                <span className="capability-icon">🌐</span>
                <span className="capability-label">Web Search</span>
              </div>
              <div className="capability-card">
                <span className="capability-icon">💻</span>
                <span className="capability-label">Run Code</span>
              </div>
              <div className="capability-card">
                <span className="capability-icon">📁</span>
                <span className="capability-label">Read & Write Files</span>
              </div>
              <div className="capability-card">
                <span className="capability-icon">🔍</span>
                <span className="capability-label">Query Data</span>
              </div>
              <div className="capability-card">
                <span className="capability-icon">🔗</span>
                <span className="capability-label">Git Operations</span>
              </div>
              <div className="capability-card">
                <span className="capability-icon">🧮</span>
                <span className="capability-label">Calculator</span>
              </div>
            </div>

            <div className="welcome-prompts">
              <p className="prompts-label">Try a starter prompt</p>
              <div className="prompt-grid">
                <button className="prompt-card" onClick={() => { setInputValue('@ai What tools do you have available? Give me a quick overview of what you can help me with.'); inputRef.current?.focus(); }}>
                  <span className="prompt-icon">🛠️</span>
                  <span className="prompt-text">What can you do?</span>
                  <span className="prompt-hint">Discover available tools and capabilities</span>
                </button>
                <button className="prompt-card" onClick={() => { setInputValue('@ai Search the web for the latest news about AI agents and give me a summary of the top 3 developments.'); inputRef.current?.focus(); }}>
                  <span className="prompt-icon">🌐</span>
                  <span className="prompt-text">Search the web</span>
                  <span className="prompt-hint">Find and summarize current information</span>
                </button>
                <button className="prompt-card" onClick={() => { setInputValue('@ai Write a Python script that generates a fibonacci sequence up to n=20, then run it and show me the output.'); inputRef.current?.focus(); }}>
                  <span className="prompt-icon">🐍</span>
                  <span className="prompt-text">Write & run code</span>
                  <span className="prompt-hint">Generate and execute code in your workspace</span>
                </button>
                <button className="prompt-card" onClick={() => { setInputValue('@ai Analyze the files in this workspace. List what\'s here and suggest what we could work on together.'); inputRef.current?.focus(); }}>
                  <span className="prompt-icon">📊</span>
                  <span className="prompt-text">Analyze my workspace</span>
                  <span className="prompt-hint">Explore files and suggest next steps</span>
                </button>
              </div>
            </div>
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
                  defaultCollapsed={msg.tool_name !== 'render_chart'}
                />
              );
            } catch { return null; }
          }
          // Skip assistant messages with no visible content (from tool-call-only turns)
          if (msg.role === 'assistant' && (!msg.content || !msg.content.trim())) return null;
          const isMentioned = currentUsername && msg.content
            ? new RegExp(`@${currentUsername}\\b`, 'i').test(msg.content)
            : false;
          return <Message key={msg.id} message={msg} highlighted={isMentioned} />;
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
                {streamingContent && (
                  <MessageContent content={streamingContent} />
                )}
                <div className="streaming-indicator">
                  <span className="streaming-dot" />
                  <span className="streaming-dot" />
                  <span className="streaming-dot" />
                  <span className="streaming-label">
                    {toolCalls.size > 0
                      ? `Working — ${Array.from(toolCalls.values()).filter(t => !t.result).length > 0 ? 'running tools…' : 'thinking…'}`
                      : streamingContent ? 'generating…' : ''}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Bridge delegation processing indicator */}
        {bridgeProcessing && (
          <div className="message message-bridged">
            <div className="message-avatar bridge">🔗</div>
            <div className="message-body">
              <div className="message-header">
                <span className="message-sender">AI Assistant</span>
                <span className="bridge-source-tag">processing request from {bridgeSourceName}</span>
                <span className="message-time">now</span>
              </div>
              <div className="message-content">
                {bridgeStreamingContent && (
                  <MessageContent content={bridgeStreamingContent} />
                )}
                <div className="streaming-indicator">
                  <span className="streaming-dot" />
                  <span className="streaming-dot" />
                  <span className="streaming-dot" />
                  <span className="streaming-label">
                    {bridgeStreamingContent ? 'responding to bridge request…' : 'processing bridge request…'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Token usage indicator — shown after AI completes */}
        {!streaming && lastUsage && lastUsage.totalTokens > 0 && (
          <div className="token-usage-bar">
            <span className="token-usage-icon">⚡</span>
            <span className="token-usage-detail">{formatTokenCount(lastUsage.promptTokens)} in</span>
            <span className="token-usage-sep">·</span>
            <span className="token-usage-detail">{formatTokenCount(lastUsage.completionTokens)} out</span>
            <span className="token-usage-sep">·</span>
            <span className="token-usage-total">{formatTokenCount(lastUsage.totalTokens)} tokens</span>
          </div>
        )}
      </div>

      {/* Typing indicator */}
      <div className="typing-bar" style={{ opacity: typingText ? 1 : 0 }}>
        {typingText}
      </div>

      {showScrollButton && (
        <button className="scroll-to-bottom" onClick={scrollToBottom} title="Scroll to bottom">
          ↓
        </button>
      )}

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
