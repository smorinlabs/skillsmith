# ADR 0007 — Validated tool-adapter registry as capability authority

**Status:** Accepted (2026-07-12); lifecycle-consumption amendment accepted (2026-07-16)

## Context

SkillSmith recognizes Claude Code, Codex, Kilo Code, and OpenCode, but current policy is repeated
across `SUPPORTED_TOOLS`, `VERIFY_TOOLS`, `FLIP_TOOLS`, checked-against version maps, CLI and schema
choices, verifier dispatch, placement roots, and tool-name conditionals. Those copies can disagree.
In particular, recognizing a tool for detection and inventory does not mean that SkillSmith can
verify or mutate that tool.

The 1.0 contract needs all four tools to remain readable while Claude Code and Codex retain the full
lifecycle and Kilo Code and OpenCode remain read-only. It must also preserve current verification,
placement, public API, report, and output behavior. ADR 0005 constrains the implementation: bundles
receive focused ports, registry construction is pure, and no aggregate `ScanEnv` dependency returns.

## Decision

One validated `ToolRegistry` is the executable authority for tool identity, order, operation and
scope support, verifier availability and checked-against versions, mutation eligibility,
capability remediation, and adapter dispatch.

### Descriptor and operation matrix

Each `ToolAdapter` has an immutable `ToolDescriptor` containing:

- a stable `id`;
- a deterministic, unique `order`;
- a positive safe-integer `capabilityVersion`;
- one capability fact for every operation, with `supported`, an exact ordered `scopes` set, and a
  stable `remediation` string for unsupported capabilities.

The operation IDs are exactly:

```text
detect
inventory-skills
inventory-commands
diagnostics
install
uninstall
dev
promote
undo
verify-static
verify-deep
plan
apply
sync
update
adapt
```

The built-in descriptor order is Claude Code, Codex, Kilo Code, then OpenCode. All four initial
descriptors use `capabilityVersion: 1`. Adapter identity is `<id>@<capabilityVersion>`; different
tool IDs may legitimately share the same capability version. A capability change increments only
the affected adapter's version.

The exact 1.0 scope matrix is:

| Operations | Claude Code | Codex | Kilo Code | OpenCode |
|---|---|---|---|---|
| `detect` | unscoped | unscoped | unscoped | unscoped |
| `inventory-skills`, `inventory-commands`, `diagnostics` | user, project, system, managed | user, project, system, managed | user, project, system, managed | user, project, system, managed |
| `verify-static`, `verify-deep` | artifact | artifact | unsupported | unsupported |
| `install`, `uninstall`, `dev`, `promote`, `undo` | user, project, custom | user, project, custom | unsupported | unsupported |
| `plan`, `apply`, `sync`, `update` | user, project, custom | user, project, custom | unsupported | unsupported |
| `adapt` | unsupported | unsupported | unsupported | unsupported |

Except for explicitly unscoped `detect`, every supported operation has a nonempty exact scope set.
Unsupported operations have no scopes and carry stable capability remediation. A known unsupported
tool or operation produces capability exit 4. An unknown tool ID remains a usage error with exit 2.

### Cohesive bundles

A `ToolAdapter` has this shape:

```text
ToolAdapter {
  descriptor
  inventory
  verification?
  placement?
  adaptation?
}
```

Every adapter has one inventory bundle containing its detection, skill and command roots, install
hint, and plugin-directory behavior. Inventory functions accept only focused read capabilities.

A verification bundle owns verifier dispatch, its checked-against tool version, supported modes,
target-manifest and bare-wrapper facts, lifecycle gate policy, and structured rendered facts.
Standalone `verify --deep` means static plus deep for both Claude Code and Codex. Lifecycle policy
remains distinct from mode availability: install defaults to static and its current deep enhancement
is Codex-specific; promote uses Claude static and Codex static plus deep. The Claude deep result
continues to identify load-presence coverage without a renderer branching on the Claude ID.

