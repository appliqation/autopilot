# CLAUDE.md — appliqation-autopilot

Part of the Appliqation workspace. See `~/Sites/localhost/CLAUDE.md` for how the
product fits together; this file is the map of **this repo only**. **This repo is
meant to be published publicly on GitHub** (not yet done as of this writing) — see
"Public-repo constraints" below before adding anything.

## What this repo is

The top-level agentic orchestrator for the standalone-agent family. Given one test
case, it reasons over real signal (current pass/fail state, flakiness, linked defects,
coverage priority, whether automation already exists) to decide whether to run
autonomous testing (`appliqation-autotest`), fix a defect (`appliqation-defect-fix`),
generate new automation (`appliqation-scriptgen`), raise a PR for it
(`appliqation-pr-raise`), or take no action and just report a recommendation — a real
decision every invocation, not a fixed script.

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

The four sibling agents (`appliqation-autotest`/`appliqation-defect-fix`/
`appliqation-scriptgen`/`appliqation-pr-raise`) are the opposite: genuinely
self-contained, single-purpose, each does one thing well, and none of them know this
repo exists. That part of the "tools stay simple" principle is unchanged — only the
*orchestration judgment* moved client-side, not the individual capabilities. One real
consequence of this split for `run_defect_fix` specifically: `appliqation-defect-fix`
itself has no way to know how much testing a given fix warrants (it only sees one
defect in isolation) — that judgment genuinely belongs here, where the broader signal
(defect_history, run_context) is already being gathered anyway. See
`src/policy/systemPrompt.ts`'s Phase 2 for how it's required to compose that
instruction, not just decide whether to call the tool.

## Public-repo constraints

- **No filesystem or private-npm dependencies on the sibling repos.** They're invoked
  as configurable command strings (`AUTOTEST_CMD`/`SCRIPTGEN_CMD`/`PR_RAISE_CMD`/
  `DEFECT_FIX_CMD`, see `src/config/env.ts`), spawned via `child_process.execFile`,
  never imported. An external clone with no access to
  `~/Sites/localhost/appliqation-autotest/` etc. still works once the sibling packages
  are published to npm (defaults assume they're on PATH) or if the user points the env
  vars at wherever they've built them.
- **`package.json`'s `@appliqation/agent-core` dependency is currently `file:../appliqation-agent-core`
  because that package isn't published yet either — this MUST become a real npm version
  pin (e.g. `^0.1.0`) before this repo is actually pushed publicly**, or an external
  clone's `npm install` will fail outright. Flagging this explicitly rather than letting
  it slip — check this before any real `git push` to a public remote.
- **No secrets, ever.** `.env` is gitignored; `.env.example` documents every var with no
  real values. Nothing in `src/` should reference a real appq origin, API key, or token.
- **README.md is the primary audience-facing doc, not this file.** Keep this file
  (CLAUDE.md) for future Claude Code sessions working in the repo; keep README.md
  written for an external engineer/prospective customer evaluating the code.
- The README currently links the three sibling repos as `(#)` placeholders since they
  aren't public yet — fix those to real URLs once they are, in the same change that
  actually publishes those repos.

## Where to find what

- `src/policy/systemPrompt.ts` — **the actual customization point.** `buildSystemPrompt(allowPr)`
  is the full decision methodology: context-gathering priorities (current state first,
  then flakiness/defects/coverage/quality), the decision rules (no evidence → judge
  first; failing → don't generate; passing + no canonical → generate; flaky → generate
  with lower confidence; low-priority → recommend and stop, that's a legitimate
  outcome), the adaptive-execution discipline (re-check every real result, never
  execute a plan blindly), and the report structure (every claim must cite a real tool
  result). Read this file before touching anything else — it's the actual "brain",
  everything else is mechanism around it.
- `src/orchestrator/autopilot.ts` — `autopilot()`: builds the tool palette (context
  tools + meta-tools), builds the seed message, and calls `runLoop()` **directly** from
  `@appliqation/agent-core/engine` — not `runWorkflow()`'s appq-prompt-fetch path, since
  there's nothing to fetch; the system prompt is always local (bundled default or
  `--policy` override).
- `src/tools/metaTools.ts` — `run_judge`/`run_generate`/`run_defect_fix`/`run_pr_raise`
  as `LlmToolDef`s + a dispatcher. Each spawns the configured sibling command with its
  real CLI flags plus `--json`, and returns the sibling's actual structured output as
  the tool result — including on failure (a failed/blocked judge, an unverified
  generate/defect-fix), recovered from stdout even though the process exits non-zero,
  since every sibling CLI prints its `--json` summary before setting its exit code.
  `run_defect_fix`'s schema marks `test_instruction` **required** — the model must
  state, from its own gathered evidence, what testing scope the fix needs verified (see
  the policy's Phase 2); it's always offered regardless of `allowPr`, since this agent
  never touches git/GitHub. `metaToolDefs()`'s `run_pr_raise` entry is only present in
  the returned array when `allowPr` is true — a hardcoded exclusion from what's offered
  to the model, not a runtime check the model could work around.
- `src/tools/safety.ts` — `READONLY_CONTEXT_TOOLS`, this agent's own read-only appq
  tool allowlist (broader than a single-purpose workflow's, since a real routing
  decision needs the same breadth of signal a senior engineer would look at). The
  enforcement mechanism (`assertToolAllowed`/`createGatedAppqDispatcher`) is shared
  from `@appliqation/agent-core`, same as every sibling agent.
- `src/cli/index.ts` — the `run` command. `--allow-pr` gates `run_pr_raise` (see
  above); `--policy <path>` overrides the bundled system prompt; project_id/scenario_id
  are never CLI inputs at all here — the model derives them itself from `get_scenario`
  during Phase 1 of its own reasoning, same as every write call downstream (`run_pr_raise`'s
  `project_id` arg comes from what the model read, not from anything this CLI resolves).
- `src/config/env.ts` — appq connection (context tools only), LLM provider config, the
  three `*_CMD` sibling-invocation strings, budget, `POLICY_FILE`.

## Commands

- `npm run dev -- run --test-case-uuid <uuid> --environment <name> --repo-path <path> [--allow-pr] [--policy <path>] [--json|--ci]`
- `npm run build` / `npm run typecheck`
- `npm test` / `npm run test:watch` — vitest, colocated `src/**/*.test.ts` files

## Config

Copy `.env.example` to `.env`. Requires `APPQ_API_KEY` and one of
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` (same credentials the other agents in this family
use). The four `*_CMD` vars need to actually resolve to something runnable — either
the real published sibling packages, or a local dev build path.

## Keeping this file current

When you add, remove, or rename a top-level file or a directory under `src/`, update
the map above in the same change. If you change the decision policy's substance, also
check the README's description of it stays accurate — external readers judge this
repo's sophistication by that file directly.
