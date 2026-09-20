# ADR 0008 — Versioned wire codecs and an immutable contract registry

**Status:** Accepted (2026-07-12)

## Context

Current CLI JSON is public wire behavior, but its schemas, field projection, and serialization are
owned independently by command renderers. That makes schema drift possible: a domain field can leak
through object spreading or schema stripping, a parser can accept fields another parser rejects,
and framing or property order can change without an explicit contract-version decision.

The accepted bytes must remain unchanged. Domain reports must also remain separate from public DTOs,
and the generic contract machinery must not know the current CLI command set. The original decision
deferred persisted manifests, locks, plans, ledgers, and journals; P17-G2-05 now supplies their
separate contract authority without changing the signed CLI JSON surface.

## Decision

`@skillsmith/core/contracts` exposes `WireCodec<Id, Version, Dto>` and an immutable
`WireContractRegistry`. A codec owns one public wire shape and provides non-throwing
`validate`, `decode`, and `encode` methods returning `Result`. Its descriptor fixes the stable ID,
positive safe-integer version, optional kind and embedded `schemaVersion`, recursive unknown-field
rejection, formatting and terminal-LF policy, declared source migrations, and conservative
compatibility policy.

Codec schemas remain private implementation details and infer their DTO types. Named `to*Dto`
mappers enumerate public fields explicitly; domain values are never spread into a public DTO and
excluded lifecycle errors, ports, functions, and implementation bundles are not read. Decoding
parses once, rejects unknown keys recursively, distinguishes unsupported embedded versions, and
returns frozen sanitized errors without causes, stacks, or raw payloads. Encoding validates first
and preserves the accepted property, array, and dynamic-record order.

`createWireContractRegistry(codecs, mappings)` validates descriptors, methods, identities,
versions, migrations, mappings, and references before returning defensively owned frozen views.
Distinct versions of the same ID may coexist; exact lookup uses `get`, `latest` selects the highest
numeric version, and `forCommand` resolves a supplied command projection. Unknown lookups return
`undefined`. Generic core code does not import the CLI command catalog.

The CLI owns the production mapping and asserts that it exactly closes the JSON-capable paths
derived from the current command specs. The production codec inventory, in declared order, is:

```text
agents@1, health@1, commands@1, config-get@1, config-list@1,
flip@2, install@1, list@2, uninstall@1, verify@1,
error@1, capability-snapshot@1
```

The dedicated public entry points are `@skillsmith/core/contracts`,
`@skillsmith/core/contracts/v1`, and `@skillsmith/core/contracts/v2`. The root owns only registry
and shared codec types; versioned entry points own their exact DTOs, codecs, and explicit mappers.
Verify codec construction receives a validated tool registry, and the capability mapper projects
only immutable descriptor facts in canonical operation order.

### Subsequent production evolution

The inventory above records the adoption baseline. Later accepted P17 groups exercised the same
coexistence and explicit-version rules by adding versions without replacing their predecessors.
The current production registry, in declared order, is:

```text
agents@1, agents@2, health@1, health@2, commands@1, commands@2,
config-get@1, config-list@1, config-set@1, config-unset@1,
flip@2, flip@3, flip@4, install@1, list@2, list@3, status@1,
uninstall@1, verify@1, error@1, capability-snapshot@1
```

The current command mappings select `agents@2`, `commands@2`, `flip@4`, `health@2` for doctor,
`health@1` for check, and `list@3`; unchanged command families retain their accepted version-1
mapping. The public versioned entry points now extend through `@skillsmith/core/contracts/v4`.
This is an evolution of the accepted registry decision, not a replacement: older registered codecs
remain available for exact compatibility, and every current renderer still resolves its named
codec through the CLI-owned command mapping.

P19-T08 (2026-09-19, Decision Q3.A) adds one version-1 codec for the new read-only
`skillsmith cross-tool-names` report, reusing the same coexistence rules: the registry
inventory gains `cross-tool-names@1` (declared after `config-unset@1`), mapped from the
new command path. The DTO is intentionally minimal — `schemaVersion`, `kind`, and
`groups`, with no `selection` or `summary` — following the agents@2 precedent for a new
report family rather than extending the strict list@3 filter schema. No existing codec,
mapping, or accepted byte changes.

