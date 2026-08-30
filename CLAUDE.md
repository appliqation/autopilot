# CLAUDE.md — appliqation-autopilot

Part of the Appliqation workspace. See `~/Sites/localhost/CLAUDE.md` for how the
product fits together; this file is the map of **this repo only**. **This repo is
meant to be published publicly on GitHub** (not yet done as of this writing) — see
"Public-repo constraints" below before adding anything.

## What this repo is

The top-level agentic orchestrator for the standalone-agent family. Given one test
case — or an entire scenario/test set (`--scenario-id`/`--test-set-id`, mutually
exclusive with `--test-case-uuid`) — it reasons over real signal (current pass/fail
state, flakiness, linked defects, coverage priority, whether automation already
exists) to decide whether to run autonomous testing (`appliqation-autotest`), heal a
stale selector (`appliqation-heal-selector`), fix a defect (`appliqation-defect-fix`),
generate new automation (`appliqation-scriptgen`), run a headless exploratory-QA pass
(`appliqation-explorer`), raise a PR for it (`appliqation-pr-raise`), or take no action
and just report a recommendation — a real decision per test case, not a fixed script.
At scenario/test-set scope this is a genuinely different mechanism from
`appliqation-autotest`'s own scenario/test-set mode: that one loops in code
(deterministic); this one gathers Phase-1 context once and reasons across every TC in
scope inside a single `runLoop()` session (LLM-driven, not a code-level loop) — see
`src/orchestrator/autopilot.ts`.

## The one architectural decision that matters here

**The reasoning lives entirely in this repo's own code (`src/policy/systemPrompt.ts`),
not an appq MCP prompt.** This was built the wrong way first — mirroring every other
workflow in this workspace (`appq:automate`, `appq:autotest-executor`/`-validator`),
where methodology lives server-side in appq and the client stays thin — then explicitly
corrected. Two reasons, both real:
1. This orchestrator needs to be **customer-forkable**: a user who wants different
   judgment (more conservative, a different priority order) points `--policy` at their
   own file, full stop. That's impossible if the brain is fetched from Appliqation's
   private server.
2. **This repo is public.** It can't depend on a private API's hidden prose to function
   at all, and a "sophisticated agent" whose actual reasoning is invisible isn't much of
   a showcase.

The six sibling agents (`appliqation-autotest`/`appliqation-defect-fix`/
`appliqation-scriptgen`/`appliqation-pr-raise`/`appliqation-explorer`/
`appliqation-heal-selector`) are the opposite: genuinely self-contained, single-purpose,
each does one thing well, and none of them know this repo exists. That part of the
"tools stay simple" principle is unchanged — only the *orchestration judgment* moved
client-side, not the individual capabilities. One real consequence of this split for
`run_defect_fix` specifically: `appliqation-defect-fix` itself has no way to know how
much testing a given fix warrants (it only sees one defect in isolation) — that
judgment genuinely belongs here, where the broader signal (defect_history, run_context)
is already being gathered anyway. See `src/policy/systemPrompt.ts`'s Phase 2 for how
it's required to compose that instruction, not just decide whether to call the tool.
The same reasoning-belongs-in-Autopilot logic applies to `run_heal`:
`appliqation-heal-selector` only ever sees one script and one failure in isolation — it
has no way to know this TC's failure is even a stale-selector candidate versus a real
regression, or how it fits into a scenario/test-set's relative priority. That
first-verify-then-decide judgment (heal before defect-fix, decline is real evidence not
a failure) lives entirely in this repo's policy, not the healing agent itself.

## Public-repo constraints

