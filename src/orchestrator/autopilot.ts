// Ties it together: the read-only appq context tools, the three meta-tools
// wrapping the sibling agents, and the policy (system prompt) that actually
// drives judgment — run through @appliqation/agent-core's generic
// think->act->observe loop directly. No appq prompt fetch at all: the
// system prompt is local (src/policy/systemPrompt.ts or a --policy
// override), so runLoop() is used directly rather than runWorkflow()'s
// appq-fetch indirection, which has nothing to fetch here.

import { runLoop, fetchAppqToolDefs, createGatedAppqDispatcher, createReadOnlyProjectContextDispatcher, PROJECT_CONTEXT_TOOL } from '@appliqation/agent-core';
import type { McpClient, ProviderAdapter, RunBudget, ToolDispatcher, LoopResult } from '@appliqation/agent-core';
import { READONLY_CONTEXT_TOOLS } from '../tools/safety.js';
import { metaToolDefs, createMetaToolDispatch } from '../tools/metaTools.js';
import type { MetaToolsConfig } from '../tools/metaTools.js';
import { buildSystemPrompt } from '../policy/systemPrompt.js';

export interface AutopilotOptions {
  client: McpClient;
  adapter: ProviderAdapter;
  testCaseUuid: string;
  environment: string;
  repoPath: string;
  budget: RunBudget;
  metaTools: MetaToolsConfig;
  /** Overrides the bundled policy — see src/policy/systemPrompt.ts and --policy. */
  systemPromptOverride?: string;
  onEvent?: (event: { type: string; detail?: unknown }) => void;
}

export async function autopilot(opts: AutopilotOptions): Promise<LoopResult> {
  const contextToolAllowlist = new Set([...READONLY_CONTEXT_TOOLS, PROJECT_CONTEXT_TOOL]);
  const appqToolDefs = await fetchAppqToolDefs(opts.client, contextToolAllowlist);
  // Argument-level gate applied outermost — see @appliqation/agent-core's tools/projectContext.ts —
  // so a write attempt is refused before anything else decides what to do
  // with the call, same ordering reasoning as judgeTc.ts's browser-label
  // correction sitting outside its dry-run interceptor.
  const gatedAppq = createReadOnlyProjectContextDispatcher(createGatedAppqDispatcher(opts.client, contextToolAllowlist));
  const metaDispatch = createMetaToolDispatch(opts.metaTools);
  const metaDefs = metaToolDefs(opts.metaTools);
  const metaNames = new Set(metaDefs.map((t) => t.name));

  const dispatch: ToolDispatcher = async (name, args) => {
    if (metaNames.has(name)) return metaDispatch(name, args);
    return gatedAppq(name, args);
  };

  const system = opts.systemPromptOverride ?? buildSystemPrompt(opts.metaTools.allowPr);
  const seedMessage = [
    `Test case UUID: ${opts.testCaseUuid}`,
    `Environment: ${opts.environment}`,
    `Repo path (for run_generate/run_pr_raise): ${opts.repoPath}`,
    'Begin now — start with get_scenario.',
  ].join('\n');

  return runLoop({
    adapter: opts.adapter,
    system,
    seedMessage,
    tools: [...appqToolDefs, ...metaDefs],
    dispatch,
    budget: opts.budget,
    onEvent: opts.onEvent,
  });
}
