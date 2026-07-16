# ADR 0006 — Immutable observed state, pure planning, and domain repositories

**Status:** Accepted (2026-07-15)

## Context

SkillSmith already has immutable operation/diagnostic products, a lock hierarchy, under-lock
preconditions, deterministic scheduling, versioned artifact readers, an artifact-pair coordinator,
and a crash-safe canonical ledger writer. Those foundations are sound, but the current mutation
runners still mix observation, planning, compatibility projection, execution, persistence, and
report assembly.

In particular:

- placement planning still receives read ports and performs filesystem observation;
- acquisition and placement independently construct overlapping state facts;
- `SwapCtx` carries mutable ledger state plus a persistence callback;
- the ledger persistence gateway privately advances expected revisions;
- cross-domain execution has no explicit revision cursor;
- `artifacts/ledger-writer.ts` imports ledger-history policy from `place/`, creating a real
  dependency reversal; and
- planning compatibility imports acquisition and placement result types even though those runners
  already depend on planning.

This makes dry-run/execution identity, concurrent-writer refusal, partial-pair revision truth, and
architectural ownership harder to prove. It also encourages new commands to add orchestration to
the existing monolithic runners.

ADR 0005 remains controlling for capability-scoped ports. ADR 0007 remains controlling for tool
capabilities. ADR 0008 remains controlling for persisted and public wire codecs. The signed G3B-03
ledger writer, recovery protocol, logical transactions, and bounded-history cleanup remain the
accepted durability foundation and are not redesigned here.

## Decision

### Dependency direction and authority

The private core dependency direction is:

```text
domain models, codecs, and focused ports
        -> domain repository contracts and adapters
        -> immutable observed-state reader and snapshot
        -> pure planners
        -> immutable plans and preconditions
        -> execution coordinator
        -> domain write adapters
        -> existing physical durability engines
```

Application services and compatibility projections compose above that pipeline. They may map
current request/report shapes at the edge, but they do not become a second planning or persistence
authority.

The following rules are normative:

- repositories never import planner implementations, execution scheduling, status, application
  services, acquisition/placement runners, or one another;
- planners never import ports, repositories, execution, application services, or current runners;
- status receives only read repository/snapshot contracts and never write, lock, process, clock,
  ID, or interaction capability;
- execution may consume plan types, preconditions, repository contracts, physical adapters, and
  the canonical `createOperationExecutionResult` validator from the neutral planning constructor
  layer, but never imports or calls a command planner, constructs operations, or replans;
- the existing execution coordinator is the sole cross-domain lock, validation, scheduling, and
  revision-cursor owner;
- the artifact coordinator remains the manifest/lock physical durability authority;
- the canonical ledger writer remains the ledger replacement, recovery, and bounded-history
  durability authority; and
- live-placement and store adapters retain their domain mechanics without calling artifact or
  ledger repositories.

Ledger-history selection and cleanup move beside the ledger durability authority so artifacts no
longer depend on `place/`. The historical `place/history.ts` path may temporarily re-export the
neutral authority for compatibility, but it contains no independent policy. Legacy action
projection moves to an edge-compatible neutral type boundary so planning no longer imports
acquisition or placement runners.

### Domain repositories

SkillSmith uses behavior-specific repositories:

- `ManifestRepository`;
- `LockRepository`;
- `LedgerRepository`;
- `LivePlacementRepository`; and
- `StoreRepository`.

They are thin facades over existing codecs, artifact reads, artifact coordination, ledger writing,
placement mechanics, and store mechanics. They own storage observation, canonical encoding,
expected-revision comparison, domain staging, and mapping physical failures into closed repository
results. They do not own target selection, user policy, operation ordering, approval, rendering, or
cross-domain commit order.

There is no generic CRUD `Repository<T>`. Common data types for revision identities, logical stage
receipts, and coordinator outcomes are permitted; common policy-bearing repository methods are not.
Each domain names its behavior explicitly, for example manifest/lock replacement, ledger-model
commit, live-placement change, and store snapshot/cleanup.

