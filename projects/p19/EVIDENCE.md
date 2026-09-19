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

## 2026-09-15 — security gate and bounded investigation

- Maintenance product commit: 3dd85a0; full check on its exact code tree (before the security
  patch): 1,042 pass, 28 existing opt-in live skips, 0 fail, 4,819 assertions, 128 files.
  Staged secrets scan and commit hooks passed. First commit attempt was refused for an overlong
  footer; corrected the message and confirmed the commit landed.
- Ordinary `bun audit --audit-level=high` found 11 high advisories on main's dependency tree
  and 6 on P17's: parser/tooling maintenance, now P19-T15 / #65. Verified primary GitHub
  advisories for smol-toml, fast-uri, js-yaml and brace-expansion. Raised compatible floors to
  smol-toml 1.7.1, fast-uri 3.1.6, js-yaml 3.15.2 (3.x retained), brace-expansion 5.0.9.
  Main resolves fast-uri 3.1.8, brace-expansion 5.0.12; P17 keeps its already-patched brace
  version. Both fresh audits report no vulnerabilities. Lock regeneration also repairs main's
  stale workspace metadata from 0.5.0 to its already-existing 0.7.0 package versions; no
  Skillsmith manifest version was bumped, and no release was created.
- A bounded child loading the original 5a74185 config parser with malformed TOML `a=[1 #`
  exceeded 1 second and was terminated (137). With smol-toml 1.7.1 both array and inline-table
  unterminated-comment fixtures return config-error normally. Main config suite: 33 pass/62
  assertions; P17 config suite: 65 pass/248 assertions.
- P19-T11 bounded Bun isolate diagnosis: 29 tests/3 files and expanded 129 tests/17 files
  both pass with --isolate --no-orphans under 30s/45s external limits. Historical epoll_ctl
  failure not reproduced; no ownership/upstream-fix conclusion. #57 remains open for the
  original selector/environment or a minimal reproducer. Accepted serial runner unchanged.

## 2026-09-15 — affected-line carry-forward and historical reconciliation

- Created agent/p19-p17-fixes at /work/skillsmith-p19-carryforward from exact 5a74185,
  preserving the original worktree/branch. Copied regressions before production changes:
  69 pass/44 fail across 10 files. Nine failures were test-porting issues (list@3 uses entries,
  and project scope needs a real project context), not P17 output truncation. Corrected those
  fixtures without weakening expectations. After adaptation, large output passes all 6 source/
  compiled sink cases with no root exit change. Duplicate CLI controls pass 3/3.
- P17 deep loading now uses VerifyPorts and the existing native process authority in
  ports/default.ts; binary Git process handling remains untouched. Generic doctor consumes
  readSkillInventory collision groups. Its Codex-managed entry predicate stays in the Codex
  placement adapter with a validated optional extension point. Focused doctor/scan/placement:
  43 pass/99 assertions. Core/CLI typecheck and boundaries pass.
- P17 smoke: 5 pass, 14 deliberately unselected families, 0 fail, 3,737 assertions. Live P17
  bare-skill --tool codex --deep --json: exit 0, both modes ran, summary pass. P17 local
  actionlint and structural package check pass; original 43/44 groups, 415/419 required
  entities, G6-04 5/10 and final pending statuses remain unchanged.
- P13-T06 split is recorded in PROJECTS.md and #63/#55. Current downstream tree
  smorinlabs/smorinlabs-harness at c415a054c18849c87b0ba81f0bb55ea6feb9083a has no skill-create
  path. Current owner or historical wiring/proof must be supplied before downstream changes;
  no such work is claimed done. P13's shipped code/migration remain complete.
- PR #7 reports final whole-branch READY TO MERGE and reviews of all ten P09 tasks. Its
  standalone original fable receipt was not found; leave P09-RV unchecked with #60 for receipt
  or owner confirmation. This is historical reconciliation, not fresh independent review.
- P18 remains an idea; corrected its premise with existing claude plugin validate source
  evidence. Completed SPR-GOAL-01/SPR-P1..P4 and PK-EX-PHASE-001 (version 24) remain complete;
  their repositories were read only and not changed.

## 2026-09-15 — review preparation and ordinary-gate findings

