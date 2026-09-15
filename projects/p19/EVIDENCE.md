# P19 execution evidence

## 2026-09-15 — authorization and baseline

The user requested the full reviewed plan be recorded as a PROJECT with tasks, then implemented.
No publication or pre-publication execution was authorized; tracking and the release hold are in scope.

Read repository AGENTS.md/CLAUDE.md and the P17 goal/phase boundary. The referenced project-harness
skill is not installed; applied its documented project/trunk/back-reference conventions directly.

- Preserved P17 worktree: /work/skillsmith, agent/p17-execution,
  5a7418593ecf6a8be4b10d8a5f657bb9e4f0e402, initially clean.
- Verified remote main: 9c0219f69888239ef5d2cab9ddea4a4683b14a48.
  Fetched origin; stale local origin/main advanced from 48b8fab.
- Created /work/skillsmith-bug-closeout, agent/p19-bug-closeout, from that remote main.
- PR #44 is draft, open, no auto-merge. Release PR #34 is open, initially ready, no auto-merge.
- Release-please workflow 265791659 initially active; ordinary CI 265791658 active.
  Recent release-please and main CI runs completed; no active publishing run was observed.
- Existing bug issues #40, #41, #46 are open. September 7 diagnosis is documentation, not a fix.
- Asked for clarification of #41 cross-tool repeated names vs P17 per-tool conflict semantics;
  proceed with other work while that optional answer is pending.
- No code tests or fixes have yet been performed in this project.

Subsequent sections append exact mutations, tests and disposition. Intended work in the plan is
not evidence that it happened.

## 2026-09-15 — release hold and issue creation

- Ran `gh workflow disable release-please.yml`: workflow 265791659 verified
  `disabled_manually`; ordinary CI 265791658 verified `active`.
- Ran `gh pr ready 34 --undo`: PR #34 verified draft, autoMergeRequest null.
  Restoration, only after future explicit publication direction: enable release-please and
  reassess whether to mark the release PR ready. No source workflow/check was removed.
- Created P19 #51; PUB-00 #53; PUB-01 #52; PUB-02 #50; PUB-03 #56; PUB-04 #54;
  PUB-05 #58; PUB-06 #59; PUB-07 #62; PUB-08 #55.
- Created aggregation bug #61, deep-loader bug #64, Bun follow-up #57,
  P13 wiring reconciliation #63 and P09 review reconciliation #60.
- Updated all new issue bodies with actual linked blocked-by/blocks/related IDs. The registry
  preserves descriptions and immutable P17 plan/evidence/catalog URLs. Deferred issues stay open.
- Added P17 project/goal pause navigation on the maintenance branch; no catalog gate changed.
- Bun 1.3.14 verified; `bun install --frozen-lockfile` succeeded (666 packages), no lockfile change.
- OpenAI Docs skill used for local-loader protocol research; official app-server page fetched
  at https://learn.chatgpt.com/docs/app-server (redirect from developers.openai.com).

## 2026-09-15 — aggregation red/green and administrative validation

- Initial P17 package check caught that adding Tracking labels to its References block violates
  its exact-label contract. Moved the new navigation into prose; did not weaken the validator.
  `bun scripts/check-p17-package.ts --pr-openable` then passed: maintenance preparation snapshot
  has 425 entities/418 required/7 deferred, distinct from the executed P17 checkpoint.
- Added aggregation/selection/exit regressions and ran the three focused files before code:
  41 passed, 7 failed, 96 assertions. Failures reproduced both rollup levels, null verdict,
  explicitly unavailable tools, and the partial-static CLI exit mismatch.
- Corrected per-tool and report aggregation; threaded explicit selection through runVerify;
  inconclusive summaries now exit 4. Genuine failures retain priority; optional absent tools
  remain best-effort. No report schema field or dependency changed.
- Focused/impacted run of normalize, runVerify, CLI verify, both verify renderers and both
  agents' static/deep suites: 107 passed, 0 failed, 338 assertions across 9 files.
  This is local green only; carry-forward, merge gates and review are still pending.

## 2026-09-15 — maintenance product regressions and live controls

- #46: large JSON reproduction failed with a slow pipe before changing the root CLI exit.
  Replaced forced normal completion with `process.exitCode`. The regression now exercises
  320 Unicode descriptions (over 1 MiB) through normal pipes, slow consumers and files, in
  both source and native compiled binaries: 6 passed. This does not rewrite every legacy
  command-specific exit path. Removed the now-stale unconditional workaround from CLAUDE.md.
- #40: managed system marker fixtures reproduced two false legacy warnings (9 pass/2 fail).
  Ignore marker metadata and marked child directories, but still warn for mixed user content
  and unmarked hidden directories. Focused doctor checks: 16 pass/0 fail.
- #64: replaced the unauthenticated model-session heuristic with a local app-server exchange:
  initialize response, initialized notification, then skills/list with forceReload. A batch
  stdin probe exited cleanly without a skills/list response, so positive handshake completion
  is required. No model/tool turn is sent. Exact canonical staged paths must be enabled or
  have structured target load failures; missing/disabled/unrelated targets cannot prove pass.
- Transport regressions cover early EOF, delayed initialization, malformed/mismatched/error
  replies, bounded output, timeout and cancellation: initially 8 failed; now 8 passed.
  Static/deep adapter suite after the change: 29 pass/0 fail. Error diagnostics are bounded,
  sanitize common credential forms and temporary paths, and appear in both human and JSON
  results. Human error/partial-summary regression initially failed; now passes.
- Live Codex 0.154.0, Bun 1.3.14: isolated deep adapter on dummytest reported exactly the three
  deliberately invalid fixture skills, with skills coverage true. The real CLI on bare-skill
  with --tool codex --deep --json exited 0, both modes ran, summary pass and deep skills
  coverage true. Existing verifiedAgainst 0.142.5 remains unchanged; version drift is reported.
  Neither control invoked a model turn or required user credentials.
- #41: retained the approved default of per-tool conflicts, while the optional cross-tool
  question remains unanswered. Tests exposed name-only grouping across independent tools in
  both list and doctor. Groups are now keyed by tool/name. Added truthful duplicate/filter
  empty states, and CLI controls for populated no-conflict inventory, user/project conflict,
  active filters and cross-tool name reuse. Focused CLI plus deep suite: 21 pass/0 fail.
- Full maintenance `bun run check` after the five implementations: 1,039 pass, 28 existing
  opt-in live skips, 0 fail, 4,794 assertions across 127 files. Biome, boundaries, TypeScript,
  actionlint and the maintenance P17 package preparation check passed. Three CLI inventory
  controls were added afterward and passed separately; final immutable-commit gates remain
  to be recorded. No dependency/lockfile, report schema field, release version or gate was changed.

Product tasks remain in progress until affected-line carry-forward, review and integration.
