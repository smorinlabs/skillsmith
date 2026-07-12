# P17 evidence records

Evidence files are append-only execution receipts named `<group-id>.md` or `phase-<phase>.md`.
Do not create evidence for work that has not run.

Final P17 sign-off additionally requires a resolving
`projects/p17/evidence/*p14-handoff*.md` record that identifies the validated Phase 6 baseline,
final approval, P14 prerequisites, and any explicitly deferred work.

Preparation evidence: [adversarial preparation review](preparation-review.md).

Each change-group record must contain:

```markdown
# <group-id> evidence

## Mapping and prerequisites
- Catalog revision/hash:
- Mapped IDs:
- Signed prerequisite evidence:

## Test-first evidence
- Test or characterization/boundary command:
- Expected failure or preserved baseline:
- Result and artifact/commit:

## Implementation and refactor
- Implementation commits:
- Refactor commits:
- Files owned:

## Validation
- Targeted commands/results:
- Impacted commands/results:
- Required skips: none

## Adversarial review
- Review ID/context:
- Findings and dispositions:
- Correction commits and reruns:

## Traceability and sign-off
- Catalog/checklist command/result:
- CI/PR evidence:
- Reviewer sign-off and timestamp:
```

Evidence is sufficient only when paths, commits, results, review dispositions, and sign-off resolve
from the repository or named CI/PR state. A summary without reproducible evidence cannot advance a
catalog gate.

## Validator self-test receipt EWP-P0A-TS01

This receipt is exercised only against a temporary mutated catalog in the catalog validator's own
test suite; it does not advance the committed P17 execution state.

- Validation ID: `EWP-P0A-TS01`
- Command: `bun test scripts/p17-catalog.test.ts --test-name-pattern EWP-P0A-TS01`
- Exit status: `0`
- Result: the named self-test selector executes and passes.
- Revision: `working-tree`

## Validator self-test group P17-G0-01

This anchor is used only by temporary lifecycle mutations in the validator's self-tests. It does
not represent completion of the committed group.
