# Amendment: P19-T08 cross-tool-names report (Decision Q3.A)

P17-line amendment for the informational cross-tool same-name report. The P17
execution catalog (`projects/p17/catalog.json`) is intentionally untouched: it
tracks P17 execution, this is a P19 follow-up, and no test enforces its counts.
Historical 0.7.0 CLI snapshots stay immutable.

## Authority and scope

- Decision Q3 (2026-09-19): Q3.A selected.
  Record: [issue #41, decision comment](https://github.com/smorinlabs/skillsmith/issues/41#issuecomment-5739475301).
  Proposal: [issue #41, Q3 proposal](https://github.com/smorinlabs/skillsmith/issues/41#issuecomment-5691360883).
  Prior: Q1.A — per-tool conflicts unchanged, reuse is not conflict, separate
  follow-up PR, no flag/schema approved then.
- Branch: `agent/issue-41-cross-tool-names-p17` off `agent/p17-execution` at
  `2d79353d40020590f44fa0d56e4735005897ca23`. Target: `agent/p17-execution`
  (PR44 source branch), so draft PR44 carries the result. P17 line only; the
  main-line counterpart is a separate branch and PR.
- Owner phase: P17-G3A-02 (discover family, same as `list`/`commands`).
  Validation owners: new ledger-scoped `EWP-CMD-CROSS-TOOL-NAMES-TS01..TS04`.
  Workflows: none.

## Report contract

- Wire DTO, new codec `cross-tool-names@1` in
  `@skillsmith/core/contracts/v1`, strict recursive unknown-field rejection,
  conservative compatibility, no migrations:
  `{schemaVersion:1, kind:"skillsmith.cross-tool-names",
  groups:[{name:string, members:[{tool:string, scope:Scope, path:string}]}]}`.
- `Scope` reuses the existing scope enum.
- Ordering (list@3 precedent, `contracts/v3/list.ts`): sort keys are RAW
  values pre-redaction. Groups by the existing locale-independent name
  comparison. Members by registry tool order (unknown tools fall back to
  `Number.MAX_SAFE_INTEGER`, never NaN), then `SCOPES` order
  (system, user, project, managed), then `compareText` on path. Sort is
  stable: identical tool+scope+path triples retain inventory order; such
  triples should not occur from real inventory.
- Redaction in the `to*Dto` mapper: group on raw names, then redact the
  group name and each member's tool and path; the `scope` enum is never
  redacted. Two distinct raw names may redact to the same label, emitting
  duplicate group names; accepted, groups are never merged on labels.
- No `selection`/`summary` metadata (explicit waiver, decided by Q3.A):
  precedent is agents@2, which carries neither. Impact: JSON consumers
  cannot distinguish "filters matched nothing" from "no names repeat";
  callers saving JSON retain their invocation for filter provenance. The
  human renderer distinguishes the two empties from the domain report
  (below), which carries the matched-entry count.
- CLI mapping: `mapping('skillsmith cross-tool-names', 'cross-tool-names', 1)`
  plus registry entry and typed renderer binding. The wire-closure assertion
  and the migration-ledger closure assertions are the structural validation:
  a JSON-capable command without codec and ledger entries fails the suite.

## Command surface

- Path `skillsmith cross-tool-names`, group `discover`, capability `read`.
  Question: "Which skill names repeat across tools?"
- Argument: `[glob...]` (optional, variadic, no choices).
- Options: `-t, --tool <name>` (repeatable), `-s, --scope <scope>`,
  `--user`, `--project`, `--system`, `--managed`, `--enabled`, `--disabled`,
  `--unconfigured`, `--json`. No alias. No `--duplicates`, `--long`, or
  list-only filters.
- Relations: `--enabled`/`--disabled`/`--unconfigured` mutually exclusive;
  scope relations for user/project/system/managed, mirroring `list`.
- Exits: standard read codes, mirroring `list`.
- Ledger: new `targetRows` entry, `commandGroup` owner P17-G3A-02,
  `scopeChoices` user/project/system/managed, membership in `newCommands`
  (disposition N), `validationCounts` entry of 4, target command count 23→24,
  `cli-target-registry-v1.0.0.json` extended to match computed target bytes,
  `commander-current-state-v0.json` extended atomically with implementation.

## Human format

The domain report carries the matched-entry count so human empties stay
truthful without changing the DTO.

- Selection matched zero entries:
  `No skills matched the selected inventory.` (exit 0)
- Selection matched entries but no name repeats across tools:
  `No skill names repeat across the selected tools.` (exit 0)
- Non-empty: one block per group in DTO order, blank line between blocks,
  trailing newline, exit 0:
  `<name> (<T> tools, <M> placements)` then one
  `  <tool> <scope> <path>` line per member in DTO order.

## Grouping semantics

Apply selection first. Group exact, case-sensitive reported names, including
any existing namespace. A group requires at least two distinct selected tools.
Include all selected placements for each qualifying name, with tool, scope,
and logical path. Two scopes of one tool alone are not a group. A shared real
path does not suppress an otherwise qualifying group. Name reuse only: no
content-equality, conflict, winner, or precedence claim. Existing
`list --duplicates`, list JSON, and doctor behavior remain unchanged.
Group before applying existing wire redaction; do not merge distinct names
merely because sanitized labels match. Emit `groups:[]` with exit 0 when no
names qualify. Inventory errors or cancellation must not become empty success
or partial reports. No `selection` or `summary` metadata; callers saving JSON
retain their invocation for filter provenance.

## File inventory (implementation)

- `packages/cli/src/spec/registry.ts`: PROFILE, DESCRIPTION,
  ARGUMENT_DESCRIPTIONS, EXAMPLES, WORKFLOW_DESCRIPTIONS,
  PUBLIC_COMMAND_ORDER, MINIMAL_INVOCATIONS, EXIT_CODES, relations.
- `packages/cli/src/spec/options.ts`: ALLOWED_SCOPES, OPTION_DESCRIPTIONS
  entries. OPTION_HELP_FAMILIES needs no edit: all required longs are
  already allocated. No completion provider: `[glob...]` has none, as with
  `list`.
- `packages/cli/src/runtime/current-renderers.ts`: `cross-tool-names:
  guarded<…>` entry (runtime throws "not registered" without it).
- `packages/core/src/application/read-services.ts`: report type,
  `runCrossToolNamesApplication`, `CURRENT_READ_APPLICATIONS` entry.
- New `packages/cli/src/output/cross-tool-names-human.ts` and
  `cross-tool-names-json.ts`.
- `packages/core/src/contracts/v1/index.d.ts` by hand (ambient mirror of
  the v1 barrel; no generator), plus the barrel export.
- `packages/cli/src/contracts/cli-migration-ledger.ts`,
  `cli-target-registry-v1.0.0.json`, `commander-current-state-v0.json`,
  count 23→24 in `assertTargetOwnership`.
- `packages/core/src/contracts/v1/cross-tool-names.ts` (+ v1 barrel),
  `packages/cli/src/contracts/wire-contracts.ts` (mapping, registry row,
  typed binding).
- Core grouping over the selected inventory, application read service,
  CLI runtime dispatch, human renderer, JSON renderer through the codec.
- Regenerate `docs/commands.md` and README sections via
  `scripts/generate-command-reference.ts`; mandatory hand edit of
  `packages/cli/README.md:21` (23→24 commands).
- Count-23 updates: `tests/contracts/completion.test.ts:326` (23→24 specs,
  28→29 candidates), `tests/contracts/options.test.ts:2065` (23→24),
  `tests/contracts/help.test.ts:186` (23→24; minimal invocation and
  workflows must actually run hermetically). Unaffected, verified:
  `status.test.ts` FAMILY_ALLOCATION (status's own 23 topics),
  `commands.test.ts` goldens (slash-command fixture bytes).
- ADR 0008: evolution note (new codec inventory row + mapping), following
  its existing "Subsequent production evolution" precedent.
- Tests: new `packages/cli/tests/commands/cross-tool-names.test.ts`:
  TS01 selection/grouping with one fixture per semantic (exact case
  variants `Foo` vs `foo` ungrouped; namespaced names grouped; one-tool
  multi-scope excluded; shared realpath retained; all placements of a
  qualifying name included; negative assertions of no winner/conflict/
  precedence claim); TS02 human shapes (both empty copies, non-empty
  layout bytes) and JSON shape with explicit `selection`/`summary` key
  absence; TS03 filters (tool/scope/enabled families), multi-axis ordering
  (name/tool/scope/path), redaction-collision fixture (two raw names, one
  label, two groups); TS04 invalid options and relation violations
  (exit 2), inventory errors never empty success, signal interruption
  (exit 130 per convention). Core grouping unit tests. Codec
  round-trip/unknown-field/migration-absence tests. No-regression:
  existing `list --duplicates`, list JSON, and doctor suites stay green,
  plus one explicit pair asserting a cross-tool name yields `[]` from
  `list --duplicates` and one group from the new report.

## Validation

Structural: EWP-OPT-TS01 ledger closure, wire-closure assertion, help
contracts, codec conformance. Focused: the four TS tests green.
`tsc --noEmit`, `biome check`, boundary lint, applicable smoke. Full
`bun run check` at the merge gate only. Plan-gate review of this amendment,
final review of the exact candidate, PR CI green, then normal merge with
pre-merge drift read and post-merge verification.

## Out of scope

PR44 merge or rebase. Main-line counterpart (separate PR). Publication,
release, or version changes. Doctor consumer changes (its parser was never
inspected; JSON need stays inferred). `catalog.json` counts. New retries,
flags, or predicates beyond the Q3 proposal.
