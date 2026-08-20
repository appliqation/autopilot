import 'dotenv/config';
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from '@appliqation/agent-core/providers';
import { required, optional } from '@appliqation/agent-core/config';
import { resolveAuditSink } from '@appliqation/agent-core/audit';

export const config = {
  appqOrigin: optional('APPQ_ORIGIN') ?? 'https://appq.appliqation.io',
  appqApiKey: () => required('APPQ_API_KEY'),
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  openaiApiKey: optional('OPENAI_API_KEY'),
  anthropicModel: optional('ANTHROPIC_MODEL'),
  openaiModel: optional('OPENAI_MODEL'),
  anthropicMaxTokens: Number(optional('ANTHROPIC_MAX_TOKENS') ?? 8192),
  openaiMaxOutputTokens: Number(optional('OPENAI_MAX_OUTPUT_TOKENS') ?? 8192),
  // Generous relative to the other agents in this family — a single
  // autopilot run legitimately needs several rounds: gather context from
  // several tools, reason, act, re-evaluate the real result, possibly act
  // again. Cutting this short would force shallow, single-shot decisions.
  budget: {
    maxCalls: Number(optional('BUDGET_MAX_CALLS') ?? 40),
    maxPages: 999_999, // this agent never drives a browser directly
    maxMillis: Number(optional('BUDGET_MAX_MILLIS') ?? 30 * 60 * 1000),
    maxTurns: Number(optional('BUDGET_MAX_TURNS') ?? 30),
  },
  // How to invoke the five sibling agents — never a filesystem/private-npm
  // dependency (this repo is meant to be cloned standalone), just a command
  // string split on whitespace into [command, ...baseArgs]. Defaults assume
  // the real packages are installed and on PATH; override to point at a
  // local dev build (e.g. "node /path/to/appliqation-autotest/dist/cli/index.js").
  autotestCmd: optional('AUTOTEST_CMD') ?? 'appliqation-autotest',
  scriptgenCmd: optional('SCRIPTGEN_CMD') ?? 'appliqation-scriptgen',
  prRaiseCmd: optional('PR_RAISE_CMD') ?? 'appliqation-pr-raise',
  defectFixCmd: optional('DEFECT_FIX_CMD') ?? 'appliqation-defect-fix',
  explorerCmd: optional('EXPLORER_CMD') ?? 'appliqation-explorer',
  commandTimeoutMs: Number(optional('COMMAND_TIMEOUT_MS') ?? 20 * 60 * 1000),
  // The one real customization point — see src/policy/systemPrompt.ts.
  policyFile: optional('POLICY_FILE'),

  // Observability, entirely opt-in — see @appliqation/agent-core's audit/sink.ts.
  auditSink: resolveAuditSink({
    auditMongoUri: optional('AUDIT_MONGO_URI'),
    auditMongoDb: optional('AUDIT_MONGO_DB'),
    auditMongoCollection: optional('AUDIT_MONGO_COLLECTION'),
    auditJsonlPath: optional('AUDIT_JSONL_PATH'),
  }),
};

export function resolveProvider(): 'anthropic' | 'openai' {
  if (config.anthropicApiKey) return 'anthropic';
  if (config.openaiApiKey) return 'openai';
  throw new Error('Set ANTHROPIC_API_KEY or OPENAI_API_KEY');
}

export function resolveModel(): string {
  const provider = resolveProvider();
  return provider === 'anthropic' ? (config.anthropicModel ?? DEFAULT_ANTHROPIC_MODEL) : (config.openaiModel ?? DEFAULT_OPENAI_MODEL);
}