- **No filesystem or private-npm dependencies on the sibling repos.** They're invoked
  as configurable command strings (`AUTOTEST_CMD`/`SCRIPTGEN_CMD`/`PR_RAISE_CMD`/
  `DEFECT_FIX_CMD`/`EXPLORER_CMD`/`HEAL_CMD`, see `src/config/env.ts`), spawned via
  `child_process.execFile`, never imported. An external clone with no access to
  `~/Sites/localhost/appliqation-autotest/` etc. still works once the sibling packages
  are published to npm (defaults assume they're on PATH) or if the user points the env
  vars at wherever they've built them.
- **`package.json`'s `@appliqation/agent-core` dependency is `^0.1.0`, a real npm version
  pin** — `@appliqation/agent-core` is now published (npmjs.com/package/@appliqation/agent-core).
  Was `file:../appliqation-agent-core` until this landed; keep it a real version range
  going forward, never revert to a `file:` path, or an external clone's `npm install`
  breaks again.
- **No secrets, ever.** `.env` is gitignored; `.env.example` documents every var with no
  real values. Nothing in `src/` should reference a real appq origin, API key, or token.
- **README.md is the primary audience-facing doc, not this file.** Keep this file
  (CLAUDE.md) for future Claude Code sessions working in the repo; keep README.md
  written for an external engineer/prospective customer evaluating the code.
- The README links all six sibling repos at their real `github.com/appliqation/...`
  URLs — keep that list in sync (table + diagram) whenever a sibling agent is added,
  renamed, or removed.

## Where to find what

- `src/policy/systemPrompt.ts` — **the actual customization point.** `buildSystemPrompt(allowPr)`
  is the full decision methodology: context-gathering priorities (current state first,
  then flakiness/defects/coverage/quality), the decision rules (**defect/TC mismatch
  checked first** — a defect linked to a test case that doesn't actually describe it
  (common for exploratory defects filed against whatever TC was active, not one written
  for that issue) routes straight to `run_defect_fix` regardless of the mismatched TC's
  own pass/fail status, never `run_judge`/`run_generate` against the wrong thing; no
  evidence → judge first; **failing + canonical script exists → `run_heal` first** (a
  failed-canonical TC is a healing candidate before it's a defect-fix candidate — if
  `run_heal` declines, that decline is real evidence, not a failure, and the TC falls
  through to the original failing-TC/defect-fix branch, never a retry of the heal);
  failing + no canonical → don't generate; passing + no canonical → generate; flaky →
  generate with lower confidence; low-priority → recommend and stop, that's a
  legitimate outcome), the adaptive-execution discipline (re-check every real result, never
  execute a plan blindly), and the report structure (every claim must cite a real tool
  result). `run_explore`'s guidance is deliberately NOT a deterministic trigger list —
  see its own paragraph in Phase 2: the bar is a specific, stated reason drawn from
  this TC's own gathered context (a fragility signal, a recurring known_issues
  category, a new UI component), with three illustrative (not exhaustive) examples and
  an explicit counterweight against calling it reflexively — matching this agent's own
  foundational "genuine judgment, not a rule checklist" design, not a special case for
  this one tool.
  **Scope-aware, not single-TC-only:** Phase 1 splits into a single-TC path (start with
  `get_scenario`) and a scenario/test-set path (enumerate via `get_scenario`/
  `get_test_set`, then lead with exactly **one scope-level `run_judge` call** —
  `on-failure-or-absence` coverage — to get autotest's own consolidated first-pass
  signal before spending further budget; never loop calling `run_judge` per TC
  yourself, that mechanism already exists inside `run_judge`/`appliqation-autotest`).
  Phase 2 gains a "prioritize across TCs" bullet for scope mode (rank by the same
  signals used per-TC — `high_risk_areas`, `known_issues`, `defect_history` — across
  the whole scope, not list order). Phase 4's report structure branches too: single-TC
  stays as before; scenario/test-set scope produces Scope summary → Per-TC outcomes
  (every TC in scope gets a line, even "no action needed") → Aggregate actions →
  Authorization notes → one prioritized Recommendation. Read this file before touching
  anything else — it's the actual "brain", everything else is mechanism around it.
