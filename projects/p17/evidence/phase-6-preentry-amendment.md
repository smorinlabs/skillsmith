# Phase 6 pre-entry sequencing and completion dependency amendment

## Authority and approval

- Product context: Skillsmith is an open-source Bun CLI for discovering, developing, installing,
  and managing agent-skill packages. This amendment concerns local parser, help, completion,
  packaging, and release-validation behavior only.
- User approval: on 2026-07-25 the user approved the recommended Phase-6 reordering and requested a
  fresh evaluation of upgrading Commander so Skillsmith can use `@bomb.sh/tab` where it is a fit.
- Boundary: this amendment changes Phase-6 dependencies and records implementation constraints. It
  advances no Phase-6 entry, group lifecycle, entity, validation, review, approval, or exit gate.

## Approved dependency order

```text
P17-G6-02A
  |-- P17-G6-02B --\
  `-- P17-G6-03  ---+--> P17-G6-01 --> P17-G6-04
```

- P17-G6-02A remains dependent on signed P17-G5-04 and P17-G5-05.
- P17-G6-02B remains dependent on P17-G6-02A.
- P17-G6-03 now depends on P17-G6-02A.
- P17-G6-01 now depends on P17-G6-02B and P17-G6-03.
- P17-G6-04 now depends on P17-G6-01 and transitively on all earlier Phase-6 groups.
- Stable group-ID display order is preserved. The catalog validator now treats same-phase ordering
  as an acyclic dependency graph rather than incorrectly requiring dependencies to appear on an
  earlier table row; its existing cycle and phase-rank checks remain authoritative.

## Isolated Commander and tab spike

- Isolation: the committed tree remained untouched while HEAD `60a6b322e05e42268974457eaf76002254be0802`
  was exported to a disposable directory. The spike upgraded `commander` from 12.1.0 to 15.0.0,
  then separately added `@bomb.sh/tab` 0.0.21.
- Commander release boundary: 15.0.0 is ESM-only and requires Node 22.12 when used under Node.
  Skillsmith is already ESM and supports Bun 1.3.14 or later, so neither constraint widens or
  narrows the declared runtime surface.
- Broad parser/CLI characterization: 387 passed and one failed across 388 tests in completion,
  CLI contracts, and EWP-P1-TS07. The only failure was pre-parse default observation for lone
  negated `--no-prompt` and `--no-verify` options after Commander 15 moved their implicit `true`
  default to parse time.
- Minimal correction: apply the authoritative `parsedDefault` to negated options explicitly in
  `optionForSpec`. The two focused default/permutation tests then passed, followed by 41 completion
  plus EWP-P1-TS07 tests and TypeScript typechecking with zero failures.
- Independent lanes: `bun run test:smoke` passed 5 tests with 3,737 assertions; native Linux x64
  and ARM64 compilation passed. Commander 12 and Commander 15 produced the same 114,010,256-byte
  ARM64 binary in this Bun build.
- tab footprint: importing the Commander adapter increased that binary to 114,206,864 bytes, a
  196,608-byte (0.172%) increase. The installed package occupied approximately 124 KiB and declared
  no ordinary runtime dependency; Commander is an optional peer.
- Primary release references: Commander
  [`CHANGELOG.md`](https://github.com/tj/commander.js/blob/master/CHANGELOG.md) and `@bomb.sh/tab`
  [`package.json`](https://github.com/bombshell-dev/tab/blob/main/package.json),
  [Commander adapter](https://github.com/bombshell-dev/tab/blob/main/src/commander.ts), and
  [README](https://github.com/bombshell-dev/tab/blob/main/README.md).

## Integration finding and recommendation

- Compatibility is solved by Commander 15: `@bomb.sh/tab` 0.0.21 declares Commander
  `^13.1.0 || ^14.0.0 || ^15.0.0`.
- Direct live-adapter attachment is not contract-compatible. Using the existing command name throws
  because `completion` already exists. Using the adapter default adds `complete` as a 24th
  parser-visible command; the adapter also offers PowerShell, omits Skillsmith aliases from its
  candidate graph, and completes all Commander parser choices rather than command-specific
  `allowedValues` (for example it offers system/managed scope to `install`).
- Go forward with Commander 15 in G6-02A and exact `@bomb.sh/tab` 0.0.21 in G6-02B, but keep a thin
  Skillsmith-owned adapter. Feed the tab candidate engine from `CommandSpec` (directly or through a
  detached metadata-only Commander graph), preserve the existing public `completion` command, and
  route tab-time candidate requests before public parser construction through a bounded internal
  transport.
- Keep Bash, Zsh, and Fish only for 1.0. Preserve exact aliases, inherited plus local options,
  command-specific allowed values, recursive `config` subcommands, local path/skill/manifest
  providers, zero network, zero shell-file mutation, deterministic script bytes, bounded latency,
  bounded output, and empty-selection non-widening.

## Required implementation validation

- G6-02A must run the current parser/options/help characterization, explicit negated-default tests,
  typecheck, smoke, and native build before the Commander lockfile change is accepted.
- G6-02B must run EWP-CMD-COMPLETION-TS01..06 and EWP-P6-TS02, plus shell syntax checks, the
  23-command/alias/allowed-value graph, internal-transport isolation, zero-network/startup-file
  canaries, local-provider bounds, latency/output caps, and deterministic-byte checks.
- G6-01 must prove packaged completion bytes equal the G6-02B generated bytes before clean-install
  validation.

## Amendment validation

- `bun test scripts/p17-catalog.test.ts --timeout 30000`: 72 passed, 0 failed, 299 assertions.
- `bun test tests/ergonomics/phase/EWP-P0A-TS05.test.ts --test-name-pattern EWP-P0A-TS05`:
  15 passed, 0 failed, 51 assertions.
- `bun scripts/p17-catalog.ts --check`: 426 entities, 419 required, 7 deferred, 244 validation
  obligations, 45 groups, deterministic checklist.
- `bun run check:p17`: PR-openable; 6/7 required phases approved, 39/44 required groups signed off,
  no active group, 5 planned groups, 379/419 required entities signed off, and 40 incomplete.
- `bunx biome check scripts/p17-catalog.ts scripts/p17-catalog.test.ts projects/p17/catalog.json`:
  passed with no fixes.
- `git diff --check`: passed with no diagnostics.
- Required skips: none.

## Gate boundary

Phase 6 remains planned. Its five groups remain planned, all Phase-6 group gates remain pending,
and all Phase-6 entities remain planned until the separately reviewed Phase-6 entry gate passes.
