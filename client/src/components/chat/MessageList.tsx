import { memo } from 'react';
import Message from './Message';
import ToolCard from './ToolCard';
import type { ChatMessage, ToolCall, ToolResult } from '../../types/message';

interface Props {
  messages: ChatMessage[];
  currentUsername?: string;
  knownMentions: string[];
  streaming: boolean;
  toolCalls: Map<string, { call: ToolCall; result?: ToolResult }>;
}

/**
 * Memoized message list — isolated render boundary so that input state
 * changes (typing) in ChatView don't trigger re-renders of the message
 * history, preventing chart/mermaid flash.
 */
function MessageList({ messages, currentUsername, knownMentions, streaming, toolCalls }: Props) {
  return (
    <>
      {messages.map(msg => {
        if (msg.role === 'tool') {
          // In demo/embed mode, hide tool calls — they show as distracting empty lines
          if (window.__ROUNDTABLE_DEMO__) return null;
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
        return <Message key={msg.id} message={msg} highlighted={isMentioned} knownMentions={knownMentions} />;
      })}

      {/* Live tool calls during streaming */}
      {streaming && !window.__ROUNDTABLE_DEMO__ && Array.from(toolCalls.values()).map(({ call, result }) => (
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
      prev.currentUsername === next.currentUsername) {
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

  // Tool calls: compare by size (new tool calls = re-render)
  if (prev.toolCalls.size !== next.toolCalls.size) return false;

  // Known mentions: compare by joined string (cheap content check)
  if (prev.knownMentions.length !== next.knownMentions.length) return false;
  if (prev.knownMentions.join(',') !== next.knownMentions.join(',')) return false;

  return true;
}

export default memo(MessageList, areEqual);

