# ADR 0008 — Versioned wire codecs and an immutable contract registry

**Status:** Accepted (2026-07-12)

## Context

Current CLI JSON is public wire behavior, but its schemas, field projection, and serialization are
owned independently by command renderers. That makes schema drift possible: a domain field can leak
through object spreading or schema stripping, a parser can accept fields another parser rejects,
and framing or property order can change without an explicit contract-version decision.

The accepted bytes must remain unchanged. Domain reports must also remain separate from public DTOs,
and the generic contract machinery must not know the current CLI command set. Persisted artifact
formats (manifests, locks, plans, ledgers, and journals) remain a later decision.

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

Any public field, enum, meaning, embedded kind/version, property order, formatting, or framing
change is breaking under the conservative policy. It requires a new codec version; backward decode
is available only through an explicitly registered migration. Current codecs declare no migrations.

## Consequences

Public JSON now has one versioned owner, strict parsing, explicit domain projection, deterministic
bytes, and an extensible registry that can host fixture or future codecs without global mutation.
The CLI retains presentation and command-selection policy while core owns portable wire shapes.

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
- **Migrate persisted artifacts in the same decision.** Rejected because repository decoding,
  migrations, and portable-artifact policy are owned by the Phase-2 artifact work.

## References

- [ADR 0001 — Core/CLI split](0001-core-cli-split.md)
- [ADR 0002 — Result type](0002-result-type.md)
- [ADR 0007 — Tool-adapter registry](0007-tool-adapter-registry.md)
- [P17-G1-06 implementation plan](../../projects/p17/plans/P17-G1-06.md)
