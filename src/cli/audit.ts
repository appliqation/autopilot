// Extracted out of cli/index.ts so this is testable without triggering that
// file's top-level program.parseAsync(process.argv) side effect — same
// reasoning as appliqation-autotest's cli/resolvers.ts.

import { safeRecord, safeClose, type AuditSink, type AuditRecord } from '@appliqation/agent-core';
import type { LoopResult } from '@appliqation/agent-core';

export interface RecordAutopilotRunArgs {
  sink: AuditSink;
  startedAt: number;
  endedAt: number;
  model: string;
  usage: AuditRecord['usage'];
  testCaseUuid: string;
  environment: string;
  repoPath: string;
  defectId?: string;
  allowPr: boolean;
  /** undefined means autopilot() threw — the run never produced a result. */
  result: LoopResult | undefined;
}

export async function recordAutopilotRun(args: RecordAutopilotRunArgs): Promise<void> {
  const { sink, startedAt, endedAt, model, usage, testCaseUuid, environment, repoPath, defectId, allowPr, result } = args;
  await safeRecord(sink, {
    agent: 'appliqation-autopilot',
    subcommand: 'run',
    startedAt,
    endedAt,
    durationMillis: endedAt - startedAt,
    model,
    usage,
    turns: result?.turns,
    budgetExceeded: result?.budgetExceeded,
    exitCode: result ? 0 : 1,
    outcome: result
      ? { testCaseUuid, environment, repoPath, defectId, allowPr, turns: result.turns, budgetExceeded: result.budgetExceeded, report: result.report }
      : { testCaseUuid, environment, repoPath, defectId, allowPr, error: true },
  });
  await safeClose(sink);
}
