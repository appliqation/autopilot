import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetchAppqToolDefs, mockCreateGatedAppqDispatcher, mockRunLoop } = vi.hoisted(() => ({
  mockFetchAppqToolDefs: vi.fn(),
  mockCreateGatedAppqDispatcher: vi.fn(),
  mockRunLoop: vi.fn(),
}));
vi.mock('@appliqation/agent-core', async (importOriginal) => {
  // createReadOnlyProjectContextDispatcher/PROJECT_CONTEXT_TOOL come through
  // as the real implementation — this suite verifies actual gating behavior
  // (write blocked, read passed through), not just that it was called.
  const actual = await importOriginal<typeof import('@appliqation/agent-core')>();
  return {
    ...actual,
    runLoop: mockRunLoop,
    fetchAppqToolDefs: mockFetchAppqToolDefs,
    createGatedAppqDispatcher: mockCreateGatedAppqDispatcher,
  };
});

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
      explorerCmd: 'appliqation-explorer',
      healCmd: 'appliqation-heal-selector',
      visualCmd: 'appliqation-visual-regression',
      commandTimeoutMs: 30_000,
      allowPr: false,
      allowVisual: false,
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

  it('the default policy text reflects visual-check authorization state', async () => {
    await autopilot({ ...baseOpts(), metaTools: { ...baseOpts().metaTools, allowVisual: true } });
    const call = mockRunLoop.mock.calls[0][0];
    expect(call.system).toContain('`run_visual_check` is available for this invocation');

    mockRunLoop.mockClear();
    await autopilot({ ...baseOpts(), metaTools: { ...baseOpts().metaTools, allowVisual: false } });
    const call2 = mockRunLoop.mock.calls[0][0];
    expect(call2.system).toContain('`run_visual_check` is NOT available for this invocation');
  });

  it('the seed message includes the test case, environment, and repo path', async () => {
    await autopilot(baseOpts());
    const call = mockRunLoop.mock.calls[0][0];
    expect(call.seedMessage).toContain('2424-abc');
    expect(call.seedMessage).toContain('Stage');
    expect(call.seedMessage).toContain('/repo');
  });

  it('the seed message states the baseline environment only when given', async () => {
    await autopilot({ ...baseOpts(), baselineEnvironment: 'Prod' });
    const call = mockRunLoop.mock.calls[0][0];
    expect(call.seedMessage).toContain('Prod');

    mockRunLoop.mockClear();
    await autopilot(baseOpts());
    const call2 = mockRunLoop.mock.calls[0][0];
    expect(call2.seedMessage).not.toContain('Baseline');
  });

  it('single-TC scope: seed message tells the model to start with get_scenario', async () => {
    await autopilot(baseOpts());
    const call = mockRunLoop.mock.calls[0][0];
    expect(call.seedMessage).toContain('start with get_scenario');
  });

  describe('scenario/test-set scope', () => {
    function scenarioOpts() {
      const { testCaseUuid: _testCaseUuid, ...rest } = baseOpts();
      return { ...rest, scenarioId: 2424 };
    }
    function testSetOpts() {
      const { testCaseUuid: _testCaseUuid, ...rest } = baseOpts();
      return { ...rest, testSetId: 1358 };
    }

    it('scenario_id: seed message names the scenario and tells the model to enumerate via get_scenario', async () => {
      await autopilot(scenarioOpts());
      const call = mockRunLoop.mock.calls[0][0];
      expect(call.seedMessage).toContain('entire scenario 2424');
      expect(call.seedMessage).toContain('get_scenario');
      expect(call.seedMessage).not.toContain('Test case UUID:');
    });

    it('test_set_id: seed message names the test set and tells the model to enumerate via get_test_set', async () => {
      await autopilot(testSetOpts());
      const call = mockRunLoop.mock.calls[0][0];
      expect(call.seedMessage).toContain('entire test set 1358');
      expect(call.seedMessage).toContain('get_test_set');
    });

    it('scenario/test-set scope: seed message tells the model to lead with one scope-level run_judge call, never to loop per TC itself', async () => {
      await autopilot(scenarioOpts());
      const call = mockRunLoop.mock.calls[0][0];
      expect(call.seedMessage).toContain('SINGLE scope-level run_judge call');
      expect(call.seedMessage).toContain('never loop calling run_judge per test case');
    });

    it('scenario/test-set scope still includes environment, repo path, and an optional defect ID line', async () => {
      await autopilot({ ...scenarioOpts(), defectId: 'defect-42' });
      const call = mockRunLoop.mock.calls[0][0];
      expect(call.seedMessage).toContain('Stage');
      expect(call.seedMessage).toContain('/repo');
      expect(call.seedMessage).toContain('defect-42');
    });
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

  it('offers enrich_project_context to the model, in the same allowlist used for context tools', async () => {
    await autopilot(baseOpts());
    const allowlistArg = mockFetchAppqToolDefs.mock.calls[0][1] as Set<string>;
    expect(allowlistArg.has('enrich_project_context')).toBe(true);
  });

  it('lets an enrich_project_context action=read call reach the real gated appq dispatcher', async () => {
    const gatedInner = vi.fn().mockResolvedValue({ ok: true, text: 'project context' });
    mockCreateGatedAppqDispatcher.mockReturnValue(gatedInner);
    await autopilot(baseOpts());
    const dispatch = mockRunLoop.mock.calls[0][0].dispatch;

    const result = await dispatch('enrich_project_context', { project_id: 1349, action: 'read' });
    expect(gatedInner).toHaveBeenCalledWith('enrich_project_context', { project_id: 1349, action: 'read' });
    expect(result.text).toBe('project context');
  });

  it('blocks an enrich_project_context action=write call before it ever reaches the gated appq dispatcher', async () => {
    const gatedInner = vi.fn().mockResolvedValue({ ok: true, text: 'would have written' });
    mockCreateGatedAppqDispatcher.mockReturnValue(gatedInner);
    await autopilot(baseOpts());
    const dispatch = mockRunLoop.mock.calls[0][0].dispatch;

    const result = await dispatch('enrich_project_context', { project_id: 1349, action: 'write', knowledge: {} });
    expect(gatedInner).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/read-only/);
  });

  it('truncates an oversized enrich_project_context result rather than passing the whole thing through', async () => {
    const huge = 'x'.repeat(60_000);
    const gatedInner = vi.fn().mockResolvedValue({ ok: true, text: huge });
    mockCreateGatedAppqDispatcher.mockReturnValue(gatedInner);
    await autopilot(baseOpts());
    const dispatch = mockRunLoop.mock.calls[0][0].dispatch;

    const result = await dispatch('enrich_project_context', { project_id: 1349, action: 'read' });
    expect(result.text.length).toBeLessThan(huge.length);
    expect(result.text).toContain('[TRUNCATED: original response was 60000 characters');
  });

  it('leaves a normal-sized enrich_project_context result unchanged', async () => {
    const gatedInner = vi.fn().mockResolvedValue({ ok: true, text: 'normal-sized project context' });
    mockCreateGatedAppqDispatcher.mockReturnValue(gatedInner);
    await autopilot(baseOpts());
    const dispatch = mockRunLoop.mock.calls[0][0].dispatch;

    const result = await dispatch('enrich_project_context', { project_id: 1349, action: 'read' });
    expect(result.text).toBe('normal-sized project context');
  });

  it('never truncates a large result from any other tool, only enrich_project_context', async () => {
    const huge = 'x'.repeat(60_000);
    const gatedInner = vi.fn().mockResolvedValue({ ok: true, text: huge });
    mockCreateGatedAppqDispatcher.mockReturnValue(gatedInner);
    await autopilot(baseOpts());
    const dispatch = mockRunLoop.mock.calls[0][0].dispatch;

    const result = await dispatch('get_scenario', { scenario_id: 2424 });
    expect(result.text).toBe(huge);
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
