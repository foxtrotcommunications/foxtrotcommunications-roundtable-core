// server/services/ai/format.ts — Message-shape helpers (system prompt
// extraction, Anthropic/Google message formatting). Bodies moved verbatim
// from aiProvider.ts (Phase 6.1 split).
import type { ChatMessage } from '../../types';

export function extractSystemPrompt(messages: ChatMessage[]): string {
  const sys: ChatMessage | undefined = messages.find((m: ChatMessage) => m.role === 'system');
  return sys ? sys.content : '';
}

export function formatAnthropicMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages
    .filter((m: ChatMessage) => m.role !== 'system')
    .map((m: ChatMessage) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
}

export function extractGoogleSystemInstruction(messages: ChatMessage[]): string {
  const sys: ChatMessage | undefined = messages.find((m: ChatMessage) => m.role === 'system');
  return sys ? sys.content : '';
}

export function formatGoogleMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages
    .filter((m: ChatMessage) => m.role !== 'system')
    .map((m: ChatMessage) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}
