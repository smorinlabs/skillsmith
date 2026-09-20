# skillsmith (CLI)

The command-line interface for Skillsmith. See the root [README](../../README.md) for install instructions, quickstart, and supported commands.

Source layout:

> P17 disposition: current command layout; authority: packages/cli/src/program.ts

```
src/
  index.ts         process entry, signal handling, and final error/exit mapping
  program.ts       command registration and global CLI policy
  commands/        command handlers for inventory, diagnostics, config, verify, and lifecycle verbs
  completion/      shell completion renderers
  contracts/       reviewed command/option surface snapshots
  output/          pure renderers (markdown, JSON)
  help/            help-topic text
  util/            color resolver, exit-code mapping, SIGINT handler
```

The 25 current public commands are `search`, `agents`, `list`, `config`, `check`, `apply`, `commands`, `cross-tool-names`, `completion`, `dev`, `doctor`, `export`, `gc`, `help`, `init`, `install`, `plan`, `promote`, `status`, `sync`, `undo`, `uninstall`, `update`, `verify`, and `version`. Their aliases, options, examples, and exit meanings are generated in the root [command reference](../../docs/commands.md).

`search [query...]` and its `find` alias query the experimental skills.sh catalog. The default
deadline is two minutes across connection, body reads, and retries; `--timeout` overrides it.
The decoded response ceiling is 10,000,000 bytes per attempt; `--max-response-size` overrides it.
The CLI owns the optional live picker, terminal cleanup, and human/`search@1` JSON rendering.
Search has a focused application context with no inventory or installation capabilities.
Picker selection displays details. See the root [search guide](../../README.md#search-the-remote-catalog)
for units, interaction eligibility, errors, and provider limitations.

`status [skill...]` is a read-only correlation view over desired manifest state, the lockfile,
placement ledger records, and live tool installations. Use `--json` for the versioned `status@1`
wire report or `--check` to return exit code 7 when the selected state contains drift.

Human output is written to stdout and diagnostics to stderr. Semantic Chalk styling is enabled
only when the destination is an eligible TTY. `--color always` opts in on an eligible TTY but
never through a pipe; `--no-color`, `--color never`, standard disable variables, and every JSON
report remain free of ANSI control sequences. `--quiet` suppresses the human report and
observation detail while retaining warnings, deprecations, errors, refusals, and cancellation
diagnostics on stderr; it does not suppress requested JSON data.

`cli → core` is the only allowed import direction, and the CLI only imports `@skillsmith/core` via its public entry (no deep paths). See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the enforced boundary rules.

## License

[Apache-2.0](../../LICENSE).
