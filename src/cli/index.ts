#!/usr/bin/env node
// `run`: the agentic orchestrator. Reasons over real context to decide
// whether to run autonomous testing, generate new automation, or raise a
// PR for it — see src/policy/systemPrompt.ts for the actual methodology
// (the one real customization point) and src/orchestrator/autopilot.ts for
// the mechanism.

import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { createMcpClient, createAnthropicAdapter, createOpenAiAdapter, createUsageAccumulator } from '@appliqation/agent-core';
import type { ProviderAdapter, LoopResult } from '@appliqation/agent-core';
import { config, resolveProvider, resolveModel } from '../config/env.js';
import { autopilot } from '../orchestrator/autopilot.js';
import { recordAutopilotRun } from './audit.js';

function buildAdapter(): ProviderAdapter {
  const provider = resolveProvider();
  const model = resolveModel();
  return provider === 'anthropic'
    ? createAnthropicAdapter(config.anthropicApiKey!, model, config.anthropicMaxTokens)
    : createOpenAiAdapter(config.openaiApiKey!, model, config.openaiMaxOutputTokens);
}

function logEvent(prefix: string) {
  return (e: { type: string; detail?: unknown }) => {
    if (e.type === 'assistant') {
      const text = ((e.detail as string) ?? '').trim();
      if (text) console.error(`${prefix}[thinking] ${text}`);
    } else if (e.type === 'tool') {
      const d = e.detail as { name: string; result: string };
      console.error(`${prefix}[tool] ${d.name} -> ${d.result.slice(0, 400)}`);
    } else if (e.type === 'log') {
      console.error(`${prefix}[log] ${e.detail}`);
    } else if (e.type === 'usage') {
      const u = e.detail as { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number };
      const cacheNote = u.cacheReadTokens
        ? ` (${u.cacheReadTokens} from cache)`
        : u.cacheWriteTokens
          ? ` (${u.cacheWriteTokens} written to cache)`
          : '';
      console.error(`${prefix}[usage] in=${u.inputTokens} out=${u.outputTokens}${cacheNote}`);
    }
  };
}

const program = new Command();
program
  .name('appliqation-autopilot')
  .description(
    'An agentic orchestrator that reasons over real context (current pass/fail state, flakiness, defects, ' +
      'coverage priority) to decide whether to run autonomous testing, fix a defect, generate new automation, ' +
      "or raise a PR for it — a real decision every time, not a fixed script. See README.md for the full story.",
  );

program
  .command('run')
  .description(
    'Route one test case. Gathers context, states a plan, executes it adaptively (run_judge/run_defect_fix/' +
      'run_generate, and run_pr_raise if --allow-pr), re-checking real results at every step. Never claims an ' +
      "outcome it did not actually observe via a tool call — see the policy's own non-negotiable rule.",
  )
  .requiredOption('--test-case-uuid <uuid>', 'test case UUID to route')
  .requiredOption('--environment <name>', 'environment name — passed to run_judge/run_generate')
  .requiredOption('--repo-path <path>', 'local repo checkout run_generate/run_pr_raise operate in')
  .option(
    '--defect-id <id>',
    'the specific defect that triggered this run, when the caller already resolved one (e.g. derived ' +
      'test-case-uuid FROM a defect). Without this, Phase 1 only discovers a linked defect incidentally, if ' +
      'one happens to surface through get_test_results/get_quality_context — passing it makes the defect/TC ' +
      'mismatch check in the policy actually check against the real triggering defect, not miss it.',
  )
  .option('--allow-pr', 'authorize run_pr_raise — without this flag, that tool is not even offered to the model')
  .option('--policy <path>', 'override the bundled decision policy with your own system prompt file')
  .option('--max-turns <n>', 'override BUDGET_MAX_TURNS for this run')
  .option('--json', 'print a single structured JSON result instead of the human-readable report')
  .option('--ci', 'shorthand for --json')
  .action(
    async (opts: {
      testCaseUuid: string;
      environment: string;
      repoPath: string;
      defectId?: string;
      allowPr?: boolean;
      policy?: string;
      maxTurns?: string;
      json?: boolean;
      ci?: boolean;
    }) => {
      const json = (opts.json ?? false) || (opts.ci ?? false);
      const client = createMcpClient({ origin: config.appqOrigin, apiKey: config.appqApiKey() });
      const adapter = buildAdapter();
      const allowPr = opts.allowPr ?? false;

      const policyPath = opts.policy ?? config.policyFile;
      const systemPromptOverride = policyPath ? await readFile(policyPath, 'utf-8') : undefined;

      const budget = { ...config.budget, ...(opts.maxTurns ? { maxTurns: Number(opts.maxTurns) } : {}) };

      if (allowPr) {
        console.error('[setup] run_pr_raise is AUTHORIZED for this invocation.');
      } else {
        console.error('[setup] run_pr_raise is not authorized (pass --allow-pr to enable it).');
      }

      const startedAt = Date.now();
      const usage = createUsageAccumulator();
      const baseLog = logEvent('');
      let result: LoopResult | undefined;
      try {
        result = await autopilot({
          client,
          adapter,
          testCaseUuid: opts.testCaseUuid,
          environment: opts.environment,
          repoPath: opts.repoPath,
          defectId: opts.defectId,
          budget,
          metaTools: {
            autotestCmd: config.autotestCmd,
            scriptgenCmd: config.scriptgenCmd,
            prRaiseCmd: config.prRaiseCmd,
            defectFixCmd: config.defectFixCmd,
            explorerCmd: config.explorerCmd,
            commandTimeoutMs: config.commandTimeoutMs,
            allowPr,
          },
          systemPromptOverride,
          onEvent: (e) => {
            baseLog(e);
            if (e.type === 'usage') usage.onUsage(e.detail as { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number });
          },
        });
      } finally {
        // Audit write happens whether the run succeeded or threw — see
        // @appliqation/agent-core's audit/sink.ts: safeRecord() (used
        // inside recordAutopilotRun) never lets a failed/unreachable audit
        // sink affect this process's real outcome.
        await recordAutopilotRun({
          sink: config.auditSink,
          startedAt,
          endedAt: Date.now(),
          model: resolveModel(),
          usage: usage.totals(),
          testCaseUuid: opts.testCaseUuid,
          environment: opts.environment,
          repoPath: opts.repoPath,
          defectId: opts.defectId,
          allowPr,
          result,
        });
      }

      if (json) {
        console.log(JSON.stringify({ report: result.report, turns: result.turns, budgetExceeded: result.budgetExceeded }, null, 2));
        return;
      }
      console.log('\n=== Report ===\n');
      console.log(result.report);
      console.error(`\n(${result.turns} turns, budget exceeded: ${result.budgetExceeded})`);
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