- `src/orchestrator/autopilot.ts` — `autopilot()`: builds the tool palette (context
  tools + meta-tools), builds the seed message, and calls `runLoop()` **directly** from
  `@appliqation/agent-core/engine` — not `runWorkflow()`'s appq-prompt-fetch path, since
  there's nothing to fetch; the system prompt is always local (bundled default or
  `--policy` override). The appq dispatcher is wrapped in
  `createReadOnlyProjectContextDispatcher` (outermost, before the tool-name gate) so
  `enrich_project_context` — offered alongside the other context tools — can only ever
  be called with `action=read`. `AutopilotOptions`' scope is exactly one of
  `testCaseUuid`/`scenarioId`/`testSetId` (validated one level up, in `cli/index.ts`
  and independently again inside `run_judge`'s own dispatcher case in
  `metaTools.ts` — both layers check, since the model could call the tool with a
  malformed combination even if the CLI itself was invoked correctly); the seed
  message branches on which one is set — single-TC says "start with get_scenario",
  scenario/test-set names the scope, tells the model to enumerate via
  `get_scenario`/`get_test_set`, and to lead with a **single scope-level `run_judge`
  call**, explicitly never to loop calling `run_judge` per test case itself. Still
  exactly one `runLoop()` call regardless of scope — no code-level per-TC looping in
  this file; the per-TC reasoning happens inside that one LLM session.
