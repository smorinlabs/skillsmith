# SkillSmith MVP-2a design — "Config and completion (support)"

**Status:** Approved 2026-04-24
**Scope:** Ships the two self-contained support utilities so TOML config format and shell completion plumbing exist before MVP-2b (`list`/`doctor`) consumes them.
**Release framing:** Internal milestone (`v0.2.0`, no public release). First public release is still gated on MVP-2b per the phase doc.
**Prerequisite:** MVP-1 complete (`v0.1.0`), including the round-1 bug audit.

## 1. Background

MVP-2a delivers two self-contained utility commands — `config` and `completion` — plus the TOML configuration layer they expose. Config is intentionally ordered before any state-modifying command so the schema stabilizes against zero consumers before MVP-2b reads it and MVP-2c writes through it.

This spec covers MVP-2a only. MVP-1 is at `v0.1.0`; the broader CLI surface lives in `research/skillsmith-cli-design.md`; per-command detail in `research/commands/`; release phasing in `research/skillsmith-phases.md`.

## 2. Scope

### 2.1 User-facing CLI commands

- `skillsmith config get <key> [--scope <s>] [--json]`
- `skillsmith config set <key> <value> [--scope <s>]`
- `skillsmith config list [--scope <s>] [--json]`
- `skillsmith config unset <key> [--scope <s>]`
- `skillsmith completion <bash|zsh|fish>` — emits a shell-specific completion script on stdout.

PowerShell completion is deferred to MVP-2b (tracked in `research/skillsmith-phases.md`).

### 2.2 Configuration layers, high → low precedence

1. CLI flag (already in MVP-1; not governed by this spec).
2. `SKILLSMITH_<KEY>` env var (e.g. `SKILLSMITH_TOOL`, `SKILLSMITH_SCOPE`, `SKILLSMITH_PATH`, `SKILLSMITH_REGISTRY`).
3. `--config <file>` flag (explicit single file; already declared in MVP-1 as a global flag, now given meaning).
4. `$SKILLSMITH_CONFIG` env var (explicit single file).
5. Project file: `./skillsmith.toml`, discovered by walking up from CWD and stopping at the git repo root (or filesystem root if not in a repo).
6. User file: `$XDG_CONFIG_HOME/skillsmith/config.toml`, fallback `~/.config/skillsmith/config.toml`.
7. System file: `/etc/skillsmith/config.toml`.
8. Built-in defaults.

**Merge strategy:** per-key override (git/gh precedent). Each resolved key uses the highest-priority layer that set it; no wholesale layer takeover.

**Precedence of `--config` vs `$SKILLSMITH_CONFIG`:** flag wins. Standard CLI convention.

### 2.3 TOML schema (v0.2.0)

Strict: zod-validated, unknown top-level keys or unknown `[section]` keys cause exit 3.

```toml
# all keys optional; omit rather than leaving blank

tool = "claude-code"          # SupportedTool
scope = "user"                # "system" | "user" | "project"
path = "/custom/path"         # string, free-form; meaning wired in MVP-2c

[registry]
default = "github.com/acme"   # string
```

### 2.4 `config` command semantics

**Key namespace:** dotted paths. Top-level keys: `tool`, `scope`, `path`. Nested keys: `registry.default`. New keys require a schema update + this doc update.

**`config get <key>`:**
- No `--scope`: prints the *effective* value (post-merge) to stdout, followed by a newline; exits 0.
- `--scope=user|project|system`: prints only that layer's raw value (ignoring env/flag); exits 0 if set, 1 if unset in that layer.
- Unknown key name: exit 2 with a did-you-mean hint.
- `--json`: emits `{ "key": "...", "value": "...", "source": "user" }` on stdout.

**`config set <key> <value>`:**
- Default: writes to user config. `--scope=project|system` overrides target layer.
- `project` scope with no `skillsmith.toml` found creates it at CWD (not walked-up location).
- `system` scope requires elevated privileges; a permission error exits 6 (reusing the MVP-1 exit code reservation — no new code wiring, the fs error propagates through the `config-error` variant with an `errno` hint).
- Writes are atomic: write-temp-then-rename in the target directory, plus `proper-lockfile` around the operation so concurrent `config set` calls don't corrupt the file.
- Emits no output on success; `-v` prints the written file path.

**`config list`:**
- Default: prints effective config as `key = value` lines (TOML-ordered), one per line, to stdout. Each line is followed by a trailing `# source: <layer>` comment on the same line (not stderr — keeps lines self-contained for grep).
- `--scope=user|project|system`: prints only that layer's raw values.
- `--json`: emits `{ effective: {...}, sources: {...<key>: <layer>}, layers: { defaults: {...}, system: {...}, ... } }`.

