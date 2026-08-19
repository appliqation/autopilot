// Wraps the four sibling agents (appliqation-autotest, appliqation-scriptgen,
// appliqation-defect-fix, appliqation-pr-raise) as ordinary LLM-callable tools. Never a filesystem or
// private-npm dependency — each is invoked as a configured command string
// (see src/config/env.ts), spawned via child_process.execFile with an
// explicit argv array (never a shell string), consuming the CLI's own
// --json output. The model sees the REAL structured result every time —
// verified/testRun.ok/a real PR URL — never a paraphrase of one.

import { execFile } from 'node:child_process';
import type { LlmToolDef, ToolResult } from '@appliqation/agent-core';

interface ExecOutcome {
  stdout: string;
  stderr: string;
}

interface ExecFailure extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

// Same hand-rolled wrapper used by appliqation-scriptgen/appliqation-pr-raise,
// for the same reason: util.promisify(execFile) only resolves {stdout,
// stderr} via an internal Node symbol a mocked module in tests won't carry.
function execFileAsync(
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
): Promise<ExecOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const failure = error as ExecFailure;
        failure.stdout = String(stdout ?? '');
        failure.stderr = String(stderr ?? '');
        rejectPromise(failure);
      } else {
        resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    });
  });
}

/** Splits a configured command string ("node /path/to/cli.js") into [command, ...baseArgs]. */
export function parseCommand(cmd: string): [string, string[]] {
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error(`Empty command string: "${cmd}"`);
  return [parts[0], parts.slice(1)];
}

export interface MetaToolsConfig {
  autotestCmd: string;
  scriptgenCmd: string;
  prRaiseCmd: string;
  defectFixCmd: string;
  commandTimeoutMs: number;
  /** Whether run_pr_raise is even offered — see metaToolDefs(). */
  allowPr: boolean;
}

export function metaToolDefs(cfg: MetaToolsConfig): LlmToolDef[] {
  const defs: LlmToolDef[] = [
    {
      name: 'run_judge',
      description:
        'Run autonomous testing (a real executor + validator pass) for one test case against a live ' +
        "environment. Returns the real, appq-polled outcome. This is the ONLY way to know a test case's " +
        'current pass/fail state — never assume it from prior context alone.',
      inputSchema: {
        type: 'object',
        properties: {
          test_case_uuid: { type: 'string' },
          environment: { type: 'string' },
          dry_run: {
            type: 'boolean',
            description: 'Suppress writeback to Appliqation — use when you only need to observe current behaviour, not record a verdict.',
          },
        },
        required: ['test_case_uuid', 'environment'],
      },
    },
    {
      name: 'run_generate',
      description:
        'Draft and REALLY verify a Playwright script for one test case — it actually runs the generated ' +
        "script; the result's testRun.ok reflects a real, independently-checked outcome, never the model's " +
        'own claim from inside that run. Only call this once you know (via run_judge or existing evidence) ' +
        'that the test case currently passes — generating a script for a currently-failing test case would ' +
        'encode broken behaviour as a false baseline.',
      inputSchema: {
        type: 'object',
        properties: {
          test_case_uuid: { type: 'string' },
          environment: { type: 'string', description: 'Optional — offered to the generator as base-URL context.' },
          repo_path: { type: 'string' },
        },
        required: ['test_case_uuid', 'repo_path'],
      },
    },
    {
      name: 'run_defect_fix',
      description:
        'Fix a defect: loads full defect context, locates and applies a real code fix, syncs the Appliqation ' +
        'scenario, and verifies the fix by actually running Playwright — the result\'s verified field reflects ' +
        'a real, independently-checked outcome, never the model\'s own claim from inside that run. ' +
        'test_instruction is REQUIRED — you must state, from your own gathered evidence (defect_history, ' +
        'run_context, is_flaky), what testing scope this fix actually needs verified beyond just the single ' +
        'reproducing test case (e.g. "also re-run the whole scenario — this component has a history of ' +
        'regressions" or "the single reproducing test case is sufficient — this is an isolated, one-off defect"). ' +
        'Never call this with a vague or empty instruction.',
      inputSchema: {
        type: 'object',
        properties: {
          defect_id: { type: 'string' },
          repo_path: { type: 'string' },
          test_instruction: {
            type: 'string',
            description: 'Required — your own assessment of the testing scope this fix needs, from Phase 1 evidence.',
          },
          dry_run: {
            type: 'boolean',
            description: 'Suppress the Appliqation scenario/run writeback — use when you only need to observe whether a fix is achievable, not commit one.',
          },
        },
        required: ['defect_id', 'repo_path', 'test_instruction'],
      },
    },
  ];

  // Hardcoded exclusion, not a soft warning — matches every other
  // non-negotiable safety boundary in this agent family. If --allow-pr
  // wasn't passed to this CLI invocation, this tool simply isn't in the
  // list the model ever sees; there's no way for it to attempt this.
  if (cfg.allowPr) {
    defs.push({
      name: 'run_pr_raise',
      description:
        "Commit whatever run_generate already wrote in repo_path, push, and open (or reuse) a pull " +
        'request. Only call this after run_generate reported testRun.ok: true for the same repo_path — ' +
        'never raise a PR for a script you have not seen independently verified.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'integer' },
          repo_path: { type: 'string' },
          branch_name: { type: 'string' },
          pr_title: { type: 'string' },
          pr_body: { type: 'string' },
        },
        required: ['project_id', 'repo_path', 'branch_name', 'pr_title'],
      },
    });
  }

  return defs;
}