- Main candidate 27524370b95b49b7001e7237bdb18912820e86c6: frozen install, full check,
  full secrets scan, high-severity audit and security lint all passed. 1,044 pass, 28 existing
  live skips, 0 fail, 4,827 assertions, 129 files. Pushed using the documented --no-verify
  hook workaround only after manual gates, and opened PR #66. GitHub Linux/macOS build-test,
  PR-title lint and commitlint passed. CodeRabbit Free supplies a summary, not a comprehensive
  code review; do not count its green status as independent approval.
- P17 carry-forward first committed as e960b2cfefe043d8f04d045fd7907870746738cb. First
  `bun run check` could not start because just was missing. Downloaded CI-pinned just 1.50.0
  to an owned temporary directory; verified its release-asset SHA-256
  3beb4967ce05883cf09ac12d6d128166eb4c6d0b03eff74b61018a6880655d7d. No global tool change.
- The canonical P17 gate then reached file 32/370 and failed six doctor contract cases due
  to real inherited Codex installations. A SIGINT sent to the owned just process during a
  separate edge-case inspection did not stop the run; it ended on the actual test failure,
  not on a green or waived gate. Pair-equivalence also fails on untouched 5a74185, proving
  the fixture problem predates the carry-forward. Tracked as P19-T16 / #67.
- Corrected doctor fixture PATH and added an explicit fixture-only Codex presence control;
  isolated filesystem/search-path facts for the affected in-process resolver test as well.
  Exact findings, repair and human-output assertions are unchanged. The six failing cases
  now pass targeted replays. Full owner and terminal replays remain to be recorded.
- Self-inspection found that P17's new managed-marker predicate could inspect a child path
  under an ordinary file and raise ENOTDIR. A real-file/link regression failed first, then
  passed after checking the resolved entry is a directory. Existing managed/mixed cases
  retain their expectations. This correction is part of #40, not a release task.
- Requested authority for a separate read-only Codex review; no response yet. No independent
  review or merge is claimed, and all product issues remain open pending verified closeout.

## 2026-09-15 — review findings and protocol-fixture repair

- Main 8623165b5406b4c6c5216da4894eaedb7c78bfe2 also passed the complete manual
  check/secrets/audit/security gate: 1,044 pass, 28 existing live skips, 0 fail,
  4,827 assertions, 129 files. GitHub Linux/macOS CI passed that head.
- Copilot returned a COMMENTED, changes-recommended review of PR #66. This is useful
  independent feedback, not the required fresh Codex adversarial sign-off. Reproduced and
  corrected all-error human summaries, misleading "passed" wording for warned tools,
  inherited deep-loader XDG paths and main's duplicate grouping before scope/enablement
  selection. Added regression coverage and corrected current main command documentation.
- P17's canonical inventory already bounds collisions by tool/scope and deliberately keeps
  full-context visibility metadata through display filters. Preserve that architecture and
  its same-scope multi-root conflicts; do not port main's older cross-scope-only projection
  into it. Historical research pages now explicitly link to the corrected current behavior.
- P17 ordinary gate at be2297c passed all static checks and the 63-case doctor contract, then
  failed EWP-CMD-UPDATE-TS05 in file 46/370 (19 pass/1 fail in that owner). No full-suite
  pass or subsequent chained security gate is claimed for that attempt.
- The update fixture still simulated the old Codex exec/401 path. A direct fixture-backed
  verify showed static=error, deep=pass after the initial protocol fixture correction:
  the new aggregation correctly exposed the fixture's missing static success responses.
  Added bounded local initialization/skills/list fixture dispatch, shared with undo, and
  explicit supported static plugin responses to update. Production verification and the
  original update assertions remain unchanged. EWP-CMD-UPDATE-TS05 now passes (23
  assertions); the corrected P17 renderer/deep owners pass 35 tests; smoke passes 5
  selected families/3,737 assertions. Main's three focused owners pass 40 tests.
- P14-RV final release review and Release-As bookkeeping are explicitly owned by PUB-01
  before candidate selection; final release handoff remains PUB-07. No version was bumped.
- P17 pull-request CI runs a Candidate-cask macOS qualification even for draft PRs. That
  is deferred pre-publication work: archive the carry-forward branch after ordinary gates,
  but do not open a PR that silently launches it. A product-only CI separation or explicit
  scope decision is required; ordinary CI has not been disabled or weakened.

