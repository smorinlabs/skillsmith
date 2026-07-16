# ADR 0009 — Operation-scoped typed observation

**Status:** Accepted (2026-07-12)

## Context

Commands need correlated diagnostics without making logs a second source of truth. The existing
`Logger` surface emits free-form scan strings, while global quiet, verbose, and debug options are
parsed but do not consistently control output. Future planning and recovery work also needs stable
operation identity. At adoption, durable transaction, retry, and recovery correlation remained
downstream; P17-G3B-06 subsequently closed that propagation boundary without changing this ADR's
event registry or authority model.

Observation must not change a command result, expose secrets, introduce telemetry dependencies, or
move presentation policy into core. Existing human and JSON bytes in normal mode remain public
compatibility constraints.

## Decision

Core owns an immutable `OperationContext`, a closed typed event registry, strict event construction,
and a best-effort `ObserverPort`. Context creation receives focused clock and ID capabilities;
child, target, and retry derivations preserve explicit identity rules. A registry-bound
`ObservationEmitter` validates tool identity, owns paired-span correlation and duration, invokes
observers in authored order, and contains synchronous throws and asynchronous rejections. Observer
results are never read by domain or state code.

Events carry only closed scalar payloads and normalized error codes. Recursive redaction is pure,
bounded, cycle-safe, proxy/accessor-safe, and produces owned frozen values. Events are not persisted
and are never error authority; structured `CommandOutcome` diagnostics and canonical error
envelopes remain authoritative.

The CLI owns the sole diagnostic observer and presentation policy. Normal mode preserves current
bytes, quiet suppresses human success stdout but not errors or canonical JSON, verbose emits stable
command/plan/operation detail, trace emits all event kinds, and debug emits compact redacted events.
Observation detail is stderr-only. Parser/preflight failures occur before a valid operation
lifecycle and emit no event.

Execution uses exactly three causal context levels. The CLI-created command context is the root;
the scheduler derives a child from each deterministic planned operation only when that operation
actually starts; and durable swap/recovery authorities reconstruct transaction context from the
logical journal. Application and acquisition edges own `plan.created`, the scheduler owns
operation spans, swap/writer boundaries own durable transaction stages and terminal events, and
recovery wrappers own recovery spans. Unstarted work receives no fabricated lifecycle.

The 1.x `Logger` remains only as a deprecated compatibility facade. Current scan, inventory,
doctor, and verify paths use typed observation when supplied; Logger-only callers are adapted
through a private synthetic context that preserves their exact current strings.

## Consequences

Commands and current read workflows gain deterministic correlation and verbosity without coupling
core to process IO or telemetry. Observer failure cannot alter rendering, exits, state, or recovery,
and hostile values cannot leak through debug diagnostics.

The cost is explicit event payload and lifecycle maintenance, plus a temporary Logger adapter.
P17-G3B-06 implements planner-edge, transaction, journal, rollback, retry, resume, and recovery
correlation through private source-module seams. Pure planners, repositories, codecs, public
reports, and wire formats remain observation-free. Events and observer objects are not persisted;
logical journals remain the durable semantic authority.

## Alternatives considered

- **Keep free-form Logger messages.** Rejected because messages do not provide closed correlation or
  safe structured diagnostics.
- **Use events as errors or state.** Rejected because observer failure would then change semantics
  and recovery authority.
- **Persist events now.** Rejected because persisted observation would add a durable schema and
  recovery authority outside the accepted scope.
- **Adopt a telemetry SDK.** Rejected because the current requirement is local diagnostics with no
  new dependency or external transport.

## References

- [ADR 0004 — Command runtime/application boundary](0004-command-runtime-application-boundary.md)
- [ADR 0005 — Capability-scoped ports](0005-capability-scoped-ports.md)
- [ADR 0007 — Tool-adapter registry](0007-tool-adapter-registry.md)
- [P17-G1-07 implementation plan](../../projects/p17/plans/P17-G1-07.md)
- [P17-G3B-06 implementation plan](../../projects/p17/plans/P17-G3B-06.md)
