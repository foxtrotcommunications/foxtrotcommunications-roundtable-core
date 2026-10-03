// server/sockets/chatHandler.ts — compatibility shim. The chat socket handler
// moved to server/sockets/chat/ in Phase 6.2 (pure move: session, consult,
// mcp, prompt, index). Every existing `require('./chatHandler')` keeps working
// through this re-export.
export { setupChatHandlers, buildAiTriggerPattern } from './chat';
