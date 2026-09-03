// Extracted out of cli/index.ts so this is testable without triggering that
// file's top-level program.parseAsync(process.argv) side effect, same
// reasoning as appliqation-autotest's cli/resolvers.ts.

import { safeRecord, safeClose, type AuditSink, type AuditRecord } from '@appliqation/agent-core';
import type { LoopResult } from '@appliqation/agent-core';
import type { MetaToolAction, ScopeResult } from './actionSummary.js';

export interface RecordAutopilotRunArgs {
  sink: AuditSink;
  startedAt: number;
  endedAt: number;
  model: string;
  usage: AuditRecord['usage'];
  /** Exactly one of these three, mirrors AutopilotOptions' own scope. */
  testCaseUuid?: string;
  scenarioId?: number;
  testSetId?: number;
  environment: string;
  repoPath: string;
  defectId?: string;
  allowPr: boolean;
  allowVisual: boolean;
  /** undefined means autopilot() threw — the run never produced a result. */
  result: LoopResult | undefined;
  /** Real structured meta-tool call data captured during the run — see actionSummary.ts. Optional so existing callers/tests stay valid. */
  actionSummary?: { actions: MetaToolAction[]; scopeResults?: ScopeResult[] };
}

export async function recordAutopilotRun(args: RecordAutopilotRunArgs): Promise<void> {
  const { sink, startedAt, endedAt, model, usage, testCaseUuid, scenarioId, testSetId, environment, repoPath, defectId, allowPr, allowVisual, result, actionSummary } = args;
  const scope = { testCaseUuid, scenarioId, testSetId };
  const actionFields = actionSummary ? { actions: actionSummary.actions, scopeResults: actionSummary.scopeResults } : {};
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
      ? { ...scope, environment, repoPath, defectId, allowPr, allowVisual, ...actionFields, turns: result.turns, budgetExceeded: result.budgetExceeded, report: result.report }
      : { ...scope, environment, repoPath, defectId, allowPr, allowVisual, error: true },
  });
  await safeClose(sink);
}
