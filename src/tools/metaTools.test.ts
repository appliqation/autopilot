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
  commandTimeoutMs: 30_000,
  allowPr: false,
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
  it('always offers run_judge, run_generate, run_defect_fix, and run_explore', () => {
    const names = metaToolDefs(baseCfg).map((t) => t.name);
    expect(names).toContain('run_judge');
    expect(names).toContain('run_generate');
    expect(names).toContain('run_defect_fix');
    expect(names).toContain('run_explore');
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
        ['judge', '--test-case-uuid', 'tc-1', '--environment', 'Stage', '--json'],
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
        ['judge', '--test-case-uuid', 'tc-1', '--environment', 'Stage', '--dry-run', '--json'],
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
        ['/dev/autotest/dist/cli/index.js', 'judge', '--test-case-uuid', 'tc-1', '--environment', 'Stage', '--json'],
        expect.anything(),
        expect.any(Function),
      );
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

  describe('unknown tool', () => {
    it('returns an explicit error', async () => {
      const dispatch = createMetaToolDispatch(baseCfg);
      const result = await dispatch('delete_everything', {});
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/Unknown meta tool/);
    });
  });
});
