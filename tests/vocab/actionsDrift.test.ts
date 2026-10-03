/**
 * Drift tripwire for the action vocabulary (Phase 6.5).
 *
 * server/vocab/actions.ts exists byte-identically in the control plane as
 * api/services/actions.ts. Until a shared package carries it, each repo
 * hashes its ACTIONS list and compares to tests/fixtures/actions.sha256 —
 * the same value in both repos. Change the vocabulary in one repo without
 * the other and one of the two CI runs goes red.
 *
 * Updating on purpose: edit BOTH copies, then in each repo
 *   npx tsx -e "import {ACTIONS} from './server/vocab/actions'; import {createHash} from 'crypto'; console.log(createHash('sha256').update(JSON.stringify(ACTIONS)).digest('hex'))"
 * and write the value to tests/fixtures/actions.sha256 (CP: api/tests/fixtures/).
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ACTIONS, ACTION, TRANSPORT_ACTIONS, MESSAGE_ACTIONS, INTENT_OPS, A2A_ACTIONS, MCP_ACTIONS,
  isKnownAction, isTransportAction, isMessageAction, isIntentOp,
} from '../../server/vocab/actions';

const FIXTURE = join(__dirname, '..', 'fixtures', 'actions.sha256');
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

describe('action vocabulary drift tripwire', () => {
  test('sha256(ACTIONS) equals the shared fixture', () => {
    const expected = readFileSync(FIXTURE, 'utf8').trim();
    expect(sha(ACTIONS)).toBe(expected);
  });

  test('ACTIONS is the deduplicated union of the five groups, in group order', () => {
    const union = Array.from(new Set([...TRANSPORT_ACTIONS, ...MESSAGE_ACTIONS, ...INTENT_OPS, ...A2A_ACTIONS, ...MCP_ACTIONS]));
    expect([...ACTIONS]).toEqual(union);
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
  });

  test('the names the code relies on are present', () => {
    for (const a of ['intent_execute', 'discover', 'tasks_get', 'tasks_cancel', 'message', 'delegate', 'message_send',
                     'query', 'tool_call', 'aggregate', 'capability', 'stream_subscribe', 'tools_call']) {
      expect(ACTIONS).toContain(a);
    }
    expect(ACTION.delegate).toBe('delegate');
    expect(Object.isFrozen(ACTION)).toBe(true);
    expect(Object.isFrozen(ACTIONS)).toBe(true);
  });

  test('isKnownAction: names, wildcard and parametrized forms; not application actions', () => {
    expect(isKnownAction('delegate')).toBe(true);
    expect(isKnownAction('*')).toBe(true);
    expect(isKnownAction('tool:plaid_sync')).toBe(true);
    expect(isKnownAction('capability:exposure')).toBe(true);
    expect(isKnownAction('query:accounts')).toBe(true);
    expect(isKnownAction('tool:')).toBe(false);
    expect(isKnownAction('exposure_query')).toBe(false);
    expect(isKnownAction('')).toBe(false);
    expect(isKnownAction(undefined)).toBe(false);
    expect(isKnownAction(42)).toBe(false);
  });

  test('group predicates match their lists and nothing else', () => {
    expect(isTransportAction('intent_execute')).toBe(true);
    expect(isTransportAction('message')).toBe(false);
    expect(isMessageAction('message_send')).toBe(true);
    expect(isMessageAction('discover')).toBe(false);
    expect(isIntentOp('aggregate')).toBe(true);
    expect(isIntentOp('delegate')).toBe(false);
  });
});
