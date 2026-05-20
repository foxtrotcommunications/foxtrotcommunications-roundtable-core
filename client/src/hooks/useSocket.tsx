// Socket.IO hooks and context

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ChatMessage, ToolCall, ToolResult } from '../types/message';
import type { PresenceUser } from '../types/workspace';

// ─── Socket Context ─────────────────────────────────
interface SocketContextValue {
  socket: Socket | null;
  connected: boolean;
}

const SocketContext = createContext<SocketContextValue>({ socket: null, connected: false });

export function SocketProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const s = io({ withCredentials: true });
    socketRef.current = s;

    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));

    return () => { s.disconnect(); };
  }, []);

  return (
    <SocketContext.Provider value={{ socket: socketRef.current, connected }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}

// ─── Chat Hook ──────────────────────────────────────

export interface ChatState {
  messages: ChatMessage[];
  streaming: boolean;
  streamingContent: string;
  toolCalls: Map<string, { call: ToolCall; result?: ToolResult }>;
  lastUsage: TokenUsage | null;
  bridgeProcessing: boolean;
  bridgeStreamingContent: string;
  bridgeSourceName: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export function useChat(socket: Socket | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const streamingContentRef = useRef('');
  const [streamingContent, setStreamingContent] = useState('');
  const [toolCalls, setToolCalls] = useState<Map<string, { call: ToolCall; result?: ToolResult }>>(new Map());
  const [lastUsage, setLastUsage] = useState<TokenUsage | null>(null);
  const [bridgeProcessing, setBridgeProcessing] = useState(false);
  const bridgeStreamingRef = useRef('');
  const [bridgeStreamingContent, setBridgeStreamingContent] = useState('');
  const [bridgeSourceName, setBridgeSourceName] = useState('');

  useEffect(() => {
    if (!socket) return;

    const onMessage = (msg: ChatMessage) => {
      setMessages(prev => [...prev, msg]);
    };

    const onAiStart = () => {
      setStreaming(true);
      streamingContentRef.current = '';
      setStreamingContent('');
      setToolCalls(new Map());
      setLastUsage(null);
    };

    const onAiUsage = (data: TokenUsage) => {
      setLastUsage(data);
    };

    const onAiChunk = (data: { content: string }) => {
      streamingContentRef.current += data.content;
      setStreamingContent(streamingContentRef.current);
    };

    const onToolCall = (data: ToolCall) => {
      setToolCalls(prev => {
        const next = new Map(prev);
        next.set(data.callId, { call: data });
        return next;
      });
    };

    const onToolResult = (data: ToolResult) => {
      setToolCalls(prev => {
        const next = new Map(prev);
        const existing = next.get(data.callId);
        if (existing) {
          next.set(data.callId, { ...existing, result: data });
        }
        return next;
      });
    };

    const onAiError = (data: { error: string }) => {
      setMessages(prev => [...prev, {
        id: Date.now(),
        workspace_id: '',
        user_id: null,
        role: 'assistant',
        content: `⚠️ ${data.error}`,
        created_at: new Date().toISOString(),
      }]);
      setStreaming(false);
    };

    const onAiComplete = (data: { fullText?: string }) => {
      // The server sends fullText with the complete AI response.
      // We need to add it as a message since the server doesn't emit new-message for AI responses.
      if (data?.fullText) {
        setMessages(prev => [...prev, {
          id: Date.now(),
          workspace_id: '',
          user_id: null,
          role: 'assistant' as const,
          content: data.fullText!,
          created_at: new Date().toISOString(),
        }]);
      }
      setStreaming(false);
      streamingContentRef.current = '';
      setStreamingContent('');
    };

    socket.on('new-message', onMessage);
    socket.on('ai-start', onAiStart);
    socket.on('ai-chunk', onAiChunk);
    socket.on('tool-call', onToolCall);
    socket.on('tool-result', onToolResult);
    socket.on('ai-error', onAiError);
    socket.on('ai-complete', onAiComplete);
    socket.on('ai-usage', onAiUsage);

    // Bridge processing events
    const onBridgeStart = (data: { sourceWorkspace: string }) => {
      setBridgeProcessing(true);
      bridgeStreamingRef.current = '';
      setBridgeStreamingContent('');
      setBridgeSourceName(data.sourceWorkspace);
    };
    const onBridgeChunk = (data: { content: string }) => {
      bridgeStreamingRef.current = data.content;
      setBridgeStreamingContent(data.content);
    };
    const onBridgeComplete = () => {
      setBridgeProcessing(false);
      bridgeStreamingRef.current = '';
      setBridgeStreamingContent('');
      setBridgeSourceName('');
    };

    socket.on('bridge-processing-start', onBridgeStart);
    socket.on('bridge-ai-chunk', onBridgeChunk);
    socket.on('bridge-processing-complete', onBridgeComplete);

    return () => {
      socket.off('new-message', onMessage);
      socket.off('ai-start', onAiStart);
      socket.off('ai-chunk', onAiChunk);
      socket.off('tool-call', onToolCall);
      socket.off('tool-result', onToolResult);
      socket.off('ai-error', onAiError);
      socket.off('ai-complete', onAiComplete);
      socket.off('ai-usage', onAiUsage);
      socket.off('bridge-processing-start', onBridgeStart);
      socket.off('bridge-ai-chunk', onBridgeChunk);
      socket.off('bridge-processing-complete', onBridgeComplete);
    };
  }, [socket]);

  const sendMessage = useCallback((content: string, activeRepo?: string) => {
    if (socket) socket.emit('send-message', { content, activeRepo });
  }, [socket]);

  const stopGeneration = useCallback(() => {
    if (socket) socket.emit('stop-generation');
  }, [socket]);

  return { messages, setMessages, streaming, streamingContent, toolCalls, lastUsage, sendMessage, stopGeneration, bridgeProcessing, bridgeStreamingContent, bridgeSourceName };
}

// ─── Presence Hook ──────────────────────────────────

export function usePresence(socket: Socket | null) {
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!socket) return;

    const onPresence = (data: { users: PresenceUser[] }) => {
      setUsers(data.users);
    };

    socket.on('presence-update', onPresence);
    return () => { socket.off('presence-update', onPresence); };
  }, [socket]);

  const sendTypingStart = useCallback(() => {
    if (socket) socket.emit('typing-start');
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      if (socket) socket.emit('typing-stop');
    }, 3000);
  }, [socket]);

  return { users, sendTypingStart };
}
