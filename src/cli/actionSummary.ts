// Every meta-tool (run_judge/run_generate/run_defect_fix/run_heal/run_explore/
// run_pr_raise/run_visual_check) already returns a real, well-typed structured
// JSON summary as its sibling CLI's own --json output — metaTools.ts's
// runCliJson() recovers this even on a failing exit code, since every sibling
// CLI prints its summary before setting exit status. That structure flows
// through runLoop()'s onEvent callback as a 'tool' event's detail.result
// (a JSON string) and was previously discarded — this file captures it
// instead of re-deriving anything or asking the model to self-report a
// second time. No @appliqation/agent-core changes, no new tool/schema for
// the model to comply with.

export const META_TOOL_NAMES: ReadonlySet<string> = new Set([
  'run_judge',
  'run_generate',
  'run_defect_fix',
  'run_heal',
  'run_explore',
  'run_pr_raise',
  'run_visual_check',
]);

export interface MetaToolAction {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** The sibling CLI's own parsed --json summary, when ok. */
  result?: unknown;
  /**
   * Raw text when JSON.parse failed — a genuine dispatch-level failure
   * (malformed output, crash, timeout), distinct from a normal semantic
   * decline/failure (declined/unverified/blocked), which is still valid
   * JSON and lands in `result` like any other outcome.
   */
  rawText?: string;
}

/** One entry per TC in scope, straight from run_judge's own result — see appliqation-autotest's TcOutcome. */
export interface ScopeResult {
  testCaseUuid: string;
  path: string;
  status: string;
  errorMessage?: string;
  scenarioId?: number;
}

/**
 * Observes the same onEvent stream the CLI's own progress logger already
 * receives, and builds a structured summary from real meta-tool call
 * results — the same "facts come from real tool/API results, never parsed
 * from prose" discipline appliqation-autotest's own RunSummary/TcOutcome
 * already follows.
 */
export class ActionSummaryCollector {
  private actions: MetaToolAction[] = [];
  private scopeResults: ScopeResult[] | undefined;

  observe(event: { type: string; detail?: unknown }): void {
    if (event.type !== 'tool') return;
    const detail = event.detail as { name: string; args?: Record<string, unknown>; result: string };
    if (!META_TOOL_NAMES.has(detail.name)) return;

    let parsed: unknown;
    let ok = true;
    try {
      parsed = JSON.parse(detail.result);
    } catch {
      ok = false;
    }

    this.actions.push(
      ok ? { tool: detail.name, args: detail.args ?? {}, ok: true, result: parsed } : { tool: detail.name, args: detail.args ?? {}, ok: false, rawText: detail.result },
    );

    if (detail.name === 'run_judge' && ok && parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results)) {
      this.scopeResults = (parsed as { results: ScopeResult[] }).results;
    }
  }

  build(): { actions: MetaToolAction[]; scopeResults?: ScopeResult[] } {
    return { actions: this.actions, scopeResults: this.scopeResults };
  }
}
