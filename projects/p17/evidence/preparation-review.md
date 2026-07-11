# P17 preparation-package adversarial review

**Status:** closed
**Re-review result:** passed

Two independent Codex reviewers examined the preparation package: one factor-architect review of
the control-plane shape and one broad factor-scan for bugs, omissions, and false-positive checks. A
fresh-context worker separately rehearsed the one-sentence goal bootstrap.

## Findings and dispositions

### P17-PREP-RV-F01 — Lifecycle and evidence were descriptive rather than enforceable

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** catalog schema v2 adds type-specific work/validation/coverage states,
  evidence-bearing ordered gates, dependency readiness, signed-off completeness, explicit
  `skipped-required`, reviewer independence, and negative mutation tests.

### P17-PREP-RV-F02 — Secondary and impacted validation relationships were not representable

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** entities now retain primary/secondary groups, implements/validated-by/impacted
  validation/affected-contract relationships, test commands, and owned files; groups retain
  impacted validations, owners, file ownership, integration ownership, and test commands.

### P17-PREP-RV-F03 — Phase review and user approval were prose-only

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** schema v2 has Phase 0-7 records with entry, independent review, explicit user
  approval, and exit evidence. Group readiness and later-phase entry are mechanically gated.

### P17-PREP-RV-F04 — Immutable definitions could drift among plan, execution map, script, and catalog

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** every check recomputes the immutable baseline and compares group phase/title/DAG
  plus entity kind/title/model/primary owner/tier/planned target/design and relationship fields
  exactly. Actual targets and declared execution state/evidence fields remain mutable.

### P17-PREP-RV-F05 — Three change groups were too broad for one TDD/review boundary

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** shared error policy, `check`, and documentation migration are separate Phase 1
  groups; status/read-model and inventory commands are separate Phase 3A groups; help/metadata and
  shell completion are separate Phase 6 groups. The empty Phase 0 sign-off group was removed; the
  baseline is now 45 groups, with Phase 0 review/approval/exit owned by the phase record.

### P17-PREP-RV-F06 — One preparation PR could not contain proof of its own later merge

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** PREP's committed terminal state is `pr-openable`. The PR number is recorded once
  after opening; `--merge-ready` verifies the exact head/CI/reviews and `--final` verifies the landed
  state, without falsely committing proof of a future merge.

### P17-PREP-RV-F07 — The P17 project record lacked normal executive mechanics

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** the project file now has thin preparation, Phase 0-6 approval, final validation,
  and P14 handoff checkboxes reconciled mechanically with catalog phase state.

### P17-PREP-RV-F08 — The lifecycle had two authored owners

- **Severity:** minor
- **Disposition:** accepted; corrected.
- **Correction:** `P17-GOAL.md` is the sole lifecycle contract. `EXECUTION.md` links it and owns only
  change-group boundaries/dependencies.

### P17-PREP-RV-F09 — Structural validation could sound PR-ready and was absent from canonical gates

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** `--check` explicitly reports structural-only status; `--pr-openable` is wired into
  `package.json` and `justfile`; `--merge-ready` verifies the exact open PR head/CI/reviews; and
  `--final` verifies tracked/clean/merged/remote-main state live.

### P17-PREP-RV-F10 — PREP parsing and whitespace checks could miss malformed or untracked artifacts

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** the package checker parses exact canonical definitions, rejects duplicate and
  malformed lines, checks every package file directly for trailing whitespace/final newline, and
  includes negative tests.

### P17-PREP-RV-F11 — Bootstrap check modes and instruction references were ambiguous

- **Severity:** minor
- **Disposition:** accepted; corrected.
- **Correction:** the goal links committed repository instructions and defines `--final`,
  `--merge-ready`, `--pr-openable`, and ordinary amendment `--check` usage explicitly.

### P17-AR-F12 — Future validation obligations deadlocked earlier phases

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** catalog groups now retain the complete immutable `impactedValidations` relation
  while splitting executable `requiredNowValidations` from future `downstreamCoverage`. Impacted
  green gates only the current/dependency-available set; downstream owners and final review cannot
  close while a future obligation remains unsigned.

### P17-AR-F13 — Finding relations were inferred from co-location rather than plan semantics

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** finding validation ownership is parsed from the accepted traceability table and
  each detailed validation block, including ranges and slash shorthand. Explicit command-range
  expansions cover every shorthand-bearing finding and every command test in those named ranges;
  affected commands and validation rollups are immutable and exact-set tested.

