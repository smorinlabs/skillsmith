# ADR 0005 — Capability-scoped ports and one runtime adapter

**Status:** Accepted (2026-07-12)

## Context

`ScanEnv` made the original core testable, but it grew into one aggregate containing platform paths,
filesystem reads and writes, locking, arbitrary process execution, and version probing. A function
that only lists files can therefore also delete a tree or launch a process. Raw environment records,
ambient clocks and IDs, Git argv, and one direct network check create additional effect paths that
cannot be identified from a function signature.

ADR 0004 introduced application services without duplicating the real adapter. This ADR completes
that boundary while preserving the public 1.x `ScanEnv` facade for existing embedders.

## Decision

Core effects are represented by cohesive public ports in `packages/core/src/ports/types.ts`:

- `PlatformPaths`, `FileReadPort`, `FileWritePort`, `LockPort`, `PathAccessPort`, and `ProcessPort`
  own the existing platform, filesystem, lock, writable-directory diagnostic, and process
  operations. `PathAccessPort` keeps `fs.access` and the POSIX real UID reported by
  `process.getuid()` in the real adapter.
- `GitPort` exposes named repository operations instead of argv. `HttpPort` exposes one bounded
  request operation. Domain code cannot reach Git or HTTP through an arbitrary subprocess or
  ambient `fetch`.
- `ClockPort` separates wall, epoch, and monotonic time. `IdPort.nextId(purpose)` supplies current
  transaction and temporary-file identities.
- `RuntimePorts` is the flat composition aggregate for path/read/write/lock/process/clock/ID plus
  named `git` and `http` ports. Only adapter and application composition may name the aggregate.
  Domain functions accept focused structural intersections such as `InventoryReadPorts`.

Remote catalog search adds a separate `HttpReadPort` for GET status, selected headers, and a
bounded decoded body. The caller supplies a byte ceiling and one abort signal that remains active
through streaming. `TimerPort` supplies cancellable scheduling. `defaultSearchPorts()` composes
these capabilities with the existing clock from the same default adapter module, without creating
filesystem or process authority. Existing HEAD-only `HttpPort` and aggregate `RuntimePorts`
contracts remain compatible. Search's total deadline, retry policy, and response mapping belong
to the domain; fetch and decoded-byte accounting belong to `ports/http.ts`.

Raw environment input is decoded once into a frozen `ResolvedRuntimeConfiguration`. It contains
only the accepted config layer, explicit paths, current tool-specific homes/toggles, color flags,
and the decoded test-only journal pause. Platform PATH/XDG/home values belong to `PlatformPaths`.
Unknown values, including secret canaries, are discarded before application requests are built.

`defaultRuntimePorts()` is the sole production implementation of Node/Bun filesystem, process,
lock, platform, clock, and ID effects. The high-level Git and HTTP adapters are composed there.
Adapter failures reject with scalar-only `PortError` values; current public coordinators translate
them at their existing `Result<_, SkillSmithError>` boundary.

The deprecated public `defaultScanEnv()` remains supported through 1.x. It is a projection of the
same real adapters, not a second implementation. `runtimePortsFromScanEnv()` supports existing
fakes and compatibility entry points without adding Git, HTTP, clock, or ID members to `ScanEnv`.

Static lint and import rules enforce the ownership model: raw environment/cwd only at composition,
real filesystem/process/lock imports only in the default adapter, `fetch` only in the HTTP adapter,
Git argv only in Git infrastructure/compatibility, and ambient time/randomness only in the default
clock/ID implementation.

## Consequences

### Positive

- Signatures reveal the exact authority required by a domain operation.
- Read-only fakes cannot write, lock, or execute at compile time.
- Application behavior is deterministic under injected clocks and IDs.
- Git, HTTP, configuration, and adapter failures have one reviewable owner.
- Existing 1.x embedders retain the `ScanEnv` surface while new code stops depending on it.

### Negative

- Migrating the existing aggregate touches many signatures even when runtime behavior is unchanged.
- Compatibility code exists until the next major version.
- High-level Git operations require explicit request/result types instead of ad hoc argv.

## Alternatives considered

- **Keep splitting `ScanEnv` with `Pick`.** Rejected because it retains the aggregate as the source
  of authority and does not address Git, HTTP, configuration, clock, or ID ownership.
- **Remove `ScanEnv` immediately.** Rejected because it breaks the supported 1.x public API and
  existing injected fakes.
- **Give every module `RuntimePorts`.** Rejected because an aggregate composition object recreates
  the same excess-authority problem under a new name.
- **Let Git-aware code use `ProcessPort`.** Rejected because arbitrary argv is not an intent-level
  capability and cannot enforce repository safety centrally.

## References

- [ADR 0001 — Core/CLI split](0001-core-cli-split.md)
- [ADR 0003 — ESLint import boundaries](0003-eslint-import-boundaries.md)
- [ADR 0004 — Command runtime and application services](0004-command-runtime-application-boundary.md)
- [Architecture](../architecture.md)
- `packages/core/src/ports/types.ts`
- `packages/core/src/ports/errors.ts`