**`config unset <key>`:**
- Default: removes from user config. `--scope` overrides.
- If already unset: exit 0 with a stderr notice (idempotent, per the MVP-1 precedent).
- Atomic + locked, same as `set`.

### 2.5 `completion` command

Emits a self-contained completion script to stdout for the requested shell. Static only — no dynamic completions in MVP-2a.

Coverage per shell:
- Subcommand names: `agents`, `config`, `completion`, `help`, `version`.
- Global flag names: `--help`, `-h`, `--version`, `-V`, `--verbose`, `-v`, `--quiet`, `-q`, `--no-color`, `--color`, `--cd`, `-C`, `--debug`, `--config`, `--no-prompt`.
- Per-command flag names and values:
  - `agents`: `--tool <enum>`, `--detected-only`, `--format markdown|json`.
  - `config get|set|list|unset`: `--scope system|user|project`, `--json` (on get/list).
  - `completion`: positional enum `bash|zsh|fish`.
  - `help`: positional `<topic>` with the 6 MVP-1 topics + known subcommand names.

Install instructions printed as a comment header in each script (e.g. `# To install: skillsmith completion bash > /etc/bash_completion.d/skillsmith`).

**Single source of truth: the commander program.** The `completion` command walks `program.commands` and each command's options at runtime; it does not maintain a separate spec. Every enum flag and every enum-valued positional argument uses `.addOption(new Option(...).choices([...]))` (or `.argument('<x>', '...', new InvalidArgumentError(...))` with an explicit `choices` wrapper) so enum values live on the commander nodes themselves. Adding a new flag automatically makes it completable with zero further action; no drift surface exists.

**Dev script:** `scripts/preview-completions.ts` renders all three shell scripts back-to-back with `=== <shell> ===` headers, for eyeballing output and reviewing diffs during development. Not shipped in the binary — local-only convenience.

### 2.6 Exit codes wired or re-used in MVP-2a

- `0` success (unchanged).
- `1` generic (unchanged); used by `config get <key>` when a specific-scope lookup finds no value.
- `2` usage (unchanged); unknown key, unknown shell, unknown scope.
- `3` **new:** malformed config (TOML parse error, schema violation, unknown key).
- `6` permission (unchanged; re-used when writing system config without privilege).

### 2.7 Global flag changes

- `--config <file>` — already declared in MVP-1, now wired to actually load that file as the explicit-file layer.
- `--no-prompt` — already declared in MVP-1; no new semantics in MVP-2a (no command prompts yet).

### 2.8 Explicit deferrals

- PowerShell completion → MVP-2b (when Windows CI arrives).
- `--scope=project` walk-up behavior for `set`: in MVP-2a, project-scope writes target `./skillsmith.toml` in CWD only; walk-up discovery applies to *reads* but writes always target CWD. Documented explicitly to avoid surprise.
- Dynamic completions (skill names, source refs) → Phase 2.
- Config schema migration tooling → Phase 2 (no migrations needed at v0.2.0; the schema is new).
- `config edit` (shell out to `$EDITOR`) → not in scope; add if requested later.
- Values layering (`skillsmith.values.toml`, `--set`) → MVP-5, not MVP-2a. These are per-skill config, not CLI config.

## 3. Library surface additions (`@skillsmith/core`)

New public exports:

```ts
// types
export type Scope = 'system' | 'user' | 'project';
export type ConfigLayer = 'defaults' | 'system' | 'user' | 'project' | 'explicit-file' | 'env';

export interface Config {
  tool?: SupportedTool;
  scope?: Scope;
  path?: string;
  registry?: { default?: string };
}

export interface EffectiveConfig {
  value: Config;                              // merged view
  sources: Partial<Record<keyof Config, ConfigLayer>>;
  layers: Record<ConfigLayer, Config>;        // raw per-layer, for list --json
}

export interface LoadConfigOpts {
  explicitFile?: string;                      // from --config flag
  cwd?: string;                               // for project walk-up
  logger?: Logger;
  signal?: AbortSignal;
}

export interface SaveConfigOpts {
  scope: Scope;
  patch: Partial<Config>;                     // merged into existing layer
  delete?: readonly (keyof Config)[];         // keys to remove
  cwd?: string;                               // for project target
}

// functions
export const loadConfig: (env: ScanEnv, opts?: LoadConfigOpts) => Promise<Result<EffectiveConfig, SkillSmithError>>;
export const saveConfig: (env: ScanEnv, opts: SaveConfigOpts) => Promise<Result<{ file: string }, SkillSmithError>>;
export const getConfigPath: (env: ScanEnv, scope: Scope, cwd?: string) => string;
```