Repository construction receives the smallest focused port composition it needs. A read-only
consumer cannot be handed a write-capable repository and expected to ignore its methods.

### Revision identity, including absence

Every observed resource has an immutable `ExpectedRevisionV1`. It is a closed union with these
common fields:

```text
schemaVersion: 1
domain: manifest | lock | ledger | live | store | project | capabilities
resourceId: stable domain identity
state: absent | present
```

A present revision carries the applicable exact revision identities:

- manifest, lock, and ledger carry byte and semantic revisions;
- live and store carry resource revision, content revision when meaningful, and representation;
- project context carries its canonical semantic fingerprint; and
- capabilities carry the ordered relevant adapter fingerprint.

An absent revision is not a bare `null`. It carries:

- the normalized target identity;
- the observed target kind `absent`;
- the normalized parent identity;
- the parent's observed kind; and
- the parent's stable metadata identity, or an explicit absent-parent identity.

The absence digest is a domain-separated digest over that closed record. Creation therefore uses
compare-and-set semantics: a newly appearing target, replaced parent, changed parent identity, or
unexpected special node is stale state rather than permission to overwrite.

No revision uses a clock, random ID, mutable object identity, renderer string, or unversioned
`JSON.stringify` of an open object.

### Immutable observed-state snapshot

`ObservedStateSnapshotV1` is a deeply owned and deeply frozen private record containing:

- `schemaVersion: 1`;
- deterministic `snapshotId`;
- project context;
- manifest observation;
- lock observation;
- ledger observation;
- selected live-placement observations;
- selected store observations; and
- the relevant capability fingerprint.

A fully representable selected status read may additionally bind one closed optional
`statusRevision` digest into `snapshotId`. It covers only the existing migration/retention facts
that are outside the seven resource domains, is reobserved once with no retry, and is not a generic
adjunct extension point. Mutator snapshots omit it; unselected or unrepresentable status reads stay
inside the bounded compatibility reader.

Every component includes its exact `ExpectedRevisionV1` and the immutable domain model/facts needed
by planning. Snapshot construction rejects proxies, accessors, symbols, exotic prototypes, sparse
arrays, cycles, non-finite numbers, excessive depth/node count, and sensitive material at the
ordinary-data boundary. Codec/domain-specific validation remains with its existing owner.

The reader uses a deterministic two-pass consistency algorithm:

1. derive the closed resource list in canonical order;
2. read and own every component plus its revision;
3. reread the same revision vector in the same order; and
4. return a snapshot only when the two revision vectors are exactly equal.

A mismatch returns `snapshot-changed`. The reader does not loop or silently combine observations
from different revisions. A caller may initiate a new bounded attempt as a new visible planning
operation.

`snapshotId` is a domain-separated digest of the canonical ordered revision vector. It is not a
timestamp or allocated ID. Two equivalent revision vectors produce the same ID; any relevant
revision change produces a different ID.

### Pure planning and plan identity

Each current mutator has a synchronous, port-free planner with this conceptual shape:

```text
createPlan(request, snapshot) -> immutable Plan
```

The planner:

- does not read the filesystem, Git, process environment, network, clock, ID source, lock, or
  repository;
- does not mutate its request or snapshot;
- never rereads state;
- emits operations, checks, diagnostics, and exact revision preconditions only; and
- returns byte/structurally identical operations for dry-run, approval, and fresh execution of the
  same request/snapshot.

Plans record `snapshotId` and exact component preconditions. Existing domain-separated semantic
operation/group/pair identity constructors remain authoritative and remain clock/random-free.
Snapshot identity is not folded into operation IDs; staleness belongs to explicit revision
preconditions, avoiding unrelated operation-ID churn.

The executor never silently replans. If a revision changed, execution refuses the prepared plan. A
fresh apply creates and displays a new plan before approval.

### Logical staging and physical durability

Repository staging is logical at the shared boundary. A domain-specific stage method validates an
immutable edit against an exact expected revision. The concrete repository adapter reobserves that
revision under the coordinator-held lock; callers cannot supply the observed revision. The adapter
returns an immutable stage record containing:

```text
operationId
domain
resourceId
expectedRevision
beforeRevision
editDigest
```

The shared stage record neither predicts a future filesystem revision nor claims that bytes are
already durable. Physical staging, recovery files, backups, atomic replacement, fsync order, and
cleanup remain owned by the existing artifact coordinator, ledger writer, and placement/store
adapters. After durability is resolved, the owning adapter reobserves the actual revision and
returns it in a receipt. The coordinator accepts that receipt only when it exactly covers every
staged domain/resource, repeats the exact staged before revision, and reports a valid after revision
for the same domain/resource.

For coordinator fault injection, every write adapter exposes the same lifecycle phases—stage,
commit, rollback, and cleanup—while retaining domain-specific inputs and results. This common
lifecycle is a coordinator protocol, not a generic CRUD repository.

The artifact coordinator and ledger writer are not merged. Their different persisted formats,
recovery records, barriers, and crash matrices remain independently testable.

### Expected revisions and coordinator cursor

The execution coordinator owns an immutable revision cursor keyed by stable resource identity.
It initializes the cursor from the approved snapshot and performs all cross-domain advancement.

Under the existing lock hierarchy, before an operation starts the coordinator rereads every
referenced domain revision and requires exact equality with the cursor. Any mismatch refuses before
that operation writes.

After a repository operation:

- an unstarted or pre-stage refusal leaves the cursor unchanged;
- a successful commit advances only the revisions proven by its commit receipt;
- a completely rolled-back operation restores the before revisions and leaves the cursor there;
- a failure after a durable boundary must be resolved by the owning physical adapter/recovery path
  into a committed or rolled-back receipt before later work may start; and
- an indeterminate or unobservable result stops the group, discards the stale in-memory cursor, and
  fails closed.

The coordinator never guesses from an in-memory model. When an operation can cross a durable
boundary before returning an error, the mandatory post-operation reread/recovery rule from G3B-03
continues to apply.

Successful pairs may truthfully advance revisions even when another pair fails. Failed or skipped
pairs retain their prior revisions unless a proven committed receipt says otherwise. This provides
partial-pair truth without claiming invocation-wide atomicity.

### Immutable ledger reducers

Ledger policy changes use copy-on-write reducers:

```text
reduceLedger(model, edit) -> Result<new frozen model>
```

Reducers receive no ports, clock, ID allocator, persistence callback, or mutable context. They
preserve the canonical ledger model, project registrations, logical transactions, history, and
compatibility facts according to their existing authorities.

`SwapCtx.ledger` plus its zero-argument persistence closure is retired after compatibility callers
migrate. Repository calls receive an explicit model/edit and expected revision and return an exact
commit receipt. The G3B-03 canonical writer remains the only production ledger replacement,
recovery, and history-cleanup engine.

### Migration sequence

The migration is staged and parity-preserving:

1. add this ADR and red architectural tests;
2. remove the artifacts-to-place and planning-to-runner dependency reversals;
3. centralize the bounded ordinary-data ownership primitive used by planning and execution
   preconditions, with domain-specific error mapping;
4. extract immutable ledger reducers;
5. define revision/snapshot types and one consistent state reader by reusing current artifact,
   status, ledger, live-placement, and store reads;
6. separate observation from acquisition and placement planning;
7. wrap existing physical authorities in thin domain repositories;
8. add coordinator revision-cursor composition and fault-injection seams;
9. migrate current runners through compatibility shells and remove mutable contexts; and
10. split acquisition and placement runners by observation, planning, execution, and recovery
    responsibility without changing command or report behavior.

The ready baseline line counts of `acquire/run.ts` and `place/run.ts` are architectural no-growth
ratchets. Size is a review trigger, not the source of truth: tests also require the extracted
responsibilities and import direction. The proven artifact coordinator and ledger writer are not
split merely to satisfy line-count aesthetics.

### Compatibility and visibility

G3B-04 changes private architecture, not the public CLI contract.

- Current command behavior, exit semantics, application-service results, and human/JSON bytes
  remain compatible.
