import { memo, Component, type ReactNode } from 'react';
import Message from './Message';
import ToolCard from './ToolCard';
import type { ChatMessage, ToolCall, ToolResult } from '../../types/message';

interface Props {
  messages: ChatMessage[];
  currentUsername?: string;
  knownMentions: string[];
  streaming: boolean;
  toolCalls: Map<string, { call: ToolCall; result?: ToolResult }>;
  showToolCalls: boolean;
}

/** Catches render errors in ToolCard so one bad result doesn't break the list */
class ToolCardBoundary extends Component<{ children: ReactNode; toolName: string }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: Error) { return { error: err.message }; }
  render() {
    if (this.state.error) {
      return (
        <div className="tool-card" style={{ padding: '8px 14px', fontSize: 12, color: 'var(--error)' }}>
          🔧 {this.props.toolName} — render error: {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Memoized message list — isolated render boundary so that input state
 * changes (typing) in ChatView don't trigger re-renders of the message
 * history, preventing chart/mermaid flash.
 */
function MessageList({ messages, currentUsername, knownMentions, streaming, toolCalls, showToolCalls }: Props) {
  return (
    <>
      {messages.map(msg => {
        if (msg.role === 'tool') {
          if (!showToolCalls) return null;
          try {
            const result = JSON.parse(msg.content);
            return (
              <ToolCardBoundary key={msg.id} toolName={msg.tool_name || 'tool'}>
                <ToolCard
                  call={{ name: msg.tool_name || 'tool', args: {}, callId: msg.tool_call_id || `hist-${msg.id}` }}
                  result={{ callId: msg.tool_call_id || `hist-${msg.id}`, result }}
                  defaultCollapsed={msg.tool_name !== 'render_chart'}
                />
              </ToolCardBoundary>
            );
          } catch { return null; }
        }
        // Skip assistant messages with no visible content (from tool-call-only turns)
        if (msg.role === 'assistant' && (!msg.content || !msg.content.trim())) return null;
        const isMentioned = currentUsername && msg.content
          ? new RegExp(`@${currentUsername}\\b`, 'i').test(msg.content)
          : false;
        return <Message key={msg.id} message={msg} highlighted={isMentioned} knownMentions={knownMentions} />;
      })}

      {/* Live tool calls during streaming */}
      {streaming && showToolCalls && Array.from(toolCalls.values()).map(({ call, result }) => (
        <ToolCard key={call.callId} call={call} result={result} />
      ))}
    </>
  );
}

/**
 * Custom comparator — hooks often return new array/Map references with
 * identical content, defeating default shallow memo. Compare by content
 * so the list only re-renders when messages actually change.
 */
function areEqual(prev: Props, next: Props): boolean {
  // Fast path: if references are the same, skip
  if (prev.messages === next.messages &&
      prev.toolCalls === next.toolCalls &&
      prev.knownMentions === next.knownMentions &&
      prev.streaming === next.streaming &&
      prev.currentUsername === next.currentUsername &&
      prev.showToolCalls === next.showToolCalls) {
    return true;
  }

  // Messages: compare by count + last message id + last message content length
  if (prev.messages.length !== next.messages.length) return false;
  if (prev.messages.length > 0) {
    const pLast = prev.messages[prev.messages.length - 1];
    const nLast = next.messages[next.messages.length - 1];
    if (pLast.id !== nLast.id || pLast.content?.length !== nLast.content?.length) return false;
  }

  // Scalars
  if (prev.streaming !== next.streaming) return false;
  if (prev.currentUsername !== next.currentUsername) return false;
  if (prev.showToolCalls !== next.showToolCalls) return false;

  // Tool calls: compare by size (new tool calls = re-render)
  if (prev.toolCalls.size !== next.toolCalls.size) return false;

  // Known mentions: compare by joined string (cheap content check)
  if (prev.knownMentions.length !== next.knownMentions.length) return false;
  if (prev.knownMentions.join(',') !== next.knownMentions.join(',')) return false;

  return true;
}

export default memo(MessageList, areEqual);