- `src/tools/metaTools.ts` — `run_judge`/`run_generate`/`run_defect_fix`/`run_explore`/
  `run_heal`/`run_pr_raise` as `LlmToolDef`s + a dispatcher. Each spawns the configured
  sibling command with its real CLI flags plus `--json`, and returns the sibling's
  actual structured output as the tool result — including on failure (a failed/blocked
  judge, an unverified generate/defect-fix/heal, a budget-exceeded explore), recovered
  from stdout even though the process exits non-zero, since every sibling CLI prints
  its `--json` summary before setting its exit code. `run_judge`'s schema now only
  requires `environment` — `test_case_uuid`/`scenario_id`/`test_set_id`/`coverage` are
  all optional, passed through to the underlying `appliqation-autotest judge` CLI
  (which already supports scope/coverage flags); the dispatcher validates exactly one
  of the three scope args is given, returning a clear `ok: false` error without ever
  spawning a process otherwise. This is the mechanism that lets the model get an
  entire scope's real pass/fail/blocked signal from ONE tool call instead of looping
  per-TC itself. `run_heal` wraps `appliqation-heal-selector heal` (required:
  `test_case_uuid`, `script_path`, `failure`, `environment`, `repo_path`; optional
  `defect_id`), spawned via `healCmd` (new `MetaToolsConfig` field, following the exact
  existing `autotestCmd`/`scriptgenCmd` pattern) — same never-trust-self-report
  discipline as every sibling: the tool result is `appliqation-heal-selector`'s own
  `verified`/`declined` verdict, not the model's claim. `run_defect_fix`'s schema marks
  `test_instruction` **required** — the model must state, from its own gathered
  evidence, what testing scope the fix needs verified (see the policy's Phase 2);
  `run_explore` has no such required field but its description and the policy's Phase 2
  both require the model to compose its `prompt` argument from a real, stated reason,
  not a generic instruction. `run_defect_fix`, `run_explore`, and `run_heal` are always
  offered regardless of `allowPr`, since none of them touch git/GitHub — unlike
  `run_pr_raise`, none of them have a `dry_run` param either (`run_explore` has no real
  write path to suppress in the first place, see `PROJECT_CONTEXT_TOOL` below).
  `metaToolDefs()`'s `run_pr_raise` entry is only present in the returned array when
  `allowPr` is true — a hardcoded exclusion from what's offered to the model, not a
  runtime check the model could work around.
- `src/tools/safety.ts` — `READONLY_CONTEXT_TOOLS`, this agent's own read-only appq
  tool allowlist (broader than a single-purpose workflow's, since a real routing
  decision needs the same breadth of signal a senior engineer would look at). The
  enforcement mechanism (`assertToolAllowed`/`createGatedAppqDispatcher`) is shared
  from `@appliqation/agent-core`, same as every sibling agent. `enrich_project_context`
  is kept **out** of `READONLY_CONTEXT_TOOLS` on purpose — that set's whole guarantee is
  "no write capability under any argument," and this one tool has a write mode, so it
  needs the separate gate below instead of blending into a set that promises something
  it can't keep for this one entry.
- `PROJECT_CONTEXT_TOOL`/`createReadOnlyProjectContextDispatcher()` — the argument-level
  gate `enrich_project_context` needs, since tool-*name* allowlisting can't express
  "this tool, but only this argument value." Now lives in `@appliqation/agent-core`'s
  `tools/projectContext.ts` (promoted out of this repo once `appliqation-explorer`
  needed the identical guarantee), imported in `orchestrator/autopilot.ts` alongside the
  other agent-core imports. Same class of hardcoded, non-prompt-adjustable boundary as
  `destructiveActionGate.ts`'s click-verb check or `appliqation-scriptgen`'s
  `commandGate.ts` — allowlists the one safe shape (`action=read`) rather than
  denylisting the unsafe one, so a missing or malformed `action` is refused too, not
  just an explicit `"write"`.
- `src/cli/index.ts` — the `run` command. `--allow-pr` gates `run_pr_raise` (see
  above); `--policy <path>` overrides the bundled system prompt; exactly one of
  `--test-case-uuid <uuid>` / `--scenario-id <id>` / `--test-set-id <id>` is required
  (validated at the top of the action handler — prints an error and sets a non-zero
  exit code without ever calling `autopilot()` otherwise); project_id/scenario_id
  are never CLI inputs at all here — the model derives them itself from `get_scenario`
  during Phase 1 of its own reasoning, same as every write call downstream (`run_pr_raise`'s
  `project_id` arg comes from what the model read, not from anything this CLI resolves).
- `src/cli/audit.ts` — `recordAutopilotRun()`, extracted out of `cli/index.ts` for the
  same testability reason as `appliqation-autotest`'s `cli/resolvers.ts`. `outcome`
  includes `allowPr` alongside the usual `LoopResult` fields, plus a `scope` object
  (`testCaseUuid`/`scenarioId`/`testSetId`, whichever was given) — whether a PR was
  even authorized, and exactly what scope this invocation covered, are both part of
  the record.
- `src/config/env.ts` — appq connection (context tools only), LLM provider config, the
  six `*_CMD` sibling-invocation strings (including `healCmd`, default
  `appliqation-heal-selector`), budget, `POLICY_FILE`. `auditSink` resolves
  `AUDIT_MONGO_*`/`AUDIT_JSONL_PATH` via `@appliqation/agent-core/audit`'s
  `resolveAuditSink()` — opt-in, no-op when unconfigured.

## Commands

- `npm run dev -- run --test-case-uuid <uuid> --environment <name> --repo-path <path> [--allow-pr] [--policy <path>] [--json|--ci]`
- `npm run dev -- run --scenario-id <id> --environment <name> --repo-path <path> [--allow-pr] [...]` — or `--test-set-id <id>`; exactly one of the three scope flags is required.
- `npm run build` / `npm run typecheck`
- `npm test` / `npm run test:watch` — vitest, colocated `src/**/*.test.ts` files

## Config

Copy `.env.example` to `.env`. Requires `APPQ_API_KEY` and one of
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` (same credentials the other agents in this family
use). The six `*_CMD` vars need to actually resolve to something runnable — either
the real published sibling packages, or a local dev build path.

## Keeping this file current

When you add, remove, or rename a top-level file or a directory under `src/`, update
the map above in the same change. If you change the decision policy's substance, also
check the README's description of it stays accurate — external readers judge this
repo's sophistication by that file directly.