Remote search adds `search@1` after `plan-report@1` in the live registry. `skillsmith search` and
its `find` alias select that same codec. Its strict DTO has `schemaVersion: 1`,
`kind: "skillsmith.search"`, query/owner/limit/returned metadata, search type, and skill results.
The field-by-field mapper preserves provider order and identities. Results distinguish catalog
IDs, optional provider IDs, names, optional sources/counts, fixed-origin URLs, and unchecked
verification. They contain no installation signature. JSON uses two-space indentation and one
terminal newline. External provider JSON tolerates unknown fields; the owned wire DTO rejects
them recursively. Existing codecs and accepted output bytes retain their contracts.

Persisted artifacts use a second, deliberately distinct abstraction. `ArtifactCodec` operates on
owned bytes and maps versioned DTOs to immutable semantic models; it is not a `WireCodec`, and
`artifactContractRegistry` is not the CLI's `WireContractRegistry`. The single production artifact
registry owns this ordered inventory:

```text
manifest@1, lock@1, plan@1, ledger@1, ledger@2, journal@1
```

Concrete artifact codecs and DTO mappers are exported only from the versioned
`@skillsmith/core/contracts/v1` and `@skillsmith/core/contracts/v2` entry points. Shared
`ArtifactCodec` types remain available from `@skillsmith/core/contracts`; ordinary
`@skillsmith/core` exposes the registry and five read functions, not concrete codecs or a migration
executor. Registry, repository, contract barrels, and the placement compatibility facade do not
own duplicate parsers or serializers.

The artifact repository reads manifest, lock, saved plan, ledger, and journal files through only
`pathKind` and `readBytes`. It never locks or writes. A legacy project configuration is decoded as
manifest v1 with descriptive migration metadata, and ledger v1 is projected to the ledger v2 model
with byte/semantic revisions, canonical target source, and preserved legacy-journal identities.
That metadata conveys no write authority. Ledger v1 encoding remains compatibility-only; the
legacy mutable ledger facade refuses v2 before any write-side effect so it cannot truncate or
downgrade a newer ledger.

Artifact codecs recursively reject unknown fields, hostile non-ordinary inputs, invalid UTF-8 or
framing, and sensitive material before returning persistable bytes. Errors are fixed, bounded,
cause-free values that do not echo artifact contents, paths, parser details, or secret canaries.

Any public field, enum, meaning, embedded kind/version, property order, formatting, or framing
change is breaking under the conservative policy. It requires a new codec version; backward decode
is available only through an explicitly registered migration. Current CLI `WireCodec`s declare no
migrations. Artifact migration descriptors are limited to legacy project configuration to manifest
v1 and ledger v1 to ledger v2.

## Consequences

Public JSON now has one versioned owner, strict parsing, explicit domain projection, deterministic
bytes, and an extensible registry that can host fixture or future codecs without global mutation.
The CLI retains presentation and command-selection policy while core owns portable wire shapes.

Persisted artifacts likewise have one ordered production registry, one parser/serializer owner per
version, immutable read envelopes, and visible but non-executable migration descriptions. Keeping
the artifact and CLI wire registries separate avoids conflating text-command output with durable
filesystem state.

The cost is a larger explicit schema and mapper surface, plus deliberate version management for
changes that previously looked like renderer refactors. Recursive unknown-field rejection also
means additive fields are intentionally not silent compatibility changes.

## Alternatives considered

- **Keep renderer-local schemas.** Rejected because independent owners permit field, parsing, and
  framing drift.
- **Serialize domain reports directly.** Rejected because domain-only fields and future internal
  changes would become accidental public wire API.
- **Make the core registry own current command paths.** Rejected because command selection is CLI
  policy and fixtures or other embedders need independent mappings.
- **Adopt additive compatibility by default.** Rejected because unknown-field acceptance would make
  property and semantic changes invisible to conservative consumers.
- **Merge persisted artifacts into the CLI wire registry.** Rejected because repository decoding,
  byte framing, migration metadata, and portable-artifact policy are durable filesystem concerns,
  not command-output selection policy.

## References

- [ADR 0001 — Core/CLI split](0001-core-cli-split.md)
- [ADR 0002 — Result type](0002-result-type.md)
- [ADR 0007 — Tool-adapter registry](0007-tool-adapter-registry.md)
- [P17-G1-06 implementation plan](../../projects/p17/plans/P17-G1-06.md)
- [P17-G2-05 implementation plan](../../projects/p17/plans/P17-G2-05.md)
