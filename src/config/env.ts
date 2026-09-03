import 'dotenv/config';
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from '@appliqation/agent-core/providers';
import { required, optional } from '@appliqation/agent-core/config';
import { resolveAuditSink } from '@appliqation/agent-core/audit';

export const config = {
  appqOrigin: optional('APPQ_ORIGIN') ?? 'https://appq.appliqation.io',
  appqApiKey: () => required('APPQ_API_KEY'),
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  openaiApiKey: optional('OPENAI_API_KEY'),
  deepseekApiKey: optional('DEEPSEEK_API_KEY'),
  glmApiKey: optional('GLM_API_KEY'),
  anthropicModel: optional('ANTHROPIC_MODEL'),
  openaiModel: optional('OPENAI_MODEL'),
  deepseekModel: optional('DEEPSEEK_MODEL'),
  glmModel: optional('GLM_MODEL'),
  deepseekBaseUrl: optional('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com',
  glmBaseUrl: optional('GLM_BASE_URL') ?? 'https://open.bigmodel.cn/api/paas/v4',
  anthropicMaxTokens: Number(optional('ANTHROPIC_MAX_TOKENS') ?? 8192),
  openaiMaxOutputTokens: Number(optional('OPENAI_MAX_OUTPUT_TOKENS') ?? 8192),
  deepseekMaxTokens: Number(optional('DEEPSEEK_MAX_TOKENS') ?? 8192),
  glmMaxTokens: Number(optional('GLM_MAX_TOKENS') ?? 8192),
  // Generous relative to the other agents in this family — a single
  // autopilot run legitimately needs several rounds: gather context from
  // several tools, reason, act, re-evaluate the real result, possibly act
  // again. Cutting this short would force shallow, single-shot decisions.
  budget: {
    maxCalls: Number(optional('BUDGET_MAX_CALLS') ?? 40),
    maxPages: 999_999, // this agent never drives a browser directly
    maxMillis: Number(optional('BUDGET_MAX_MILLIS') ?? 30 * 60 * 1000),
    maxTurns: Number(optional('BUDGET_MAX_TURNS') ?? 30),
    // A broad backstop against runaway spend, not a tuned budget: the other
    // caps above are what normally end a run first. Includes cache tokens.
    maxTotalTokens: Number(optional('BUDGET_MAX_TOTAL_TOKENS') ?? 2_000_000),
  },
  // How to invoke the seven sibling agents. Never a filesystem/private-npm
  // dependency (this repo is meant to be cloned standalone), just a command
  // string split on whitespace into [command, ...baseArgs]. Defaults assume
  // the real packages are installed and on PATH; override to point at a
  // local dev build (e.g. "node /path/to/appliqation-autotest/dist/cli/index.js").
  autotestCmd: optional('AUTOTEST_CMD') ?? 'appliqation-autotest',
  scriptgenCmd: optional('SCRIPTGEN_CMD') ?? 'appliqation-scriptgen',
  prRaiseCmd: optional('PR_RAISE_CMD') ?? 'appliqation-pr-raise',
  defectFixCmd: optional('DEFECT_FIX_CMD') ?? 'appliqation-defect-fix',
  explorerCmd: optional('EXPLORER_CMD') ?? 'appliqation-explorer',
  healCmd: optional('HEAL_CMD') ?? 'appliqation-heal-selector',
  visualCmd: optional('VISUAL_CMD') ?? 'appliqation-visual-regression',
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

export function resolveProvider(): 'anthropic' | 'openai' | 'deepseek' | 'glm' {
  if (config.anthropicApiKey) return 'anthropic';
  if (config.openaiApiKey) return 'openai';
  if (config.deepseekApiKey) return 'deepseek';
  if (config.glmApiKey) return 'glm';
  throw new Error('Set ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, or GLM_API_KEY');
}

/**
 * DeepSeek/GLM have no documented default model constant here (unlike
 * Anthropic/OpenAI) — model IDs on both move fast and a silently stale
 * hardcoded default would be worse than an explicit, actionable error.
 */
export function resolveModel(): string {
  const provider = resolveProvider();
  if (provider === 'anthropic') return config.anthropicModel ?? DEFAULT_ANTHROPIC_MODEL;
  if (provider === 'openai') return config.openaiModel ?? DEFAULT_OPENAI_MODEL;
  if (provider === 'deepseek') return config.deepseekModel ?? throwMissingModel('DEEPSEEK_MODEL');
  return config.glmModel ?? throwMissingModel('GLM_MODEL');
}

function throwMissingModel(envVar: string): never {
  throw new Error(`${envVar} is required when its provider is selected — no default model is assumed.`);
}
