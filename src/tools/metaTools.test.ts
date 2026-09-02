import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

const { parseCommand, metaToolDefs, createMetaToolDispatch } = await import('./metaTools.js');

function mockSuccess(stdout: string, stderr = '') {
  mockExecFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
    process.nextTick(() => cb(null, stdout, stderr));
  });
}

function mockFailure(code: number, stdout: string, stderr = '') {
  mockExecFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
    const err = Object.assign(new Error('Command failed'), { code });
    process.nextTick(() => cb(err, stdout, stderr));
  });
}

const baseCfg = {
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
};

describe('parseCommand', () => {
  it('splits a single-word command with no args', () => {
    expect(parseCommand('appliqation-autotest')).toEqual(['appliqation-autotest', []]);
  });

  it('splits a multi-word command (e.g. a local dev override) into command + baseArgs', () => {
    expect(parseCommand('node /path/to/dist/cli/index.js')).toEqual(['node', ['/path/to/dist/cli/index.js']]);
  });

  it('collapses extra whitespace between words', () => {
    expect(parseCommand('node   /path/to/cli.js  ')).toEqual(['node', ['/path/to/cli.js']]);
  });

  it('throws for an empty command string', () => {
    expect(() => parseCommand('   ')).toThrow(/Empty command string/);
  });
});

describe('metaToolDefs', () => {
  it('always offers run_judge, run_generate, run_defect_fix, run_heal, and run_explore', () => {
    const names = metaToolDefs(baseCfg).map((t) => t.name);
    expect(names).toContain('run_judge');
    expect(names).toContain('run_generate');
    expect(names).toContain('run_defect_fix');
    expect(names).toContain('run_heal');
    expect(names).toContain('run_explore');
  });

  it('run_judge only requires environment — test_case_uuid/scenario_id/test_set_id are each optional (mutual exclusion enforced at dispatch)', () => {
    const def = metaToolDefs(baseCfg).find((t) => t.name === 'run_judge')!;
    expect((def.inputSchema as { required: string[] }).required).toEqual(['environment']);
  });

  it('run_heal requires test_case_uuid/script_path/failure/environment/repo_path', () => {
    const def = metaToolDefs(baseCfg).find((t) => t.name === 'run_heal')!;
    expect((def.inputSchema as { required: string[] }).required).toEqual([
      'test_case_uuid',
      'script_path',
      'failure',
      'environment',
      'repo_path',
    ]);
  });

  it('run_defect_fix is offered regardless of allowPr — it never touches git/GitHub', () => {
    expect(metaToolDefs({ ...baseCfg, allowPr: false }).map((t) => t.name)).toContain('run_defect_fix');
    expect(metaToolDefs({ ...baseCfg, allowPr: true }).map((t) => t.name)).toContain('run_defect_fix');
  });

  it('run_explore is offered regardless of allowPr — it never touches git/GitHub either', () => {
    expect(metaToolDefs({ ...baseCfg, allowPr: false }).map((t) => t.name)).toContain('run_explore');
    expect(metaToolDefs({ ...baseCfg, allowPr: true }).map((t) => t.name)).toContain('run_explore');
  });

  it('run_explore requires prompt in its schema, with no dry_run param at all', () => {
    const def = metaToolDefs(baseCfg).find((t) => t.name === 'run_explore')!;
    expect((def.inputSchema as { required: string[] }).required).toEqual(['prompt']);
    expect((def.inputSchema as { properties: Record<string, unknown> }).properties).not.toHaveProperty('dry_run');
  });

  it('run_defect_fix requires test_instruction in its schema', () => {
    const def = metaToolDefs(baseCfg).find((t) => t.name === 'run_defect_fix')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('test_instruction');
  });

  it('excludes run_pr_raise entirely when allowPr is false — not offered, not just soft-blocked', () => {
    const names = metaToolDefs({ ...baseCfg, allowPr: false }).map((t) => t.name);
    expect(names).not.toContain('run_pr_raise');
  });

  it('includes run_pr_raise when allowPr is true', () => {
    const names = metaToolDefs({ ...baseCfg, allowPr: true }).map((t) => t.name);
    expect(names).toContain('run_pr_raise');
  });

  it('excludes run_visual_check entirely when allowVisual is false, not offered, not just soft-blocked', () => {
    const names = metaToolDefs({ ...baseCfg, allowVisual: false }).map((t) => t.name);
    expect(names).not.toContain('run_visual_check');
  });

  it('includes run_visual_check when allowVisual is true, with its full required schema', () => {
    const def = metaToolDefs({ ...baseCfg, allowVisual: true }).find((t) => t.name === 'run_visual_check')!;
    expect(def).toBeDefined();
    expect((def.inputSchema as { required: string[] }).required).toEqual([
      'test_case_uuid',
      'route',
      'baseline_environment',
      'target_environment',
    ]);
  });
});