New `SkillSmithError` variant:

```ts
| { code: 'config-error'; message: string; file?: string; line?: number }
```

Exit-code mapping addition:

```ts
case 'config-error': return 3;
```

## 4. Architecture

### 4.1 New runtime deps

- `smol-toml` — TOML parse + serialize in library.
- `proper-lockfile` — cross-process lock around config writes.

No other deps. `@clack/prompts`, `gray-matter`, and `env-paths` remain deferred.

### 4.2 Directory layout additions

```
packages/core/src/
  config/
    types.ts          # Config, ConfigLayer, EffectiveConfig, LoadConfigOpts, SaveConfigOpts
    schema.ts         # zod schema for TOML validation
    paths.ts          # scope → file path (XDG + fallbacks + project walk-up)
    env.ts            # SKILLSMITH_<KEY> env → partial Config
    load.ts           # loadConfig: gather all layers, merge per-key
    save.ts           # saveConfig: atomic write + proper-lockfile
packages/cli/src/
  commands/
    config.ts         # dispatcher for get/set/list/unset subcommands
    config/
      get.ts
      set.ts
      list.ts
      unset.ts
    completion.ts     # shell dispatcher
  completion/
    walk.ts           # commander Command → CompletionNode[] (internal AST)
    types.ts          # CompletionNode, CompletionOption
    bash.ts           # render(nodes) → bash script string
    zsh.ts
    fish.ts
scripts/
  preview-completions.ts  # dev-only: prints bash + zsh + fish back-to-back
```

### 4.3 ESLint zones to add

Core:
- `packages/core/src/config/**` must not import from `packages/core/src/agents/**` or `packages/core/src/detect/**` or `packages/core/src/scan/**`. Config is a sibling leaf, not a consumer of domain modules.

CLI:
- `packages/cli/src/completion/**` must not import from `packages/cli/src/commands/**`, `packages/cli/src/output/**`, `packages/cli/src/help/**`. It receives a commander `Command` instance from the caller (the `completion` command passes the program in) and must not know about any specific subcommand implementation. The one allowed import is the `commander` package itself (to access `Command`/`Option` types).
- `packages/cli/src/commands/config/**` may import from `packages/cli/src/commands/config.ts` (the dispatcher re-exports these) and from `@skillsmith/core`. Standard command-module layering.

### 4.4 Project walk-up rule

`loadConfig` walks up from `cwd` looking for `skillsmith.toml`, stopping at:
1. The first directory containing `skillsmith.toml` → use it.
2. The first directory containing `.git` (file or directory) → stop walk (no project config).
3. Filesystem root → stop walk.

This is the MVP design-doc rule and matches cargo/npm. A `skillsmith.toml` above a `.git` boundary is not discovered — intentional, prevents parent-repo leakage.

### 4.5 Atomic write protocol (for `saveConfig`)

1. Acquire lock on `<target>.lock` via `proper-lockfile` (stale > 10s, retries 0).
2. Read existing content from `<target>` if it exists; merge `patch` keys in, remove keys in `delete`.
3. Serialize to TOML via `smol-toml`.
4. Write to `<target>.tmp.<random>` in the same directory (so rename is atomic on same filesystem).
5. `fs.rename(<target>.tmp.<random>, <target>)` — atomic replace.
6. Release lock.

Lock release is registered via the MVP-1 SIGINT handler hook so Ctrl-C during a `config set` doesn't leave a stale lock.

### 4.6 `completion` generation pipeline

Runtime introspection of the commander program tree. No hand-maintained spec. Three stages:

1. **Walk:** `walk(program: Command): CompletionNode[]` traverses `program.commands` recursively. For each command it captures: name, description, `option.long`/`short`/`flags`/`argChoices`, and positional arguments with choices. Output is an internal `CompletionNode` tree — a shell-agnostic AST.
2. **Render:** one renderer per shell (`bash.ts`, `zsh.ts`, `fish.ts`). Each consumes the AST and emits a complete script string.
3. **Dispatch:** the `completion <shell>` command picks the renderer and prints the result.

**Single source of truth requirements** (enforced by the lint rule in §4.3 and a test in §5.2):

