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
  /**
   * Exactly one of these three — the caller validates this before calling
   * autopilot(), same as run_judge's own mutual-exclusion check in
   * metaTools.ts. One test case is the routine "a defect just got filed"
   * case; scenario_id/test_set_id is for the "hand it a whole regression
   * set" case — richer context (what's this scope's actual intent/scope),
   * and Phase 1 only gets paid for once instead of once per TC.
   */
  testCaseUuid?: string;
  scenarioId?: number;
  testSetId?: number;
  environment: string;
  repoPath: string;
  budget: RunBudget;
  metaTools: MetaToolsConfig;
  /**
   * The specific defect that triggered this run, when the caller already
   * knows it (e.g. a fetch-latest-defect wrapper that resolved test_case_uuid
   * FROM a defect_id in the first place). Optional — Phase 1's own context
   * gathering still works without it, but only discovers a "linked defect"
   * incidentally, if one happens to be surfaced through get_test_results/
   * get_quality_context. Passing this closes that gap: it's the difference
   * between Phase 1 *maybe* noticing a defect exists for this TC, and Phase 1
   * *definitely* loading the exact defect that motivated this invocation,
   * which is what its own defect/TC mismatch check (see systemPrompt.ts)
   * actually needs to be checking against.
   */
  defectId?: string;
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

  const scopeLine = opts.testCaseUuid
    ? `Test case UUID: ${opts.testCaseUuid}`
    : opts.scenarioId !== undefined
      ? `Scope: entire scenario ${opts.scenarioId} — call get_scenario to see every test case in it before ` +
        'doing anything else. This is a multi-TC run: gather shared context once, then reason with relative ' +
        'priority across all of them, not TC-by-TC in isolation.'
      : `Scope: entire test set ${opts.testSetId} — call get_test_set to see every test case in it (it can ` +
        'span multiple scenarios) before doing anything else. This is a multi-TC run: gather shared context ' +
        'once, then reason with relative priority across all of them, not TC-by-TC in isolation.';

  const seedMessage = [
    scopeLine,
    `Environment: ${opts.environment}`,
    `Repo path (for run_defect_fix/run_generate/run_pr_raise/run_heal): ${opts.repoPath}`,
    ...(opts.defectId
      ? [
          `Triggering defect ID: ${opts.defectId} — this specific defect is why this run was invoked. ` +
            'Call get_defect_context on it directly as your first defect-related lookup in Phase 1 — do not ' +
            'wait for it to be surfaced incidentally through get_test_results/get_quality_context, and do not ' +
            'skip the defect/TC mismatch check just because no other signal happens to mention it.',
        ]
      : []),
    opts.testCaseUuid
      ? 'Begin now — start with get_scenario.'
      : 'Begin now — lead with a SINGLE scope-level run_judge call (scenario_id/test_set_id, not ' +
        'test_case_uuid) before anything else. That is your cheap first-pass signal across the whole scope; ' +
        'never loop calling run_judge per test case yourself when one scope-level call already covers it.',
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