A placement bundle owns standard, current, and legacy roots; placement discovery and
classification; duplicate and legacy notices; lifecycle placement policy; and structured rendered
facts. This keeps Codex current/legacy behavior and its remediation inside the Codex adapter rather
than generic acquisition or placement code.

An adaptation bundle is optional. None of the four built-in adapters has one in 1.0. Adding
adaptation behavior or full Kilo Code/OpenCode lifecycle support is not part of this decision's
implementation group.

### Construction and validation

`createToolRegistry(adapters)` validates the complete registry before returning a deeply frozen
value. Construction rejects:

- duplicate IDs, orders, or `<id>@<capabilityVersion>` identities;
- non-integer, non-positive, or unsafe capability versions;
- missing inventory bundles or descriptor/inventory identity drift;
- missing operations, invalid scope sets, supported scoped operations with no scopes, or
  unsupported operations that declare scopes;
- declared static or deep verification without a matching verifier and mode declaration;
- verification, placement, or adaptation bundles whose capabilities are not declared;
- declared mutation without a placement bundle;
- a placement or other mutation bundle on a descriptor that is read-only; and
- declared adaptation without an adaptation bundle.

Registry adapters, lookup results, tool projections, and capability projections preserve descriptor
order. `get(id)`, `toolsFor(operation)`, and `capability(id, operation)` route through the validated
registry rather than reconstructing policy. A fixture read-only or write adapter can therefore be
registered and dispatched without modifying a generic coordinator, renderer, schema owner, or
selection validator.

### Derived compatibility and generic consumers

The registry is the only maintained source for built-in IDs/order, capability facts, verifier
availability, checked-against versions, and mutation availability. Existing 1.x exports remain, but
become derived projections:

- `SUPPORTED_TOOLS` and the public `Agent` record cover every registered inventory adapter;
- `VERIFY_TOOLS` and `VERIFIED_AGAINST` derive from verification bundles;
- `FLIP_TOOLS` derives from the applicable placement capabilities; and
- the public `registry`, `getAgent()`, and `listSupportedTools()` remain compatible inventory views.

CLI option and completion metadata, configuration enums, migration-ledger choices, selection
policies, verification dispatch, help facts, and current JSON enum schemas consume those
projections. Generic application, acquisition, placement, verification, scan, selection, schema,
and renderer modules do not branch on the four known IDs. Adapter-owned modules may name their own
ID. Executable static gates reject new independent built-in arrays, checked-version maps, direct
adapter imports, and known-ID policy branches outside adapter ownership.

### Current behavior and compatibility

This is an authority migration, not a product-surface redesign. `verify <path>` retains plugin and
bare-skill recognition, isolated wrapper creation and cleanup, byte-identical skill copying, static
default, additive deep mode, strict warning promotion, repeatable explicit tools, human and JSON
rendering, global cwd/configuration behavior, live version reporting, and cancellation.

Automatic verifier absence remains tolerated when another requested verifier ran. Explicit
absence, no verifier running, or requested deep verification not running returns capability exit 4.
Verification findings return 1, usage returns 2, cancellation returns 130, and failure takes
precedence over a simultaneous capability gap. Explicit Kilo Code or OpenCode verification is a
known unsupported capability, not an unknown-tool error.

Current report structures and human/JSON bytes remain unchanged. The 1.x compatibility exports are
not removed. Registry construction and lookup do not acquire ambient filesystem, environment,
process, clock, ID, or network authority; bundle operations continue to use the focused ports from
ADR 0005.

### Lifecycle-consumption amendment

The deferred G3B-05 consumption boundary completes this decision without adding another adapter
layer:

- generic lifecycle selection, planning, execution, capability observation, and human rendering
  receive a narrow validated registry projection instead of importing production registry globals;
- production wrappers retain the built-in default registry and existing public tool unions, while
  internal generic kernels can carry another validated registry's string IDs;
