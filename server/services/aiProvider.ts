// server/services/aiProvider.ts — compatibility shim. The multi-provider AI
// interface moved to server/services/ai/ in Phase 6.1 (pure move, one file
// per provider + shared loop/format helpers). Every existing
// `require('../services/aiProvider')` keeps working through this re-export.
export { streamCompletion } from './ai';
