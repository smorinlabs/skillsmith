# P19 execution plan — product bugs and publication deferral

**Project:** [P19](../../../projects/P19-product-bug-closeout-and-publication-deferral.md)
**Authorization:** User's 2026-09-15 instruction to record the reviewed plan, create tasks and implement.
**Evidence:** [P19 execution record](../../../projects/p19/EVIDENCE.md)

## 1. Boundary and starting state

Skillsmith is an agent-skill management CLI. Reliability work uses hermetic/local fixtures and
bounded subprocesses, not real secrets, model turns, installed-skill mutation or destructive testing.

- Preserve P17 at full SHA `5a7418593ecf6a8be4b10d8a5f657bb9e4f0e402`; PR #44 remains draft.
- Maintenance base is remote main `9c0219f69888239ef5d2cab9ddea4a4683b14a48`.
  Fetch remote references before branching: local origin/main was stale at `48b8fab`.
- Original P17 worktree remains at /work/skillsmith. Maintenance work uses the separate
  /work/skillsmith-bug-closeout worktree and agent/p19-bug-closeout branch.
- At the preserved checkpoint, 43/44 required groups and 415/419 required entities are signed.
  P17-G6-04 has five of ten gates passed. D-016, EWP-P6-T07, EWP-P6-TS06 and EWP-WF01 remain
  unfinished; Phase 6 remains active, Phase 7 deferred, and original P17 completion pending.
- Current main carries older P17 preparation records. Never overwrite checkpoint execution
  history with those older records or present the maintenance branch's catalog as the executed
  branch's current rollup.
- Existing open bug issues: #40, #41 and #46. The September 7 Codex diagnosis adds two unimplemented
  defects, not another completed fix. Older G6-04 mapping failures are historical and not
  automatically current implementation gaps.
- Main's release-please workflow runs on push. Existing release PR #34 must not advance.
  Before any main merge disable only release-please, mark its PR draft, confirm no auto-merge
  or active publishing run, and retain ordinary CI. Record original states and restoration steps.
  This hold is a maintenance safety control, not authorization to resume publication.

Runtime correctness, truthful CLI/library reports and ordinary development reliability are active.
Release-specific integration, packaging, signing, credentials, external setup, release docs,
release qualification, visibility changes and publication are deferred. File names and historical
phase labels do not classify a bug. If a shared release/ordinary check blocks bug validation,
record the dependency and choose a narrow correction without skipping or falsifying that check.

## 2. Issue ownership and deferral graph

All keys below are internal stable keys; record actual GitHub issue numbers in tasks.json.

| Key | Scope | Original IDs |
| --- | --- | --- |
| PUB-00 | Umbrella, unfinished entities, resumption checklist | P17 Phase 6; P17-G6-04; D-016; EWP-P6-T07; EWP-P6-TS06; EWP-WF01; P14 |
| PUB-01 | Release integration; ShellCheck/actionlint parity and workflow findings; architecture-sensitive Homebrew tests; release docs, final release review and version bookkeeping | EWP-P6-T07; EWP-P6-TS06; P14-T02; P14-T04; P14-RV; PR #44; CI run 31238776150 |
| PUB-02 | Public-exposure audit/remediation covering final source and external repository surfaces; explicit visibility approval and flip | P14-T01; G6-04 external readiness |
| PUB-03 | Protected environments; least-privilege Apps; Apple signing/notarization; runner readiness; immutable releases; npm scope authority | G6-04 external readiness |
| PUB-04 | First-publication npm amendment/design/implementation; phase-aware preflights; token retirement/trusted-publisher transition; exact-candidate recovery | G6-04 open npm amendment |
| PUB-05 | Reviewed Homebrew cask/tap CI on both macOS architectures | G6-01; G6-04; P14-T03 |
| PUB-06 | Exact approved source/tag; build/sign/notarize once; native validation; all-authority preflights; GitHub/npm/tap publication; public install/orientation | D-016; EWP-P6-TS06; EWP-WF01; P14-T02/T03; P14-RV |
| PUB-07 | Remaining G6-04 gates; whole-Phase-6/final P17 review and traceability; P14 reconciliation/handoff | P17-T07; P17-TS02 |
| PUB-08 | P13-T06 downstream release and release-only preparation | P13-T06; separate wiring and real-skill rewire proof |

