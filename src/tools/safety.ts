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
