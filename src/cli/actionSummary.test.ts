import { describe, it, expect } from 'vitest';
import { ActionSummaryCollector, META_TOOL_NAMES } from './actionSummary.js';

function toolEvent(name: string, args: Record<string, unknown>, result: string) {
  return { type: 'tool', detail: { name, args, result } };
}

describe('ActionSummaryCollector', () => {
  it('ignores non-tool events entirely', () => {
    const c = new ActionSummaryCollector();
    c.observe({ type: 'assistant', detail: 'thinking...' });
    c.observe({ type: 'usage', detail: { inputTokens: 1, outputTokens: 1 } });
    c.observe({ type: 'log', detail: 'budget cap reached' });
    expect(c.build()).toEqual({ actions: [], scopeResults: undefined });
  });

  it('ignores tool events for regular appq context tools, not just meta-tools', () => {
    const c = new ActionSummaryCollector();
    c.observe(toolEvent('get_scenario', { scenario_id: 1350 }, 'Scenario: Home...'));
    c.observe(toolEvent('enrich_project_context', {}, '{"context":{}}'));
    expect(c.build().actions).toEqual([]);
  });

  it('captures a run_judge call and extracts scopeResults from its results array', () => {
    const c = new ActionSummaryCollector();
    const runJudgeResult = {
      runId: 'run_abc',
      testSetId: 1358,
      dryRun: false,
      results: [
        { testCaseUuid: '1350-aaa', path: 'canonical script', status: 'pass' },
        { testCaseUuid: '1540-bbb', path: 'agentic', status: 'pass' },
      ],
    };
    c.observe(toolEvent('run_judge', { test_set_id: 1358 }, JSON.stringify(runJudgeResult)));

    const built = c.build();
    expect(built.actions).toHaveLength(1);
    expect(built.actions[0]).toEqual({ tool: 'run_judge', args: { test_set_id: 1358 }, ok: true, result: runJudgeResult });
    expect(built.scopeResults).toEqual(runJudgeResult.results);
  });

  it('captures a mix of meta-tool events, in call order, without cross-contaminating scopeResults', () => {
    const c = new ActionSummaryCollector();
    c.observe(toolEvent('run_judge', { test_set_id: 1358 }, JSON.stringify({ results: [{ testCaseUuid: 'tc-1', path: 'canonical script', status: 'pass' }] })));
    c.observe(
      toolEvent(
        'run_generate',
        { test_case_uuid: '1540-8d01d9a5' },
        JSON.stringify({ testCaseUuid: '1540-8d01d9a5', writtenPaths: ['tests/automan/x.spec.js'], testRan: true, verified: false }),
      ),
    );

    const built = c.build();
    expect(built.actions.map((a) => a.tool)).toEqual(['run_judge', 'run_generate']);
    expect(built.actions[1].ok).toBe(true);
    expect((built.actions[1].result as { verified: boolean }).verified).toBe(false);
    // Only run_judge populates scopeResults — a later run_generate call must not touch it.
    expect(built.scopeResults).toEqual([{ testCaseUuid: 'tc-1', path: 'canonical script', status: 'pass' }]);
  });

  it('a malformed/unparseable result produces ok:false with rawText, not a thrown exception', () => {
    const c = new ActionSummaryCollector();
    expect(() =>
      c.observe(toolEvent('run_generate', { test_case_uuid: '1540-8d01d9a5' }, 'No environment named "https://dailypulse.appliqation.net" on project 1349.')),
    ).not.toThrow();

    const built = c.build();
    expect(built.actions).toEqual([
      { tool: 'run_generate', args: { test_case_uuid: '1540-8d01d9a5' }, ok: false, rawText: 'No environment named "https://dailypulse.appliqation.net" on project 1349.' },
    ]);
  });

  it('a run_judge call whose parsed JSON has no results array leaves scopeResults undefined rather than throwing', () => {
    const c = new ActionSummaryCollector();
    c.observe(toolEvent('run_judge', {}, JSON.stringify({ error: 'run_judge needs exactly one of test_case_uuid, scenario_id, or test_set_id' })));
    expect(c.build().scopeResults).toBeUndefined();
    expect(c.build().actions[0].ok).toBe(true);
  });

  it('META_TOOL_NAMES covers exactly the seven real meta-tools', () => {
    expect([...META_TOOL_NAMES].sort()).toEqual(
      ['run_defect_fix', 'run_explore', 'run_generate', 'run_heal', 'run_judge', 'run_pr_raise', 'run_visual_check'].sort(),
    );
  });
});
