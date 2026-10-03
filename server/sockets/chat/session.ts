// server/sockets/chat/session.ts — Per-workspace AI request queue, per-socket
// rate-limit constants and the @-mention trigger pattern. Bodies moved
// verbatim from chatHandler.ts (Phase 6.2 split).
import type { RoundtableSocket } from '../../types';

// ─── Workspace-level AI request queue ─────────────────────────────────
// Only one AI request runs at a time per workspace to prevent
// interleaved streaming. Additional requests are queued.
export interface QueuedRequest {
  socket: RoundtableSocket;
  content: string;
  activeRepo?: string;
  isOverage: boolean;
}
export const workspaceQueues = new Map<string, QueuedRequest[]>();
export const workspaceProcessing = new Map<string, boolean>();

export function getQueue(wsId: string): QueuedRequest[] {
  if (!workspaceQueues.has(wsId)) workspaceQueues.set(wsId, []);
  return workspaceQueues.get(wsId)!;
}

export function isProcessing(wsId: string): boolean {
  return workspaceProcessing.get(wsId) || false;
}

// ─── Per-socket rate limiting ─────────────────────────────────────────
export const RATE_LIMIT_WINDOW: number = 60_000; // 1 minute
export const RATE_LIMIT_MAX: number = parseInt(process.env.AI_RATE_LIMIT || '5', 10);

// Derive workspace alias regex for @-mention triggering
// e.g., "ICU — Critical Care" → "icu", "Pharmacy" → "pharmacy"
// Pure helper — exported for tests.
export function buildAiTriggerPattern(wsName: string, wsId: string): RegExp {
  const wsAlias: string = (wsName || '').split(/[\s—–-]/)[0].trim().toLowerCase();
  const wsIdAlias: string = (wsId || '').toLowerCase();
  const aliasParts: string[] = [wsAlias, wsIdAlias]
    .filter(a => a.length >= 2 && a !== 'roundtable')
    .map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`@(?:ai${aliasParts.map(a => '|' + a).join('')})\\b`, 'i');
}
