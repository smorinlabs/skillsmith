# ADR 0004 — Declarative commands, one CLI runtime, and public application services

**Status:** Accepted (2026-07-12)

## Context

ADRs 0001–0003 keep Commander and terminal policy out of `@skillsmith/core`, but they do not stop
each CLI command from becoming its own runtime. Current command handlers independently construct the
environment, resolve context and configuration, choose renderers, map errors and exits, write to
process streams, and in one case invoke a prompt library. That duplication makes equivalent flags
behave differently and gives new commands several precedents to copy.

The core/CLI split remains correct. The missing boundary is between CLI invocation policy and the
semantic use case that an embedder can call.

## Decision

Every product command follows this direction:

```text
declarative CommandSpec
        -> shared CLI runtime
        -> public @skillsmith/core application service
        -> existing domain coordinators and adapters
        -> CommandOutcome<Report>
        -> shared CLI render/diagnostic/exit adapter
```

The core application contract is defined in `packages/core/src/application/types.ts`.
`CommandOutcome<T>` always contains a structured report, diagnostics, a semantic exit class, a
mutation summary, and deprecations. Exit classes are deliberately not numbers: only the CLI maps
them to the public exit-code taxonomy.

The exit classes include `failure`. The original planning sketch omitted the class corresponding to
exit code 1 even though current execution, verification, health, and integrity failures require it.
The complete semantic set is `success`, `failure`, `usage`, `state`, `capability`, `source`,
`permission`, `drift`, and `cancelled`.

Choice and confirmation are injected through `InteractionPort`. The CLI resolves TTY, JSON,
`--yes`, `--no-prompt`, and automation policy once when it constructs that port. Application
services may request a semantic choice or confirmation; they do not import a terminal or prompt
library.

`CurrentApplicationContext` is a migration-only composition context for G1-03. It may carry the
existing `ScanEnv` aggregate, resolved project context and effective configuration, interaction, and
cancellation signal so current behavior can move without creating duplicate real adapters.
`runVersionApplication` is the first service and a zero-discovery canary: it reads only the package
version and does not inspect its request context, cwd, environment, project, or configuration.

### Dependency boundaries

- Core application services are the top core orchestration layer. Domain, adapter, and codec modules
  must not import them.
- Application services import no CLI package, Commander, renderer, terminal library, numeric exit
  mapping, or process-output policy.
- CLI command specifications declare metadata and point to public application exports. They do not
  construct environments, prompt, render, write, or exit.
- The shared CLI runtime alone owns Commander usage mapping, inherited invocation context,
  environment/TTY/signals, interaction policy, renderer selection, stdout/stderr, numeric exits,
  redaction, deprecations, and cancellation.
- Output renderers consume reports and public DTOs; they do not import command modules.
- Core effects are allowed only through injected, testable capabilities. “No ambient or CLI-owned
  I/O” replaces the obsolete shorthand that core has no I/O effects at all.

The CLI runtime/spec migration and its lint zones are enforced across every current command. One
generic action factory resolves declarative application and report keys; command modules retain
only temporary pure compatibility exports required by existing consumers.

## Explicit deferrals

- **G1-04 / ADR 0005:** replace service use of aggregate `ScanEnv` with capability-scoped path,
  read, write, lock, process, Git, clock, and ID ports. `ScanEnv` remains a 1.x compatibility facade;
  it is not precedent for new application services.
- **G1-05:** derive tool capabilities from validated descriptors and adapter bundles.
- **G1-06:** introduce the canonical wire-contract/DTO registry and codec-owned JSON schemas. G1-03
  preserves current report and output bytes.
- **G1-07:** add operation context, observer events, and the shared diagnostic sink.
- **G6:** generate grouped/progressive help, completion, command references, and documentation from
  command metadata. G1-03 records metadata without activating those UX changes.

## Consequences

### Positive

- Current commands can migrate one at a time behind one stable outcome and service contract.
- Embedders call semantic services without emulating Commander or parsing terminal output.
- Interaction, rendering, diagnostics, cancellation, and exit policy gain one owner.
- The version canary proves that cheap commands need not trigger environment or project discovery.

### Negative

- G1-03 temporarily exposes an aggregate compatibility context that G1-04 must narrow.
- Command migration adds an adapter layer around already-public domain coordinators.
- Existing public reports constrain the temporary render adapters until G1-06 introduces canonical
  wire DTOs and codecs.

## Alternatives considered

- **Keep command-local orchestration and share helpers.** Rejected because helpers do not create one
  owner for I/O, interaction, and exit behavior.
- **Move Commander or renderers into core.** Rejected because it breaks embeddability and ADR 0001.
- **Wait for capability-scoped ports before introducing services.** Rejected because it couples two
  independently reviewable migrations and encourages more commands to copy the current runtime.
- **Assign numeric exit codes in core.** Rejected because numeric process policy belongs to the CLI.

## References

- [ADR 0001 — Core/CLI split](0001-core-cli-split.md)
- [ADR 0003 — ESLint import boundaries](0003-eslint-import-boundaries.md)
- [Architecture](../architecture.md)
- `packages/core/src/application/types.ts`
- `packages/core/src/application/current-services.ts`