## 2026-09-15 — exact main result and inherited-home verification fixture

- Main code head 9ead9eca4215aebabd2409d15834620c8a8fa233 passed frozen install,
  full check, full secrets scan, high-severity audit and security lint: 1,047 passed,
  28 existing live skips, 0 failed, 4,971 assertions across 129 files. GitHub Linux
  and macOS build-test plus title/commit lint passed that exact head.
- P17 code head d0ea2f4fd2548836445f03c745bb9e543fd07152 passed static checks,
  the complete doctor and update contracts, then failed verify TS04 at file 47/370
  (14 pass/1 fail). The same selector fails on untouched 5a74185: 0 pass/1 fail,
  expected exit 4, actual 0. Empty PATH did not isolate the inherited user's
  well-known Codex installation under HOME. No full terminal pass is claimed.
- Added fixture-owned HOME, XDG config/data/cache and tool configuration paths,
  retaining the original CLI invocation, exit-4, JSON target and empty-stderr
  assertions. The full verification owner now passes 15 tests/80 assertions;
  ordinary smoke passes 5 selected families/3,737 assertions. This extends
  P19-T16/#67 to the same inherited-environment bug in doctor and verify fixtures.
- REVIEW.md records stable P19-RV-F01..F10 dispositions. The preserved P17 catalog
  records historical checkpoint sign-offs, not fresh approval of the P19 delta.
- Checked the P19 task graph: 16 tasks, 20 unique issue owners, 9 publication nodes,
  no dependency cycles or missing targets; all 20 corresponding GitHub issues are
  open. P19 Markdown local-file references resolve.
- Fresh remote check: release-please disabled_manually; ordinary CI active; #34 and
  #44 draft/open with no auto-merge; #44 still at 5a74185. Main is still 9c0219f;
  the repository remains private. Original P17 worktree remains clean and unchanged.

## 2026-09-15 — diagnostic remainder and final-gate preparation

- Main administrative checkpoint 38baccce45d5600bd17012f983c340ea615fb2f3 passed
  full check/secrets/audit/security lint and GitHub Linux/macOS CI with the same
  1,047 pass / 28 existing live skips / 0 fail / 4,971 assertions.
- P17 3864d3e34d4d7e8b0a932f809789f842c15972a3 passed the corrected verify
  contract, then failed the help expectation at file 48/370 (9 pass/1 fail).
  This P19-introduced stale assertion still expected "cross-scope duplicates".
  Commit 08719851938d4bec06fac72f5e5e3cb6b7c563a3 retains an exact semantic
  expectation for "same-tool placement conflicts", allowing terminal line wrapping.
  Full help owner: 10 pass/85 assertions; ordinary smoke: 5 pass/3,737 assertions.
- Ran the remaining 322 tracked files diagnostically at 0871985, in fresh serial
  processes with the canonical per-file command, timeout/concurrency/orphan/retry
  flags and exact per-file skip allowlist. Continued after failures to collect all
  remaining findings; this is explicitly NOT the canonical full-gate receipt.
  Result: 2,859 pass, 8 existing live skips, 1 fail; 100,823 assertions. The sole
  failure was scripts/check-p17-package-output.test.ts, whose literal link count
  predated the two P19 backlinks (23 versus 25). All other 321 files passed.
  Manifest SHA-256: bb0c3d601779accad270a2c3263128ba5ea723c8d74081ec6171c71a583e2d1c.
  Diagnostic JUnit retained at /tmp/skillsmith-p19-diagnostic-IbTYUd.
- Corrected only the checker test's expected link count; production checker,
  catalog counts, lifecycle gates and final-pending states are unchanged.
  Checker-output owner: 3 pass/25 assertions; smoke: 5 pass/3,737 assertions.
  Also removed P17's stale unconditional pipe-truncation workaround, reflecting
  its already-safe entrypoint and the new source/compiled output regressions.
- P17 full-history secrets scan: 893 commits, no leaks. Fresh dependency audit:
  no vulnerabilities. An initial security-lint invocation omitted P17's required
  suppression-location argument and reported its 37 already-reviewed baseline
  findings. The exact hook command with --suppressions-location
  eslint-security-suppressions.json passes. Both that file and the security
  configuration are byte-for-byte unchanged from 5a74185; no new suppression or
  pass-on-unpruned override was introduced. G6-01 documents the reviewed baseline.