- Ledger v1 reading/migration and G3B-03 crash/recovery behavior remain byte- and
  semantic-compatible.
- Compatibility projection occurs at an application/compatibility edge rather than inside the
  foundational planner dependency zone.
- Repositories, snapshots, stage records, and revision cursors remain private in this gate.
- No new CLI option, command, persisted schema, public wire version, or public barrel export is
  introduced.

### Enforceable architecture checks

`EWP-P3B-TS05` and focused unit tests enforce:

- hostile-input ownership and deep-freeze mutation traps;
- deterministic snapshot identity and two-pass mixed-snapshot refusal;
- exact plan equality and input nonmutation;
- planner bans on effect ports, repositories, execution, and runners;
- revisioned absence and present/absent concurrent-writer refusal;
- read-only status capability;
- repository isolation and absence of import cycles;
- coordinator-only cross-domain composition and revision-cursor advancement;
- stage/commit/rollback/cleanup fault injection through hermetic fakes;
- partial-pair revision truth and no invocation-wide atomicity claim;
- compatibility operation/result and current output parity;
- continued single ownership of artifact codecs, artifact coordination, and ledger durability; and
- runner no-growth plus responsibility/ownership gates.

## Consequences

### Positive

- A single consistent snapshot supports status, dry-run, planning, and execution approval.
- Pure planners become deterministic property-testable functions.
- Expected revisions make concurrent changes explicit and fail closed.
- Cross-domain ordering and partial progress have one coordinator-owned explanation.
- Existing crash-safe durability algorithms are reused rather than reimplemented.
- Read-only consumers receive structurally read-only capabilities.
- Dependency and size ratchets prevent the extracted architecture from collapsing into a new
  monolith.

### Negative

- More private types and modules are required to make ownership explicit.
- The two-pass snapshot reader performs additional revision observations.
- Compatibility shells remain temporarily while current runners are migrated.
- Every write adapter must produce exact commit/rollback outcomes for coordinator composition.
- Concurrency refusal may require users to regenerate and reapprove a plan.

## Alternatives considered

- **Keep mutable runner contexts.** Rejected because state ownership and revision advancement remain
  implicit and dry-run/execution parity cannot be proven generally.
- **Let planners read repositories.** Rejected because planning would remain effectful and could
  silently observe different states between preview and execution.
- **Use a generic `Repository<T>` or unit of work.** Rejected because the five domains have
  different revisions, edits, durability, and rollback semantics; a generic interface would hide
  policy rather than consolidate mechanics.
- **Create a new universal coordinator or durability engine.** Rejected because the existing
  execution, artifact, and ledger authorities already have distinct proven responsibilities.
- **Merge artifact and ledger recovery.** Rejected because their persisted crash protocols and
  safety proofs differ materially.
- **Acquire one invocation-wide transaction.** Rejected because current semantics permit truthful
  per-pair progress and do not promise global atomicity.
- **Use clocks or random IDs for snapshot identity.** Rejected because equivalent observations must
  yield deterministic planning inputs.
- **Split every large file to a fixed line limit.** Rejected because responsibility and dependency
  direction are architectural; line count is only a ratchet and review signal.

## Downstream exclusions

This decision does not implement saved-plan apply, manifest/lock desired-state mutation, public
undo, sync, update, GC, retention-expiry policy, adapter extraction, operation-context propagation,
new observation events, public repositories/snapshots, new codecs, or new CLI/wire surfaces. Those
remain owned by their later P17 groups.

## References

- [ADR 0003 — ESLint import boundaries](0003-eslint-import-boundaries.md)
- [ADR 0004 — Command runtime and application services](0004-command-runtime-application-boundary.md)
- [ADR 0005 — Capability-scoped ports](0005-capability-scoped-ports.md)
- [ADR 0007 — Tool-adapter registry](0007-tool-adapter-registry.md)
- [ADR 0008 — Wire-contract registry](0008-wire-contract-registry.md)
- [P17-G3B-04 Ready plan](../../projects/p17/plans/P17-G3B-04.md)
