import { describe, it, expect, vi } from 'vitest';
import { recordAutopilotRun } from './audit.js';
import type { AuditSink } from '@appliqation/agent-core';

const usage = { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 0 };

describe('recordAutopilotRun', () => {
  it('records one call with agent/subcommand and the outcome including allowPr', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined) };
    await recordAutopilotRun({
      sink,
      startedAt: 1000,
      endedAt: 3000,
      model: 'claude-sonnet-5',
      usage,
      testCaseUuid: '2424-abc',
      environment: 'Stage',
      repoPath: '/repo',
      allowPr: true,
      result: { report: 'done', turns: 7, budgetExceeded: false },
    });

    expect(sink.record).toHaveBeenCalledTimes(1);
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record).toMatchObject({ agent: 'appliqation-autopilot', subcommand: 'run', startedAt: 1000, endedAt: 3000, durationMillis: 2000, model: 'claude-sonnet-5', usage, turns: 7, budgetExceeded: false, exitCode: 0 });
    expect(record.outcome).toEqual({ testCaseUuid: '2424-abc', environment: 'Stage', repoPath: '/repo', allowPr: true, turns: 7, budgetExceeded: false, report: 'done' });
  });

  it('records exitCode 1 and an error outcome when result is undefined — autopilot() threw', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined) };
    await recordAutopilotRun({ sink, startedAt: 0, endedAt: 1, model: 'x', usage, testCaseUuid: 'tc-1', environment: 'Stage', repoPath: '/repo', allowPr: false, result: undefined });
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record.exitCode).toBe(1);
    expect(record.outcome).toEqual({ testCaseUuid: 'tc-1', environment: 'Stage', repoPath: '/repo', allowPr: false, error: true });
  });

  it('a sink failure never rejects — safeRecord swallows it', async () => {
    const sink: AuditSink = { record: vi.fn().mockRejectedValue(new Error('down')) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      recordAutopilotRun({
        sink,
        startedAt: 0,
        endedAt: 1,
        model: 'x',
        usage,
        testCaseUuid: 'tc-1',
        environment: 'Stage',
        repoPath: '/repo',
        allowPr: false,
        result: { report: 'r', turns: 1, budgetExceeded: false },
      }),
    ).resolves.toBeUndefined();
  });
});
