/**
 * The Roundtable action vocabulary — ONE list.
 *
 * This file exists byte-identically in two repositories until a shared
 * package carries it:
 *   core:          server/vocab/actions.ts
 *   control plane: api/services/actions.ts
 * A test in each repo hashes ACTIONS and compares it to tests/fixtures/
 * actions.sha256 (the same value in both repos); scripts/check-action-
 * literals.sh fails CI when a second list of these names appears in source.
 * Edit both copies in the same change and refresh both fixtures.
 *
 * Nothing here may import anything: the copy has to be a pure value.
 *
 * Vocabulary (what a contract's allowedActions may name, and what core
 * interprets on the wire):
 *   - transport actions: auto-allowed for every ACTIVE contract (upgrade
 *     plan 1.5 moved the message actions out of this set).
 *   - message actions: an LLM turn on the receiving side; always require an
 *     explicit grant. `message_send` is the header-less legacy alias that
 *     `message` satisfies.
 *   - intent ops: the ICE `intent.op` values. intentOpToAction() maps them to
 *     the action a contract must grant: `aggregate`/`discover` by name,
 *     `tool_call` → `tool:<name>`, `capability` → `capability:<name>`,
 *     `query` → the step's tool (or `query:<tool>` per step, 1.4).
 *   - A2A / MCP preset actions: the agent-delegation and MCP-access presets
 *     the control plane offers (AgentDelegation / McpToolAccess).
 *   - `*`: grants everything. Parametrized forms use ACTION_PREFIXES.
 * Application vocabularies (Pendragon's DOMAIN_ACTIONS, the clinical
 * presets) are NOT platform actions and live with the application.
 */

export const TRANSPORT_ACTIONS = ['tasks_get', 'tasks_cancel', 'intent_execute', 'discover'] as const;
export const MESSAGE_ACTIONS = ['message', 'delegate', 'message_send'] as const;
export const INTENT_OPS = ['query', 'tool_call', 'aggregate', 'discover', 'capability'] as const;
export const A2A_ACTIONS = ['message_send', 'tasks_get', 'tasks_cancel', 'stream_subscribe'] as const;
export const MCP_ACTIONS = ['tools_list', 'tools_call', 'resources_read', 'resources_list'] as const;
export const ACTION_PREFIXES = ['tool:', 'capability:', 'query:'] as const;
export const WILDCARD_ACTION = '*';

/** JSON-RPC methods the A2A endpoint serves (routes/a2a.ts dispatch). */
export const A2A_METHODS = ['message/send', 'tasks/get', 'tasks/cancel', 'intent/execute', 'intent/discover'] as const;

export type TransportAction = typeof TRANSPORT_ACTIONS[number];
export type MessageAction = typeof MESSAGE_ACTIONS[number];
export type IntentOp = typeof INTENT_OPS[number];
export type A2aAction = typeof A2A_ACTIONS[number];
export type McpAction = typeof MCP_ACTIONS[number];
export type KnownAction = TransportAction | MessageAction | IntentOp | A2aAction | McpAction;

/**
 * The canonical list, deduplicated, in a stable order. This is the value the
 * drift test hashes — append, never reorder, so the fixture changes only when
 * the vocabulary does.
 */
export const ACTIONS: readonly string[] = Object.freeze(Array.from(new Set<string>([
  ...TRANSPORT_ACTIONS,
  ...MESSAGE_ACTIONS,
  ...INTENT_OPS,
  ...A2A_ACTIONS,
  ...MCP_ACTIONS,
])));

/** Name → itself, for call sites that want `ACTION.delegate` instead of a literal. */
export const ACTION = Object.freeze(Object.fromEntries(ACTIONS.map((a) => [a, a]))) as Readonly<Record<KnownAction, KnownAction>>;

const KNOWN = new Set<string>(ACTIONS);

/**
 * True when `action` is a platform action: a canonical name, the wildcard,
 * or a parametrized form (`tool:x`, `capability:x`, `query:x`) with a
 * non-empty parameter. Application-defined actions return false — they are
 * valid in a contract, they just are not *this* vocabulary.
 */
export function isKnownAction(action: unknown): action is string {
  if (typeof action !== 'string' || action.length === 0) return false;
  if (action === WILDCARD_ACTION || KNOWN.has(action)) return true;
  for (const prefix of ACTION_PREFIXES) {
    if (action.startsWith(prefix) && action.length > prefix.length) return true;
  }
  return false;
}

export function isTransportAction(action: unknown): action is TransportAction {
  return typeof action === 'string' && (TRANSPORT_ACTIONS as readonly string[]).includes(action);
}

export function isMessageAction(action: unknown): action is MessageAction {
  return typeof action === 'string' && (MESSAGE_ACTIONS as readonly string[]).includes(action);
}

export function isIntentOp(op: unknown): op is IntentOp {
  return typeof op === 'string' && (INTENT_OPS as readonly string[]).includes(op);
}