- Every enum flag uses `.addOption(new Option(...).choices([...]))`. Plain `.option('--foo <enum>', ...)` is disallowed because it hides the enum from `argChoices`.
- Every enum-valued positional uses `.addArgument(new Argument('<x>', '...').choices([...]))`.
- Commands declared via `program.command('name')` are already introspectable.

When a developer adds a new flag, it becomes completable on the next build with no further action — zero drift surface because there is no parallel spec to drift from.

**Dev preview:** `scripts/preview-completions.ts` imports the configured commander program, walks it, and prints bash/zsh/fish output back-to-back for quick review:

```
$ bun run scripts/preview-completions.ts
=== bash ===
# To install: ...
_skillsmith() { ... }
complete -F _skillsmith skillsmith

=== zsh ===
#compdef skillsmith
...

=== fish ===
complete -c skillsmith ...
```

This is strictly local tooling — not bundled into the binary.

## 5. Testing strategy

### 5.1 Library (`@skillsmith/core`)

- **Schema:** table-driven zod parse — happy path, every unknown-key error variant, every type-mismatch variant.
- **Paths:** per-platform (darwin, linux, win32 — shimmed via test `ScanEnv`) + XDG override + `SKILLSMITH_CONFIG` env.
- **Project walk-up:** fake filesystem with/without `skillsmith.toml`, with/without `.git`, at various depths.
- **loadConfig:** 8 layer-precedence scenarios — each key resolved from expected layer given combinations of what's set where.
- **saveConfig:** fresh-write, merge-into-existing, unset-key, round-trip preservation of unrelated keys and comments (comment preservation is best-effort; we note if lost).
- **Lock contention:** simulate two concurrent writes, assert one retries and both end with coherent state.

### 5.2 CLI (`skillsmith`)

- **`config get|set|list|unset`:** golden-output tests per subcommand, covering happy path + every listed error.
- **`completion` renderers:** snapshot tests per shell — bash, zsh, fish. Feed the walker a minimal fixture `Command` built inline and assert the rendered script contains specific completable items (subcommand names, flag names, enum values). Snapshots live under `packages/cli/tests/completion/__snapshots__/`.
- **Commander declaration gate:** a test walks the *real* configured program tree and asserts that (a) every subcommand has a description, (b) every enum-typed option uses `argChoices` (i.e. was declared via `.addOption(new Option(...).choices([...]))`), and (c) every enum-typed positional uses `Argument.argChoices`. Drift — e.g. someone adding `.option('--format <fmt>', ...)` without `choices` — fails CI immediately.
- **Exit-code integration:** each new exit-3 path tested via the binary, asserting the code.

### 5.3 Coverage gate

Still not enforced in MVP-2a. Re-evaluate at MVP-2b (`doctor` adds the first real observability surface).

## 6. Success criteria

1. `bun run check` → all green; ESLint boundaries enforce the new zones.
2. `bun test packages/core/src/config` alone passes (library exercisable standalone).
3. `./skillsmith config set tool claude-code && ./skillsmith config get tool` round-trips correctly, writes live at `$XDG_CONFIG_HOME/skillsmith/config.toml`.
4. `./skillsmith config list --json | jq '.sources.tool'` returns `"user"`.
5. `./skillsmith config set tool xxx` → exit 3 with a readable schema error.
6. Malformed user config causes any command to exit 3; `doctor` will surface this cleanly in MVP-2b.
7. `./skillsmith completion bash | head -3` shows a bash script comment header with install instructions.
8. `bun run scripts/preview-completions.ts` dumps all three shell scripts with `=== <shell> ===` headers.
9. Commander declaration-gate test fails if an enum flag is added via plain `.option()` without `choices`, or if a new subcommand lacks a description.
10. Concurrent `config set` (two processes) leaves a valid TOML file; test via `Bun.spawn` × 2.
11. `v0.2.0` tag cut internally after all of the above.

## 7. Out-of-scope reminders

- No PowerShell (→ MVP-2b).
- No `config edit` (shells to `$EDITOR`).
- No schema migrations (v0.2.0 is the first schema).
- No values layering (skill-level `values.toml`; that's MVP-5).
- No multi-registry config (`registry.<name>` — only `registry.default` in MVP-2a).
- No hosted registry; `registry.default` stores a base URL only.
- No changes to MVP-1's public API beyond additive exports listed in §3.
- No Windows in CI (still deferred to MVP-2b).

## 8. Open questions

None blocking implementation. Noted for MVP-2b:
- How `doctor` presents config-parse errors alongside detected-tool errors.
- Whether `config list --verbose` shows layer-origin per value or defers to `--json`.