PUB-01..05 are prerequisites for PUB-06, along with accepted fixes incorporated into the final
release source. PUB-07 depends on successful PUB-06. Preparatory tasks have no invented serial
dependencies: final PUB-02 evidence must cover the chosen integrated source even if initial audit
work starts earlier. PUB-03 does not require configuring trusted publishers on nonexistent
packages. PUB-04 designs and obtains authorization for bootstrap; PUB-06 executes it only after
candidate validation. G6-01 is a satisfied historical dependency, not work to repeat.

Preserve the approved release graph unless separately amended: exact tag/recovery guard →
candidate/retained-candidate restore → common and four native credential-free checks →
aggregate receipt → GitHub/npm/tap authority checks → publication-ready aggregate →
GitHub publication, followed by npm publication and tap PR. All channels and public EWP-WF01
must complete for release sign-off. Recovery uses the same approved source and candidate bytes;
no retry rebuild/resign/restage or subset-channel success claim.

PUB-04's credential design remains an open decision. Revalidate npm's supported interfaces when
resuming; do not mint credentials, bootstrap packages or treat issue creation as approval of a
specific credential amendment. PUB-03 records missing external readiness without assuming the
historical billing problem still exists. PUB-05 uses the approved cask design, retaining P14's old
“formula” wording only as history. PUB-08 is related cross-project work, not an invented blocker
of Skillsmith publication; establish its owning repository before any downstream changes.

Issue bodies contain immutable plan/evidence/catalog links, original IDs/phases, implemented vs
remaining scope, blocked-by/blocks/related links, acceptance criteria, outstanding authorizations,
actual decision/creation dates, and a resume entry point. Do not close deferred issues, reset
signed history, edit generated checklists manually, or mark P14 complete merely by transfer.

## 3. Active product bugs and acceptance

### P19-T05 / BUG-VERIFY-SUMMARY

Correct both tool aggregation and overall summary. Static pass plus required deep error is
inconclusive, never pass. A different passing tool cannot hide missing required coverage. Actual
artifact failure wins over incomplete coverage. Explicit unavailable tools and optional absent tools
retain their documented distinction. Align JSON, human output and CLI exit codes without
inventing a new report schema. Cover mixed modes/tools, errors, skipped modes, explicit selection,
optional absence and actual failure. Map P17-G1-05 / COMMAND:verify / EWP-CMD-VERIFY-TS01..04 /
EWP-P1-TS09.

### P19-T06 / #46

Reproduce >64 KiB output using real CLI processes, slow pipe consumers, file redirection and a
compiled native binary. Include the reported macOS execution path through normal CI where
available. Capture exact executable/build SHA/Bun version. Truncation/early-exit is a hypothesis
until measured. Fix the smallest owning layer and assert complete parseable JSON and no stderr
contamination; preserve existing schema/newline contracts. Map shared CLI IO and list contracts
under P17-G1-03 / P17-G3A-02 and EWP-CMD-LIST-TS01..07 as affected. #41 owns the overlapping
duplicate-reporting symptom; #46 cannot falsely close with that symptom unresolved or untransferred.

### P19-T07 / BUG-CODEX-DEEP

The current adapter invokes codex exec and infers loading from exit/parsed stderr/401. The
recorded network failure and dropped diagnostics show an unimplemented verifier defect.
Inspect local Codex capabilities and primary documentation before choosing the supported local
loader protocol. The app-server skills/list prototype is not production code or universal version
proof. Use bounded protocol initialization, requests, deadlines, cancellation and cleanup;
match exact canonical staged target paths, not unrelated discovered skills. Cover valid/invalid,
disabled/missing targets, malformed/unsupported responses, early exit, timeout, cancellation,
unrelated discoveries and sanitized bounded diagnostics. No model turn/auth workaround/network
request is a success signal. Update help and affected docs. Map P17-G1-05 and verify contracts.

