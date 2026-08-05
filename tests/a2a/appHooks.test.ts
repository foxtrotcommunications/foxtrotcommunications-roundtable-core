// tests/a2a/appHooks.test.ts — application hook boundary
//
// The financial provenance extractor and advisor-language labels moved to
// @pendragon/tools-plaid (its tests moved with it). What core owns now is the
// boundary itself: registered hooks win, generic fallbacks hold without them,
// and a missing extractor is LOUD when the turn carried provenance signal —
// a silent blank provenance footer is how a plugin-less image would otherwise
// ship unnoticed (do-not-regress).

import {
  describeActivity,
  extractProvenance,
  registerActivityDescriptor,
  registerProvenanceExtractor,
  _resetAppHooks,
} from '../../server/a2a/appHooks';

afterEach(() => {
  _resetAppHooks();
  jest.restoreAllMocks();
});

describe('describeActivity', () => {
  it('labels core tools generically without a registered descriptor', () => {
    expect(describeActivity('render_chart', {})).toEqual({ step: 'chart', label: 'Generating chart' });
    expect(describeActivity('query_bigquery', {})).toEqual({ step: 'querying', label: 'Querying data warehouse' });
  });

  it('labels bridge tools with a generic "Consulting" fallback', () => {
    expect(describeActivity('intent_bridge', { targetWorkspace: 'Ops' }))
      .toEqual({ step: 'Ops', label: 'Consulting Ops' });
    expect(describeActivity('bridge_workspace', { target: 'Research' }))
      .toEqual({ step: 'Research', label: 'Consulting Research' });
  });

  it('humanizes unknown tool names', () => {
    expect(describeActivity('sync_plaid_data', {}))
      .toEqual({ step: 'sync_plaid_data', label: 'Sync Plaid Data' });
  });

  it('prefers a registered descriptor, falling back when it returns null', () => {
    registerActivityDescriptor((toolName) =>
      toolName === 'get_balance' ? { step: 'balances', label: 'Checking balances' } : null,
    );
    expect(describeActivity('get_balance', {})).toEqual({ step: 'balances', label: 'Checking balances' });
    // Descriptor declined — core fallback still applies
    expect(describeActivity('render_chart', {})).toEqual({ step: 'chart', label: 'Generating chart' });
  });
});

describe('extractProvenance', () => {
  it('delegates to the registered extractor', () => {
    const artifact = { domains: [], confidence_pct: 42 };
    registerProvenanceExtractor(() => artifact);
    expect(extractProvenance([{ name: 'intent_bridge', result: {} }])).toBe(artifact);
  });

  it('returns null with no extractor and no provenance signal, silently', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(extractProvenance([{ name: 'calculator', result: {} }])).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns LOUDLY (once) when provenance signal exists but no extractor is registered', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(extractProvenance([{ name: 'intent_bridge', result: { success: true } }])).toBeNull();
    expect(extractProvenance([{ name: 'emit_provenance', result: {} }])).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/No provenance extractor registered/);
  });

  it('treats declare_missing_data as provenance signal', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    extractProvenance([{ name: 'declare_missing_data', result: { domains: ['Retirement'] } }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
