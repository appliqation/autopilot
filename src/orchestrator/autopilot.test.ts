import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetchAppqToolDefs, mockCreateGatedAppqDispatcher, mockRunLoop } = vi.hoisted(() => ({
  mockFetchAppqToolDefs: vi.fn(),
  mockCreateGatedAppqDispatcher: vi.fn(),
  mockRunLoop: vi.fn(),
}));
vi.mock('@appliqation/agent-core', () => ({
  runLoop: mockRunLoop,
  fetchAppqToolDefs: mockFetchAppqToolDefs,
  createGatedAppqDispatcher: mockCreateGatedAppqDispatcher,
}));

const { mockMetaDispatch, mockMetaToolDefs } = vi.hoisted(() => ({
  mockMetaDispatch: vi.fn(),
  mockMetaToolDefs: vi.fn(),
}));
vi.mock('../tools/metaTools.js', () => ({
  createMetaToolDispatch: () => mockMetaDispatch,
  metaToolDefs: mockMetaToolDefs,
}));

import { autopilot } from './autopilot.js';
import type { McpClient, ProviderAdapter, RunBudget } from '@appliqation/agent-core';

function fakeClient(): McpClient {
  return {
    fetchPrompt: vi.fn(),
    startWorkflow: vi.fn(),
    callTool: vi.fn(),
    listTools: vi.fn(),
    uploadScreenshot: vi.fn(),
  };
}

const budget: RunBudget = { maxCalls: 40, maxPages: 999_999, maxMillis: 900_000, maxTurns: 30 };

function baseOpts() {
  return {
    client: fakeClient(),
    adapter: { complete: vi.fn() } as ProviderAdapter,
    testCaseUuid: '2424-abc',
    environment: 'Stage',
    repoPath: '/repo',
    budget,
    metaTools: {
      autotestCmd: 'appliqation-autotest',
      scriptgenCmd: 'appliqation-scriptgen',
      prRaiseCmd: 'appliqation-pr-raise',
      defectFixCmd: 'appliqation-defect-fix',
      commandTimeoutMs: 30_000,
      allowPr: false,
    },
  };
}

describe('autopilot', () => {
  beforeEach(() => {
    mockFetchAppqToolDefs.mockReset().mockResolvedValue([{ name: 'get_scenario', description: 'x', inputSchema: {} }]);
    mockCreateGatedAppqDispatcher.mockReset().mockReturnValue(vi.fn().mockResolvedValue({ ok: true, text: 'appq result' }));
    mockRunLoop.mockReset().mockResolvedValue({ report: 'done', turns: 3, budgetExceeded: false });
    mockMetaDispatch.mockReset().mockResolvedValue({ ok: true, text: 'meta result' });
    mockMetaToolDefs.mockReset().mockReturnValue([{ name: 'run_judge', description: 'x', inputSchema: {} }]);
  });

  it('offers both the read-only appq tool defs and the meta-tool defs to the model', async () => {
    await autopilot(baseOpts());
    const call = mockRunLoop.mock.calls[0][0];
    const toolNames = call.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(['get_scenario', 'run_judge']));
  });

  it('uses the bundled default policy when no override is given', async () => {
    await autopilot(baseOpts());
    const call = mockRunLoop.mock.calls[0][0];
    expect(call.system).toContain('autonomous quality engineering lead');
  });

  it('uses a custom systemPromptOverride when given, ignoring the bundled default entirely', async () => {
    await autopilot({ ...baseOpts(), systemPromptOverride: 'MY CUSTOM POLICY TEXT' });
    const call = mockRunLoop.mock.calls[0][0];
    expect(call.system).toBe('MY CUSTOM POLICY TEXT');
  });

  it('the default policy text reflects PR authorization state', async () => {
    await autopilot({ ...baseOpts(), metaTools: { ...baseOpts().metaTools, allowPr: true } });
    const call = mockRunLoop.mock.calls[0][0];
    expect(call.system).toContain('is available for this invocation');

    mockRunLoop.mockClear();
    await autopilot({ ...baseOpts(), metaTools: { ...baseOpts().metaTools, allowPr: false } });
    const call2 = mockRunLoop.mock.calls[0][0];
    expect(call2.system).toContain('is NOT available for this invocation');
  });

  it('the seed message includes the test case, environment, and repo path', async () => {
    await autopilot(baseOpts());
    const call = mockRunLoop.mock.calls[0][0];
    expect(call.seedMessage).toContain('2424-abc');
    expect(call.seedMessage).toContain('Stage');
    expect(call.seedMessage).toContain('/repo');
  });

  it('routes meta-tool-named dispatches to the meta dispatch, everything else to the gated appq dispatcher', async () => {
    await autopilot(baseOpts());
    const dispatch = mockRunLoop.mock.calls[0][0].dispatch;

    await dispatch('run_judge', { test_case_uuid: '2424-abc', environment: 'Stage' });
    expect(mockMetaDispatch).toHaveBeenCalledWith('run_judge', { test_case_uuid: '2424-abc', environment: 'Stage' });

    const gatedFn = mockCreateGatedAppqDispatcher.mock.results[0].value;
    await dispatch('get_scenario', { scenario_id: 2424 });
    expect(gatedFn).toHaveBeenCalledWith('get_scenario', { scenario_id: 2424 });
  });

  it('passes the given budget through unchanged', async () => {
    const customBudget: RunBudget = { maxCalls: 5, maxPages: 999_999, maxMillis: 1000, maxTurns: 2 };
    await autopilot({ ...baseOpts(), budget: customBudget });
    expect(mockRunLoop.mock.calls[0][0].budget).toEqual(customBudget);
  });

  it('returns the loop result unchanged', async () => {
    mockRunLoop.mockResolvedValue({ report: 'my report', turns: 7, budgetExceeded: true });
    const result = await autopilot(baseOpts());
    expect(result).toEqual({ report: 'my report', turns: 7, budgetExceeded: true });
  });
});