### P17-AR-F14 — Entity, group, phase, and failure states could contradict one another

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** exact bidirectional transition matrices now correlate ordered gate states, group
  rollups, phase entry/dependencies, entity lifecycle stages, impacted-green validation results,
  blocking, and failure. Positive fixtures prove advertised entity/group failed and blocked states
  are reachable; counterexamples cover planned groups with failed gates, active phases with failed
  review, and advanced entities under planned parents.

### P17-AR-F15 — Existence-only paths could masquerade as executable validation targets

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** activated validation targets are typed records requiring a repository-contained
  regular executable file, accepted target kind, exact validation-ID selector, command containing
  both path and selector, target-kind command grammar, an actual named test selector, and a resolving
  ID-bound receipt containing the exact command, exit 0, result, and revision. Signed receipts
  require a 40-character revision. The positive selector is executed; directories, Markdown,
  missing files, selector/command/receipt drift, and unbound receipts are negative-tested.

### P17-AR-F16 — Lifecycle authority wording contradicted the canonical goal

- **Severity:** minor
- **Disposition:** accepted; corrected.
- **Correction:** the authority list now says explicitly that the execution map owns only group
  boundaries/dependencies and that this goal file alone owns the lifecycle.

### P17-AR-F17 — PR-openable evidence described future merge and handoff as completed results

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** the preparation summary now designates the live `--merge-ready`/`--final` gates
  and manual post-final handoff without claiming they already occurred. Offline evidence rows must
  resolve; the two future rows require exact stage markers plus resolving control artifacts.

### P17-QR-F18 — Preparation evidence and review closure could be fabricated with prose

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** PR-openable mode requires the exact ten-area summary, resolving repository/HTTPS
  evidence including real Markdown anchors, exact live/manual stage markers, a passed re-review
  receipt, and a corrected/verified/non-blocking disposition for every stable finding. Arbitrary
  prose, invented anchors, and incomplete review records fail focused mutation tests.

### P17-QR-F19 — Live PR gates could accept the wrong PR, incomplete review, or unrelated files

- **Severity:** important
- **Disposition:** accepted; corrected.
- **Correction:** merge-ready and final bind the committed PR number to the P17 branch and `main`,
  exact head or merged commit, branch-protection state, both exact OS matrix checks plus PR-title CI,
  exhaustive paginated review-thread closure, acceptable review decision, and exact changed-file
  set equality with the reviewed preparation package.

### P17-BR-F20 — Project progress and resume behavior could drift

- **Severity:** minor
- **Disposition:** accepted; corrected.
- **Correction:** executive task state is reconciled bidirectionally with the P17 trunk glyph;
  preparation completion moves the project to in-progress. The goal requires `--final` only on the
  initial clean-main bootstrap, while ordinary implementation-branch resumes use structural checks.

## Re-review evidence

Three fresh read-only Codex contexts completed correction re-review:

- architecture/control-plane review: **APPROVE**, with F12-F17 and the final live-gate corrections
  explicitly re-probed;
- broad adversarial quality review: **APPROVE**, including the final exact F01-F20 ledger-set probe;
- fresh-context bootstrap rehearsal: **PASS**, including goal initialization, resume, evidence,
  project-harness, and live closeout semantics.

The final focused suite passed 48 tests with 109 assertions. The named
`EWP-P0A-TS01` target command executed exactly one passing test. Catalog/checklist and package
structural checks, Biome, TypeScript, ESLint boundaries, actionlint, the complete repository test
suite, and `git diff --check` all passed after the corrections.

## Candidate tree

- Rebased onto fetched `origin/main` at `94e77f6`; the two P17 project-mechanics commits replayed
  cleanly.
- The reviewed tree contains only the canonical P17 preparation package; untracked `site/` remains
  excluded and preserved.
- Local gates: catalog/checklist check, package structural check, 48 focused tests, exact named
  target test, Biome, TypeScript, ESLint boundaries, actionlint, complete `bun test`, and
  `git diff --check` all passed.
- Live PR number, exact-head CI/review evidence, merge, and remote-main proof remain assigned only to
  `--merge-ready` and `--final`; this committed record does not claim those future events.