### P19-T08 / #41

Compare identical source inventory and selection for JSON/human/duplicates/doctor. Test same
name across scopes within one tool, allowed cross-tool name reuse, realpath aliases, zero
inventory and zero matches. The user confirmed per-tool conflict semantics with informational
cross-tool name reporting. Under [Q1.A (2026-09-15)](https://github.com/smorinlabs/skillsmith/issues/41#issuecomment-5689778855),
deliver the informational report in a separate follow-up PR, not PR #66. Keep #41 open until
the report, regression coverage, documentation, review and affected-line integration are done.
No new flag name or JSON schema was selected by this scope decision.
Do not claim populated inventory proves duplicates, silently change precedence or fix wording
alone while known inventory defects remain. Empty filtered output must describe no matches,
not claim nothing is installed. Map P17-G3A-02 / P1-03 / EWP-CMD-LIST-TS01..07 /
EWP-P3A-TS03 and affected doctor contracts.

### P19-T09 / #40

Ignore Codex-managed marker-protected system entries when detecting deprecated user paths.
System-only is clean; system plus real legacy user skill still warns; unprotected genuine user
skills must not disappear through a blanket hidden-directory filter. No migration/deletion.
Map P17-G3B-03 / COMMAND:doctor / EWP-CMD-DOCTOR-TS01..06 / EWP-P3B-TS04.

## 4. Execution and validation

Execute inventory/project/hold/issue tasks before code. Preferred product order: aggregation,
large output, deep loader, duplicate reporting, managed legacy directories. Independent diagnosis
does not relax dependencies or authorize concurrent edits. Each task is sized for separate review.

For each bug: reproduce on main and P17; write failing regression; implement minimal fix; run
focused tests and branch-specific smoke; inspect/refactor; validate affected commands/contracts;
carry the fix to every affected maintained line; review and correct findings. Record exact
commands, outcomes, skips, SHAs and resulting issue/PR links. Do not bulk-merge P17 for these fixes.
Use a separate P17 maintenance branch/worktree for adapted fixes, preserving original 5a74185.

Main currently uses bun run check and has no P17 test:smoke script. Follow each branch's actual
commands. P17 uses focused tests plus bun run test:smoke for ordinary iterations. Its full serial
terminal gate is retained; do not use the crashing isolate lane or weaken timeouts/retry/skip
rules. Required merge/sign-off gates must run before each merge, not merely once after all merges.
A pre-existing failure is recorded and investigated, never relabeled green. Release-tier
qualification remains deferred and is explicitly excluded from a product-only completion claim.

Review source, tests, diagnostics, cancellation/cleanup, public-schema compatibility, phase
traceability and no-release safeguards. Independent review is still required where applicable;
self-inspection is not represented as an independent review. User changes and prior evidence
are preserved. No direct main/tap pushes, force push, version bump, tag, publication or visibility flip.

## 5. Follow-ups and reconciliation

- P19-T11 explicitly reschedules the saved Bun 1.3.14 --isolate --no-orphans
  EEXIST/epoll_ctl plus signal-exit/proper-lockfile investigation from after P17 publication to
  after the product bugs. Perform bounded diagnosis, test an isolated newer runtime only if
  useful, keep the accepted serial runner. Fix confirmed Skillsmith-owned defects; keep upstream
  defects open with evidence/workaround, not “fixed” by deferral.
- P18 remains an idea. Reproduce any concrete defect within existing promised contracts, but do
  not silently implement new external-schema validation capabilities. Preserve its open design questions.
- Split P13-T06 into wiring/real-skill proof and PUB-08 downstream release. Establish current
  downstream evidence before marking either done or broadening repository mutation scope.
- Reconcile P09-RV with existing merged review evidence. Close only when supported; otherwise
  retain an explicit review follow-up rather than call it a product bug.
- Completed process reconstruction/framework work stays complete. Optional publication,
  extraction, licensing/CI and framework enhancements are not newly mandatory bugs.

## 6. Closeout and resumption

Execution finding P19-T15 (#65): the ordinary dependency audit identified vulnerable TOML/YAML
parsers and tooling dependencies on both maintained lines. This falls within non-publication bug
closeout. Raise compatible patched dependency floors, retain the gray-matter 3.x YAML API, add
bounded malformed-TOML rejection coverage, inspect lockfile changes, and rerun audit plus normal
gates. Do not bump Skillsmith release versions or waive the audit.

Execution finding P19-T16 (#67): pre-existing doctor/verify contract failures inherit host tool
installations through PATH or HOME. Isolate the affected fixture environments and in-process
filesystem facts; retain exact assertions, confirm baseline failure, then pass owner/smoke and
the canonical full gate. Do not remove host tools, suppress expected findings or change production
discovery to make a fixture pass.

Update P17 navigation with the approved pause and P19/PUB-00 links, retaining original objective,
terminal rule and unsigned catalog gates. Freshly verify issue/PR/branch/worktree/workflow state.
Close a bug only with its acceptance evidence and every affected maintained-line fix; otherwise
leave it open with an exact remaining task. Deferred publication issues stay open. P19 is not
complete while a confirmed in-scope product bug is unresolved.

Publication can resume only by explicit future direction, starting at PUB-00, revalidating the
then-current source/platform/external authorities and approvals. Restore held release controls
only as part of that authorized resumption. P17's original goal is not marked achieved by P19.

## 7. Decided closeout questions — 2026-09-15

- [Q1.A](https://github.com/smorinlabs/skillsmith/issues/41#issuecomment-5689778855): retain
  per-tool duplicate conflicts and deliver informational cross-tool name reporting separately.
  Keep #41 open until that follow-up PR is reviewed, validated and integrated on affected lines;
  the report does not block PR #66. No flag name or JSON schema is selected by this decision.
- [Q2.A](https://github.com/smorinlabs/skillsmith/issues/51#issuecomment-5689864463): move
  only Candidate-cask qualification and dedicated setup behind an explicit guarded manual
  release trigger. Retain ordinary checks and every native build/smoke lane. After corrections
  and validation, open the P17 maintenance PR against `agent/p17-execution`, not main.
  PR #44 remains draft; release qualification and original release-completion gates stay pending.
- Independent Codex and Claude Code reviewers have standing user approval. Correct findings
  F13-F16 under #61/#64/#67 and any validated in-scope review regressions before integration.
  Close issues only with acceptance and affected-line merge receipts; all PUB work stays held.

## 8. Implemented checkpoint and remaining execution

Initial implementation and local ordinary/security validation are recorded on the saved main-based
and P17 maintenance branches; see the exact receipts in P19 EVIDENCE.md and tracking issue #51.
Main PR #66 has green Linux/macOS CI. P17's clean `d786739` passed the canonical 370-file
terminal gate; no P17 PR CI or deferred release qualification is claimed.

Independent review subsequently found remaining defects in #61/#64/#67. The next work is
correcting those findings, delivering the separately scoped #41 report, and reviewed integration;
it does not resume PUB tasks:

1. Correct the findings in P19 REVIEW.md and obtain fresh read-only sign-off at the corrected
   heads. Codex and Claude Code reviewers have standing user approval.
2. Follow Q1.A above: keep #41 open for informational cross-tool name reporting in a separate
   follow-up PR, without changing per-tool conflicts or holding PR #66 for that addition.
3. Execute [Q2.A](https://github.com/smorinlabs/skillsmith/issues/51#issuecomment-5689864463):
   move only Candidate-cask qualification and its dedicated setup behind an explicit guarded
   manual release trigger. Retain canonical ordinary checks, title validation and every native
   build/smoke lane. After bug corrections and validation, open the maintenance PR against
   `agent/p17-execution`, not main; keep #44 draft and all release completion requirements pending.
4. Resolve findings, rerun gates in proportion to changes and at integration heads, integrate
   accepted work into both maintained lines, and then close supported bug/task checkboxes.
5. Leave PUB-00..08 deferred and historical/investigation follow-ups #57/#60/#63 explicitly
   open unless new evidence satisfies their own acceptance. Do not mark P17 release complete.