describe('createMetaToolDispatch', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  describe('run_judge', () => {
    it('spawns the configured autotest command with judge + args + --json', async () => {
      mockSuccess('{"testCaseUuid":"tc-1","results":[{"status":"passed"}]}');
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('run_judge', { test_case_uuid: 'tc-1', environment: 'Stage' });

      expect(mockExecFile).toHaveBeenCalledWith(
        'appliqation-autotest',
        ['judge', '--environment', 'Stage', '--test-case-uuid', 'tc-1', '--json'],
        expect.anything(),
        expect.any(Function),
      );
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.text)).toMatchObject({ testCaseUuid: 'tc-1' });
    });

    it('adds --dry-run when dry_run is true', async () => {
      mockSuccess('{}');
      const dispatch = createMetaToolDispatch(baseCfg);
      await dispatch('run_judge', { test_case_uuid: 'tc-1', environment: 'Stage', dry_run: true });
      expect(mockExecFile).toHaveBeenCalledWith(
        'appliqation-autotest',
        ['judge', '--environment', 'Stage', '--test-case-uuid', 'tc-1', '--dry-run', '--json'],
        expect.anything(),
        expect.any(Function),
      );
    });

    it('recovers the real --json summary from stdout even when the CLI exits non-zero (a real failed/blocked verdict)', async () => {
      mockFailure(1, '{"testCaseUuid":"tc-1","results":[{"status":"failed"}]}');
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('run_judge', { test_case_uuid: 'tc-1', environment: 'Stage' });
      expect(result.ok).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({ testCaseUuid: 'tc-1' });
    });

    it('falls back to a plain error message when the CLI failed with no stdout at all (e.g. crashed before printing)', async () => {
      mockFailure(1, '', 'ENOENT: command not found');
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('run_judge', { test_case_uuid: 'tc-1', environment: 'Stage' });
      expect(result.ok).toBe(false);
      expect(result.text).toContain('ENOENT');
    });

    it('respects a multi-word command override (local dev build path)', async () => {
      mockSuccess('{}');
      const dispatch = createMetaToolDispatch({ ...baseCfg, autotestCmd: 'node /dev/autotest/dist/cli/index.js' });
      await dispatch('run_judge', { test_case_uuid: 'tc-1', environment: 'Stage' });
      expect(mockExecFile).toHaveBeenCalledWith(
        'node',
        ['/dev/autotest/dist/cli/index.js', 'judge', '--environment', 'Stage', '--test-case-uuid', 'tc-1', '--json'],
        expect.anything(),
        expect.any(Function),
      );
    });

    it('scenario_id scope: passes --scenario-id instead of --test-case-uuid', async () => {
      mockSuccess('{}');
      const dispatch = createMetaToolDispatch(baseCfg);
      await dispatch('run_judge', { scenario_id: 2424, environment: 'Stage' });
      expect(mockExecFile).toHaveBeenCalledWith(
        'appliqation-autotest',
        ['judge', '--environment', 'Stage', '--scenario-id', '2424', '--json'],
        expect.anything(),
        expect.any(Function),
      );
    });

    it('test_set_id scope: passes --test-set-id instead of --test-case-uuid', async () => {
      mockSuccess('{}');
      const dispatch = createMetaToolDispatch(baseCfg);
      await dispatch('run_judge', { test_set_id: 1358, environment: 'Stage' });
      expect(mockExecFile).toHaveBeenCalledWith(
        'appliqation-autotest',
        ['judge', '--environment', 'Stage', '--test-set-id', '1358', '--json'],
        expect.anything(),
        expect.any(Function),
      );
    });

    it('passes --coverage through only when given, for scenario/test-set scope', async () => {
      mockSuccess('{}');
      const dispatch = createMetaToolDispatch(baseCfg);
      await dispatch('run_judge', { scenario_id: 2424, environment: 'Stage', coverage: 'on-failure-or-absence' });
      expect(mockExecFile).toHaveBeenCalledWith(
        'appliqation-autotest',
        ['judge', '--environment', 'Stage', '--scenario-id', '2424', '--coverage', 'on-failure-or-absence', '--json'],
        expect.anything(),
        expect.any(Function),
      );
    });

    it('refuses with a clear error, without ever spawning a process, when zero scope args are given', async () => {
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('run_judge', { environment: 'Stage' });
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/exactly one of test_case_uuid, scenario_id, or test_set_id/);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('refuses with a clear error, without ever spawning a process, when more than one scope arg is given', async () => {
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('run_judge', { test_case_uuid: 'tc-1', scenario_id: 2424, environment: 'Stage' });
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/exactly one of test_case_uuid, scenario_id, or test_set_id/);
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe('run_heal', () => {
    it('spawns the configured heal command with heal + args + --json', async () => {
      mockSuccess('{"testCaseUuid":"tc-1","declined":false,"testRan":true,"verified":true}');
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('run_heal', {
        test_case_uuid: 'tc-1',
        script_path: 'tests/spec.ts',
        failure: 'Locator #old-id not found',
        environment: 'Stage',
        repo_path: '/repo',
      });

      expect(mockExecFile).toHaveBeenCalledWith(
        'appliqation-heal-selector',
        [
          'heal',
          '--test-case-uuid',
          'tc-1',
          '--script-path',
          'tests/spec.ts',
          '--failure',
          'Locator #old-id not found',
          '--environment',
          'Stage',
          '--repo-path',
          '/repo',
          '--json',
        ],
        expect.anything(),
        expect.any(Function),
      );
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.text)).toMatchObject({ declined: false, verified: true });
    });

    it('includes --defect-id only when given', async () => {
      mockSuccess('{}');
      const dispatch = createMetaToolDispatch(baseCfg);
      await dispatch('run_heal', {
        test_case_uuid: 'tc-1',
        script_path: 'tests/spec.ts',
        failure: 'x',
        environment: 'Stage',
        repo_path: '/repo',
        defect_id: 'defect-42',
      });
      const callArgs = mockExecFile.mock.calls[0][1] as string[];
      expect(callArgs).toContain('--defect-id');
      expect(callArgs).toContain('defect-42');
    });

    it('recovers the real --json summary from stdout even when the CLI exits non-zero (a decline or unverified attempt)', async () => {
      mockFailure(1, '{"testCaseUuid":"tc-1","declined":true,"testRan":false,"verified":false}');
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('run_heal', {
        test_case_uuid: 'tc-1',
        script_path: 'tests/spec.ts',
        failure: 'x',
        environment: 'Stage',
        repo_path: '/repo',
      });
      expect(result.ok).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({ declined: true });
    });
  });

  describe('run_generate', () => {
    it('spawns the configured scriptgen command with generate + args + --json', async () => {
      mockSuccess('{"testCaseUuid":"tc-1","verified":true}');
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('run_generate', { test_case_uuid: 'tc-1', repo_path: '/repo' });

      expect(mockExecFile).toHaveBeenCalledWith(
        'appliqation-scriptgen',
        ['generate', '--test-case-uuid', 'tc-1', '--repo-path', '/repo', '--json'],
        expect.anything(),
        expect.any(Function),
      );
      expect(result.ok).toBe(true);
    });

    it('includes --environment only when given', async () => {
      mockSuccess('{}');
      const dispatch = createMetaToolDispatch(baseCfg);
      await dispatch('run_generate', { test_case_uuid: 'tc-1', repo_path: '/repo', environment: 'Stage' });
      expect(mockExecFile).toHaveBeenCalledWith(
        'appliqation-scriptgen',
        ['generate', '--test-case-uuid', 'tc-1', '--repo-path', '/repo', '--environment', 'Stage', '--json'],
        expect.anything(),
        expect.any(Function),
      );
    });
  });

  describe('run_defect_fix', () => {
    it('spawns the configured defect-fix command with fix + args + --json', async () => {
      mockSuccess('{"defectId":"d-1","verified":true}');
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('run_defect_fix', {
        defect_id: 'd-1',
        repo_path: '/repo',
        test_instruction: 'Also re-run the whole scenario.',
      });

      expect(mockExecFile).toHaveBeenCalledWith(
        'appliqation-defect-fix',
        ['fix', '--defect-id', 'd-1', '--repo-path', '/repo', '--test-instruction', 'Also re-run the whole scenario.', '--json'],
        expect.anything(),
        expect.any(Function),
      );
      expect(result.ok).toBe(true);
    });

    it('adds --dry-run when dry_run is true', async () => {
      mockSuccess('{}');
      const dispatch = createMetaToolDispatch(baseCfg);
      await dispatch('run_defect_fix', { defect_id: 'd-1', repo_path: '/repo', test_instruction: 'x', dry_run: true });
      const callArgs = mockExecFile.mock.calls[0][1] as string[];
      expect(callArgs).toContain('--dry-run');
    });

    it('recovers the real --json summary from stdout even when the CLI exits non-zero (an unverified fix)', async () => {
      mockFailure(1, '{"defectId":"d-1","verified":false}');
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('run_defect_fix', { defect_id: 'd-1', repo_path: '/repo', test_instruction: 'x' });
      expect(result.ok).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({ defectId: 'd-1', verified: false });
    });
  });

  describe('run_explore', () => {
    it('spawns the configured explorer command with explore + args + --json', async () => {
      mockSuccess('{"turns":5,"budgetExceeded":false}');
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('run_explore', { prompt: 'Explore the signup flow.' });

      expect(mockExecFile).toHaveBeenCalledWith(
        'appliqation-explorer',
        ['explore', '--prompt', 'Explore the signup flow.', '--json'],
        expect.anything(),
        expect.any(Function),
      );
      expect(result.ok).toBe(true);
    });

    it('includes --project-id/--site-url only when given', async () => {
      mockSuccess('{}');
      const dispatch = createMetaToolDispatch(baseCfg);
      await dispatch('run_explore', { prompt: 'Explore the signup flow.', project_id: 1349, site_url: 'https://stage.example.com' });
      expect(mockExecFile).toHaveBeenCalledWith(
        'appliqation-explorer',
        [
          'explore',
          '--prompt',
          'Explore the signup flow.',
          '--project-id',
          '1349',
          '--site-url',
          'https://stage.example.com',
          '--json',
        ],
        expect.anything(),
        expect.any(Function),
      );
    });

    it('recovers the real --json summary from stdout even when the CLI exits non-zero (budget exceeded)', async () => {
      mockFailure(1, '{"turns":80,"budgetExceeded":true}');
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('run_explore', { prompt: 'Explore the signup flow.' });
      expect(result.ok).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({ budgetExceeded: true });
    });
  });

  describe('run_pr_raise', () => {
    it('is refused with a clear message when allowPr is false, without ever spawning a process', async () => {
      const dispatch = createMetaToolDispatch({ ...baseCfg, allowPr: false });
      const result = await dispatch('run_pr_raise', { project_id: 1, repo_path: '/repo', branch_name: 'x', pr_title: 'y' });
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/not authorized/);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('spawns the configured pr-raise command with raise + args + --json when authorized', async () => {
      mockSuccess('{"committed":true,"pr":{"url":"https://github.com/acme/widgets/pull/1"}}');
      const dispatch = createMetaToolDispatch({ ...baseCfg, allowPr: true });
      const result = await dispatch('run_pr_raise', {
        project_id: 1349,
        repo_path: '/repo',
        branch_name: 'automan/run-1',
        pr_title: 'Add spec',
        pr_body: 'body text',
      });

      expect(mockExecFile).toHaveBeenCalledWith(
        'appliqation-pr-raise',
        [
          'raise',
          '--project-id',
          '1349',
          '--repo-path',
          '/repo',
          '--branch-name',
          'automan/run-1',
          '--pr-title',
          'Add spec',
          '--pr-body',
          'body text',
          '--json',
        ],
        expect.anything(),
        expect.any(Function),
      );
      expect(result.ok).toBe(true);
    });

    it('omits --pr-body when not given', async () => {
      mockSuccess('{}');
      const dispatch = createMetaToolDispatch({ ...baseCfg, allowPr: true });
      await dispatch('run_pr_raise', { project_id: 1, repo_path: '/repo', branch_name: 'x', pr_title: 'y' });
      const callArgs = mockExecFile.mock.calls[0][1] as string[];
      expect(callArgs).not.toContain('--pr-body');
    });
  });

  describe('run_visual_check', () => {
    it('is refused with a clear message when allowVisual is false, without ever spawning a process', async () => {
      const dispatch = createMetaToolDispatch({ ...baseCfg, allowVisual: false });
      const result = await dispatch('run_visual_check', {
        test_case_uuid: 'tc-1',
        route: '/subscribe',
        baseline_environment: 'Prod',
        target_environment: 'Stage',
      });
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/not authorized/);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('spawns the configured visual-regression command with check + args + --json when authorized', async () => {
      mockSuccess('{"verdict":"regression","diffPercentage":0.33,"primaryFinding":"button missing"}');
      const dispatch = createMetaToolDispatch({ ...baseCfg, allowVisual: true });
      const result = await dispatch('run_visual_check', {
        test_case_uuid: 'tc-1',
        route: '/subscribe',
        baseline_environment: 'Prod',
        target_environment: 'Stage',
      });

      expect(mockExecFile).toHaveBeenCalledWith(
        'appliqation-visual-regression',
        [
          'check',
          '--test-case-uuid',
          'tc-1',
          '--route',
          '/subscribe',
          '--baseline-environment',
          'Prod',
          '--target-environment',
          'Stage',
          '--json',
        ],
        expect.anything(),
        expect.any(Function),
      );
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.text)).toMatchObject({ verdict: 'regression' });
    });

    it('passes one --mask per entry in a multi-value mask array', async () => {
      mockSuccess('{}');
      const dispatch = createMetaToolDispatch({ ...baseCfg, allowVisual: true });
      await dispatch('run_visual_check', {
        test_case_uuid: 'tc-1',
        route: '/subscribe',
        baseline_environment: 'Prod',
        target_environment: 'Stage',
        mask: ['.reader-count', '[data-testid=timestamp]'],
      });
      const callArgs = mockExecFile.mock.calls[0][1] as string[];
      expect(callArgs.filter((a) => a === '--mask')).toHaveLength(2);
      expect(callArgs).toContain('.reader-count');
      expect(callArgs).toContain('[data-testid=timestamp]');
    });

    it('includes --storage-state only when given', async () => {
      mockSuccess('{}');
      const dispatch = createMetaToolDispatch({ ...baseCfg, allowVisual: true });
      await dispatch('run_visual_check', {
        test_case_uuid: 'tc-1',
        route: '/subscribe',
        baseline_environment: 'Prod',
        target_environment: 'Stage',
        storage_state: '/tmp/auth.json',
      });
      const callArgs = mockExecFile.mock.calls[0][1] as string[];
      expect(callArgs).toContain('--storage-state');
      expect(callArgs).toContain('/tmp/auth.json');
    });

    it('recovers the real --json summary from stdout even when the CLI exits non-zero (a regression or inconclusive verdict)', async () => {
      mockFailure(1, '{"verdict":"regression","diffPercentage":0.33}');
      const dispatch = createMetaToolDispatch({ ...baseCfg, allowVisual: true });
      const result = await dispatch('run_visual_check', {
        test_case_uuid: 'tc-1',
        route: '/subscribe',
        baseline_environment: 'Prod',
        target_environment: 'Stage',
      });
      expect(result.ok).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({ verdict: 'regression' });
    });
  });

  describe('unknown tool', () => {
    it('returns an explicit error', async () => {
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('delete_everything', {});
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/Unknown meta tool/);
    });
  });
});
