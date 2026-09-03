// This agent's own domain knowledge of which appq tools it may touch — the
// enforcement mechanism (assertToolAllowed / the gated dispatcher) lives in
// @appliqation/agent-core, shared with every sibling agent; only the
// allowlist content is local. Broader than a single-purpose workflow's
// palette on purpose — a genuine routing decision needs the same breadth of
// signal a senior engineer would look at, not one field. Zero write tools —
// this agent itself never calls an appq write tool; write-adjacent action
// happens only through the meta-tools (src/tools/metaTools.ts), which are
// themselves backed by the sibling agents' own safety boundaries.

export const READONLY_CONTEXT_TOOLS = new Set([
  'get_scenario',
  'get_test_set',
  'get_automation_readiness',
  'get_failure_patterns',
  'get_defect_context',
  'get_coverage_analysis',
  'get_quality_context',
  'get_evidence_summary',
  'get_run_evidence',
  'get_execution_evidence',
  'get_test_results',
  'search_tests',
  'get_project_settings',
]);

// enrich_project_context is a SINGLE MCP tool with both action=read and
// action=write modes — not two separate tools. Kept out of
// READONLY_CONTEXT_TOOLS on purpose: that set's whole guarantee is "no
// write capability under any argument," and folding this in would quietly
// weaken that guarantee for every tool in it, not just this one.
// PROJECT_CONTEXT_TOOL itself, and the argument-level gate that enforces
// read-only access to it, now live in @appliqation/agent-core's
// tools/projectContext.ts — shared with every other headless agent that
// needs the identical guarantee, not just this one.
