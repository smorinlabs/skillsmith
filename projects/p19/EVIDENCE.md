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
