// Wraps the five sibling agents (appliqation-autotest, appliqation-scriptgen,
// appliqation-defect-fix, appliqation-pr-raise, appliqation-explorer) as ordinary
// LLM-callable tools. Never a filesystem or
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
  explorerCmd: string;
  healCmd: string;
  commandTimeoutMs: number;
  /** Whether run_pr_raise is even offered — see metaToolDefs(). */
  allowPr: boolean;
}

export function metaToolDefs(cfg: MetaToolsConfig): LlmToolDef[] {
  const defs: LlmToolDef[] = [
    {
      name: 'run_judge',
      description:
        'Run autonomous testing against a live environment — one test case, or an entire scenario/test set ' +
        'at once via scenario_id/test_set_id. This is the ONLY way to know current pass/fail state — never ' +
        'assume it from prior context alone. At scenario/test_set scope, this is your cheap first-pass signal: ' +
        'appliqation-autotest itself runs the deterministic canonical-script pipeline for every TC that has ' +
        'one (zero extra LLM cost) and only agentically judges the rest, per its own coverage policy — pass ' +
        'coverage: "on-failure-or-absence" to also re-verify a TC whose canonical script exists but just ' +
        'failed (the default, "on-script-absence", silently trusts a possibly-stale script forever). Lead with ' +
        'ONE scope-level call here before spending further budget — never loop calling this per test case ' +
        'yourself when a single scenario_id/test_set_id call already covers the whole set. Returns a real, ' +
        'appq-polled outcome per test case either way.',
      inputSchema: {
        type: 'object',
        properties: {
          test_case_uuid: { type: 'string', description: 'One test case. Mutually exclusive with scenario_id/test_set_id.' },
          scenario_id: { type: 'integer', description: 'An entire scenario. Mutually exclusive with test_case_uuid/test_set_id.' },
          test_set_id: { type: 'integer', description: 'An entire test set (can span multiple scenarios). Mutually exclusive with test_case_uuid/scenario_id.' },
          environment: { type: 'string' },
          coverage: {
            type: 'string',
            description:
              'Only meaningful with scenario_id/test_set_id: always | on-script-absence | on-failure-or-absence | ' +
              'sampled:N | external. Defaults to on-script-absence if omitted.',
          },
          dry_run: {
            type: 'boolean',
            description: 'Suppress writeback to Appliqation — use when you only need to observe current behaviour, not record a verdict.',
          },
        },
        required: ['environment'],
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
    {
      name: 'run_heal',
      description:
        'Repair ONE broken selector in an EXISTING canonical script — narrow and token-efficient, never a full ' +
        'regenerate (that\'s run_generate\'s job). Use this specifically for the "canonical script exists but ' +
        'just failed" case (run_judge with coverage: "on-failure-or-absence" surfaces these) — it independently ' +
        'diagnoses whether the failure is genuine selector staleness (heals it) or a real behaviour change ' +
        '(declines, touches nothing). declined: true in the result means this is NOT a healing case — treat it ' +
        'exactly like any other confirmed failure (a run_defect_fix candidate), do not retry healing. Only a ' +
        'real, independently-executed Playwright run — never the model\'s own claim — counts as verified.',
      inputSchema: {
        type: 'object',
        properties: {
          test_case_uuid: { type: 'string' },
          script_path: { type: 'string', description: 'The canonical script file containing the broken selector, relative to repo_path.' },
          failure: {
            type: 'string',
            description: 'What is failing and why, from your own gathered evidence (the step, the selector, the error message) — never a generic instruction.',
          },
          environment: { type: 'string' },
          defect_id: { type: 'string', description: 'Optional — a defect linked to this failure, if known.' },
          repo_path: { type: 'string' },
        },
        required: ['test_case_uuid', 'script_path', 'failure', 'environment', 'repo_path'],
      },
    },
    {
      name: 'run_explore',
      description:
        'Run a headless exploratory-QA pass (appq:runman) against a live target — open-ended senior-QA ' +
        'heuristics, accessibility, security/network/caching probes, the kind of coverage a scripted test case ' +
        'never checks for. Not a routine step: call it only when your own gathered context gives you a real, ' +
        'statable reason to suspect the literal test case in front of you is not enough on its own (see the ' +
        'policy\'s Phase 2 for how to judge that). prompt should state the exploration intent in plain English ' +
        '— what you actually want covered, not a generic instruction.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Plain-English exploration intent — what to cover and why, from your own gathered context.' },
          project_id: { type: 'integer' },
          site_url: { type: 'string' },
        },
        required: ['prompt'],
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
        const scopeArgsGiven = [args.test_case_uuid, args.scenario_id, args.test_set_id].filter((v) => v !== undefined).length;
        if (scopeArgsGiven !== 1) {
          return {
            ok: false,
            text: 'run_judge needs exactly one of test_case_uuid, scenario_id, or test_set_id — got ' +
              `${scopeArgsGiven}. These are mutually exclusive scopes, not combinable.`,
          };
        }
        const cliArgs = ['--environment', String(args.environment)];
        if (args.test_case_uuid !== undefined) cliArgs.push('--test-case-uuid', String(args.test_case_uuid));
        if (args.scenario_id !== undefined) cliArgs.push('--scenario-id', String(args.scenario_id));
        if (args.test_set_id !== undefined) cliArgs.push('--test-set-id', String(args.test_set_id));
        if (args.coverage) cliArgs.push('--coverage', String(args.coverage));
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
      case 'run_heal': {
        const cliArgs = [
          '--test-case-uuid',
          String(args.test_case_uuid),
          '--script-path',
          String(args.script_path),
          '--failure',
          String(args.failure),
          '--environment',
          String(args.environment),
          '--repo-path',
          String(args.repo_path),
        ];
        if (args.defect_id) cliArgs.push('--defect-id', String(args.defect_id));
        return runCliJson(cfg.healCmd, 'heal', cliArgs, cfg.commandTimeoutMs);
      }
      case 'run_explore': {
        const cliArgs = ['--prompt', String(args.prompt)];
        if (args.project_id !== undefined) cliArgs.push('--project-id', String(args.project_id));
        if (args.site_url) cliArgs.push('--site-url', String(args.site_url));
        return runCliJson(cfg.explorerCmd, 'explore', cliArgs, cfg.commandTimeoutMs);
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