- placement bundles own scope-aware roots, destination/alternate roles, list, resolution,
  duplicates, and notices; generic lifecycle code owns only cross-scope selection and ledger-owned
  custom paths;
- one pure helper may reduce existing verification gate policy, but command-specific messages and
  error mapping remain separate;
- renderers consume injected adapter facts or the actual recorded verification mode without adding
  report fields; and
- mutation capability revisions contain only the used adapter version, operation, verification
  mode operations, and scope, so unrelated adapters do not stale approved work.

The complete public agents capability snapshot remains a separate full-registry presentation. The
relevant mutation fingerprint is private immutable planning state. Saved-plan persistence and apply
remain deferred even though G3B-05 provides the deterministic relevant-capability precondition
mapping.

## Consequences

### Positive

- One executable source determines tool choices, order, operation coverage, versions, dispatch,
  and remediation.
- Known read-only tools remain useful without being presented as mutation-capable.
- Descriptor/bundle drift fails during construction rather than at a later workflow step.
- Generic code can add a fixture or future adapter without gaining a new tool-name branch.
- Tool-specific roots, gate policy, notices, and rendered facts have explicit owners.
- Relevant future capability fingerprints can use one adapter identity without invalidating work
  because an unrelated adapter changed.

### Negative

- Migrating existing policy touches inventory, verification, placement, selection, schemas,
  renderers, and public compatibility projections even though user-visible behavior is unchanged.
- Bundle contracts are more explicit than the former small `Agent` interface.
- Compatibility projections remain until a future major version and must be tested against the
  registry.
- Adapter capability changes require intentional version management.

## Alternatives considered

- **Keep separate supported, writable, and verification arrays.** Rejected because independent
  lists are the drift this ADR removes and cannot provide one capability/remediation authority.
- **Use one `supported` or `writable` boolean per tool.** Rejected because support varies by
  operation, scope, verification mode, and lifecycle gate policy.
- **Add optional methods to one giant adapter interface.** Rejected because optional methods make
  descriptor/implementation drift easy and mix inventory, verification, placement, and future
  adaptation responsibilities.
- **Branch on tool IDs in generic planners and renderers.** Rejected because every new adapter would
  require unrelated generic edits and tool-specific facts would keep multiple owners.
- **Hide Kilo Code and OpenCode until they are writable.** Rejected because their detection,
  inventory, and diagnostics are already useful and supported.
- **Make all four tools writable now.** Rejected because Kilo Code and OpenCode lifecycle adapters
  are deferred and must not be implied by inventory support.
- **Break or remove the 1.x compatibility exports.** Rejected because the registry can supply
  derived views without a public breaking change.

## Downstream exclusions

This ADR does not activate saved-plan persistence/apply, manifest/lock desired-state mutation,
operation observation, new codecs or DTOs, generated help/manual work, new verification modes,
adaptation, or full Kilo Code/OpenCode placement. Those remain owned by their later P17 groups. The
complete agents capability presentation and immutable snapshot/planner/repository foundation are
already owned by their signed groups; G3B-05 only completes registry-bound lifecycle consumption
and relevant capability fingerprints.

## References

- [ADR 0001 — Core/CLI split](0001-core-cli-split.md)
- [ADR 0003 — ESLint import boundaries](0003-eslint-import-boundaries.md)
- [ADR 0004 — Command runtime and application services](0004-command-runtime-application-boundary.md)
- [ADR 0005 — Capability-scoped ports](0005-capability-scoped-ports.md)
- [P17-G1-05 implementation plan](../../projects/p17/plans/P17-G1-05.md)
- [P17-G3B-05 Ready plan](../../projects/p17/plans/P17-G3B-05.md)
- [Canonical P17 ergonomics workflow plan](../superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md)
- `tests/ergonomics/phase/EWP-P1-TS09.test.ts`
- `packages/cli/tests/contracts/verify.test.ts`