async function runCliJson(baseCmd: string, subcommand: string, args: string[], timeoutMs: number): Promise<ToolResult> {
  const [command, baseArgs] = parseCommand(baseCmd);
  const fullArgs = [...baseArgs, subcommand, ...args, '--json'];
  try {
    const { stdout } = await execFileAsync(command, fullArgs, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
    return { ok: true, text: stdout.trim() || '{}' };
  } catch (err) {
    const e = err as ExecFailure;
    // Every sibling CLI prints its --json summary to stdout BEFORE setting
    // a non-zero exit code on a real failure (judge failed/blocked,
    // generate unverified) — recover it; it's real signal, not noise.
    const out = (e.stdout ?? '').trim();
    if (out) return { ok: false, text: out };
    return { ok: false, text: `${baseCmd} ${subcommand} failed: ${e.stderr || e.message}` };
  }
}

export function createMetaToolDispatch(cfg: MetaToolsConfig) {
  return async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    switch (name) {
      case 'run_judge': {
        const cliArgs = ['--test-case-uuid', String(args.test_case_uuid), '--environment', String(args.environment)];
        if (args.dry_run) cliArgs.push('--dry-run');
        return runCliJson(cfg.autotestCmd, 'judge', cliArgs, cfg.commandTimeoutMs);
      }
      case 'run_generate': {
        const cliArgs = ['--test-case-uuid', String(args.test_case_uuid), '--repo-path', String(args.repo_path)];
        if (args.environment) cliArgs.push('--environment', String(args.environment));
        return runCliJson(cfg.scriptgenCmd, 'generate', cliArgs, cfg.commandTimeoutMs);
      }
      case 'run_defect_fix': {
        const cliArgs = [
          '--defect-id',
          String(args.defect_id),
          '--repo-path',
          String(args.repo_path),
          '--test-instruction',
          String(args.test_instruction),
        ];
        if (args.dry_run) cliArgs.push('--dry-run');
        return runCliJson(cfg.defectFixCmd, 'fix', cliArgs, cfg.commandTimeoutMs);
      }
      case 'run_pr_raise': {
        if (!cfg.allowPr) {
          return { ok: false, text: 'run_pr_raise is not authorized for this invocation (--allow-pr was not set on appliqation-autopilot).' };
        }
        const cliArgs = [
          '--project-id',
          String(args.project_id),
          '--repo-path',
          String(args.repo_path),
          '--branch-name',
          String(args.branch_name),
          '--pr-title',
          String(args.pr_title),
        ];
        if (args.pr_body) cliArgs.push('--pr-body', String(args.pr_body));
        return runCliJson(cfg.prRaiseCmd, 'raise', cliArgs, cfg.commandTimeoutMs);
      }
      default:
        return { ok: false, text: `Unknown meta tool "${name}"` };
    }
  };
}