- Full terminal validation still must be replayed at a clean final checkpoint.
  Fresh independent Codex review and affected-line integration remain pending.
  Final P19 receipts will be linked from tracking issue #51; branch-local evidence
  is an append-only snapshot, not an implied later approval.

## 2026-09-15 — Q2 execution and independent review corrections

- Direction is recorded separately from execution:
  [Q1.A](https://github.com/smorinlabs/skillsmith/issues/41#issuecomment-5689778855)
  keeps per-tool conflicts and puts informational cross-tool reporting in a separate PR;
  [Q2.A](https://github.com/smorinlabs/skillsmith/issues/51#issuecomment-5689864463)
  approves narrowly separating release qualification from automatic product PR CI and opening
  the maintenance PR into `agent/p17-execution`. #41 stays open; #44 stays draft.
- P17 CI-only `ffd1cbaec2f3380fea51055ca46888b9f1c43ccf` retains canonical ordinary
  checks, PR-title validation and all three native build/smoke lanes. Only Candidate-cask
  qualification and its dedicated setup move to the guarded manual release workflow.
  TS06: 11 pass / 197 assertions; TS01 family 10: 1 pass / 19 assertions; smoke:
  5 pass / 3,737 assertions. Type-checking, actionlint and commit hooks pass.
  Independent read-only review approved the exact CI commit. No workflow dispatch,
  candidate qualification, publication or release-gate completion is claimed.
- F13/F14 source corrections: main `5adb299b29c31011b12c9341ea5a789b16d6aba6`;
  P17 F13-F16 corrections: `b33c2249a4a1709497020001540662e87b68995d`.
  The previous transport exceeded a 200 ms deadline by waiting roughly 2.5 seconds
  for a self-expiring descendant. Owned process-group termination, reader cancellation
  and bounded cleanup now return promptly. A reviewer independently measured 110 ms
  against a 100 ms deadline. Linux/macOS process-group ownership is intended; Windows
  process-tree parity is not asserted.
- Exact-target artifact failures previously became inconclusive after nonzero shutdown.
  New regressions first failed, then pass for exit, timeout and stream error, retaining
  sanitized diagnostics. Successful-looking abnormal results remain inconclusive.
  Invalid initialization/order/ID/error-field transcripts cannot establish artifact failure.
  P17 cancellation now reaches the existing runVerify boundary and removes temporary staging.
- F16 uses a test-only preload shared by init, doctor and verify. Synthetic global
  Codex paths are discovered without isolation and excluded with it; trace assertions
  prove the real CLI fixture uses the preload. Production discovery, host tools and
  original CLI result/repair assertions are unchanged. Main focused owners: 41 pass;
  P17 five affected owners: 144 pass / 1,513 assertions in 40.67 seconds.
  Type-checking and affected-source ESLint passed on both branches.
- Review caught F17, a new test startup race. A first readiness-window correction
  passed isolated runs but failed overlapping runs (including 39 pass / 2 fail in review);
  it was not accepted as reliable. Final correction is main
  `27c67e9adc6818949342ac540aa0dbd312ae4496` / P17
  `01d09a98fcfa1fa47017fb2096b085f5661176a5`: atomic heartbeat, bounded child readiness,
  synchronous restoration of a narrowly captured deadline timer, retained real watchdog,
  explicit exited-launcher proof and unchanged separate real-clock deadline test.
  Final independent main replay: 41 pass / 0 fail / 721 assertions, 948 ms.
  P17 transport replay: 12 pass / 0 fail / 32 assertions, 773 ms.
  Independent review approved the final equivalent fixture changes on both branches.
- Independent source review found no remaining blocking correction. P17 reviewer also
  ran 59 focused tests / 826 assertions with no failures before the final fixture
  correction. Execution evidence is Linux/Bun 1.3.14; macOS remains a remote CI obligation.
- These are focused review receipts, not a replacement for exact-head full gates.
  The next clean administrative heads must pass ordinary/security checks before the
  authorized pushes. Preserve old complete-gate receipts as history. Live integration
  and issue-closure receipts are recorded on [P19 #51](https://github.com/smorinlabs/skillsmith/issues/51).
  No issue is auto-closed; PUB-00..08 and original P17 release completion remain pending.
