# SkillSmith V1 library stack: a Bun-first, Clack-driven recommendation

**Build SkillSmith on Bun with citty + @clack/prompts + zod v4 + smol-toml + Bun's built-in file/glob/shell/fetch APIs, and ship it as a single binary via `bun build --compile`.** This stack borrows Claude Code's proven choices (Bun, Commander-family CLI, Zod, chalk-like styling, execa-like shelling, React-ish state patterns) but deliberately skips Claude Code's heaviest layer — a vendored React + Ink + Yoga terminal renderer — because SkillSmith's UI is a short, linear wizard (pick tools → pick scope → confirm → apply), not a persistent chat REPL. Clack gives you Claude-Code-grade prompt aesthetics for roughly 2% of the integration cost, dodges the documented Ink-on-Bun regressions, and keeps the compiled binary under ~60 MB. The reference tools split sharply on TUI philosophy — Claude Code uses React/Ink, Codex uses Rust/Ratatui, OpenCode and Kilo Code use Zig-backed OpenTUI + SolidJS — and that split tells you the TUI layer is the one place SkillSmith should pick based on *its own* interaction model, not imitate a reference tool.

## How the four reference tools actually stack up

Before recommending, here is the concrete picture of what each of the four reference tools uses, assembled from the March 2026 Claude Code source leak analyses, the `codex-rs` Cargo workspace, and the `sst/opencode` and `Kilo-Org/kilocode` repositories.

| Layer | Claude Code | Codex CLI | OpenCode | Kilo Code |
|---|---|---|---|---|
| Language / runtime | **TypeScript on Bun** (≥1.2) | **Rust** (edition 2024) | **TypeScript on Bun 1.3.11** | **TypeScript on Bun 1.3.11** (forks OpenCode) |
| CLI parser | `@commander-js/extra-typings` v14 | `clap` (derive) | `yargs` | `yargs` |
| TUI renderer | **Vendored Ink** + React 19 + vendored pure-TS Yoga, driven by `react-reconciler` | **Ratatui** on `crossterm` | **OpenTUI** (Zig core) + SolidJS | **OpenTUI** + SolidJS |
| Interactive prompts | Ink components + `useInput` hook | Custom Ratatui widgets | OpenTUI `Select`/`Input` renderables | Same (shared OpenTUI) |
| Styling | **chalk 5** (47+ imports), `figures`, `cli-boxes`, `wrap-ansi`, `strip-ansi` | Ratatui `Stylize`, `pulldown-cmark` | `shiki`, `marked`, `@pierre/diffs` | Same |
| Spinners | Custom Ink components (187 verbs in `spinnerVerbs.ts`) — no `ora` | Custom Ratatui | Custom OpenTUI | Same |
| Config format | JSONC (`.claude/settings.json`) + YAML front-matter in skills/agents | **TOML** (`~/.codex/config.toml`) | JSON / JSONC (`opencode.json`) | JSON / JSONC |
| Config parser | `jsonc-parser`, `yaml` | `serde` + `toml` crate | native JSON + Zod | native JSON + Zod |
| Schema validation | **Zod v4** (125+ imports), Ajv for JSON-Schema, Protobuf for telemetry | `serde` + generated JSON Schema | **Zod v4** | **Zod v4** |
| HTTP | **axios** + `undici` + `https-proxy-agent` | `reqwest` (tokio) | `fetch` + **Hono** server | `fetch` + Hono |
| Git | Shells out via **`execa`** | Shells out to `git` | Shells out via `cross-spawn` | Same, plus **git worktrees** for multi-agent isolation |
| Child process | `execa` 9, `tree-kill`, `shell-quote` | tokio/process | `cross-spawn` | `cross-spawn`, `@lydell/node-pty` |
| File system | `chokidar`, `picomatch`, `ignore`, `proper-lockfile`, `env-paths` — **no fs-extra, no globby** | std + `ignore` | Bun APIs + `@parcel/watcher` | Same |
| State management | **React hooks + Context only** — no Zustand/Jotai/XState. `Message[]` append-only log as single source of truth | Rust types + tokio channels | SolidJS signals | SolidJS signals |
| Testing | **`bun test`** | `cargo-nextest` + **`insta`** snapshots | `bun test` + Playwright E2E | `bun test` |
| Build | **`bun build`** (single `cli.js` ~7.6 MB) + per-platform native binaries via Bun's compile | `cargo` + `just` (+ Bazel internal) | Bun + Turborepo | Bun + Turborepo + `Bun.build --compile` per OS/arch |
| Distribution | npm + per-platform optional deps (`@anthropic-ai/claude-code-darwin-arm64` etc.) | npm shim → native binary, Homebrew, tarballs | install script, npm, Homebrew, Scoop, AUR, Nix | npm `@kilocode/cli`, VS Code Marketplace, GitHub Releases |

**The signal in this table:** only **Codex uses TOML** — every TS/Bun tool here uses JSON or JSONC. That means your TOML choice is a *gap* not covered by reference tools, and you will need to pick a library on its own merits. Conversely, **Zod v4 is unanimous** among the TS tools, and every TS tool has either moved to Bun (Claude Code, OpenCode, Kilo) or uses Node-only legacy patterns (none does). Bun is the safe bet for 2026.

## Claude Code's TUI patterns worth stealing

Claude Code's TUI is the most sophisticated of the four, so even if SkillSmith doesn't adopt Ink, several structural patterns transfer directly. The custom renderer inside `src/ink/` is a 60-file hardened fork of Ink that vendorizes a pure-TypeScript port of Yoga (no native bindings), driven by `react-reconciler` 0.33 and React 19.2. Rendering uses a packed `Int32Array` screen buffer, intern pools for chars/styles/hyperlinks, damage-aware diffing (only changed regions repaint), and a blit optimization that copies cells from the prior frame when subtrees are clean. Commits are deferred to a microtask after React commits so layout effects run first, eliminating one-frame cursor lag. None of this is worth replicating in SkillSmith — but the underlying *architectural* choices are.

**Input is classified into React 19 scheduler priorities.** Keydown, focus, and paste are "discrete" and preempt in-flight rendering; resize, scroll, and mousemove are "continuous" and batched. That is why typing in Claude Code feels instantaneous during heavy streaming. For SkillSmith this maps to a simpler principle: **never block the prompt render on network or filesystem work** — wrap registry clones and skill writes in a spinner (Clack's `spinner()` handles this) rather than inline-awaiting them inside a prompt callback.

**State lives in React hooks + Context only** — no Zustand, Jotai, Redux, XState, or anything external. The single source of truth is the `Message[]` append-only immutable log. Permission decisions, tool results, file changes, and compaction markers are all messages. Resuming a session is just replaying the array; forking a subagent clones it. **Adopt this pattern for SkillSmith:** model an `Operation[]` log (install / adapt / skip / override) that the `apply` command produces and the TUI renders in a review step. Append-only logs make dry-run trivial (run the whole pipeline, print the log, don't flush) and make cross-scope reconciliation diff-friendly.

**Input modes dispatch on the first character of the buffer** — `/` for slash commands, `!` for bash passthrough, `#` for memory, `@` for file references — with Fuse.js-powered fuzzy autocomplete bound to Tab. SkillSmith probably doesn't need mode dispatch, but the *slash-command registry pattern* is worth borrowing for the `apply` command: allow users to express overrides inline (e.g., `skillsmith apply @my-skill --scope=user`) and resolve them through a single dispatch table.

**Streaming uses an `AsyncGenerator` as the event loop.** The agent yields tool-invocation events; the renderer consumes them and updates React state slices. A `StreamingToolExecutor` begins executing tools *as they stream in*, classifying each as concurrent-safe (read-only) or exclusive (writes) — reads parallelize, writes serialize. For SkillSmith, apply this to the `apply` command: classify each skill installation as concurrent-safe (different tool + different scope = parallel), and serialize only writes that touch the same target directory.

**Graceful lifecycle is treated as a first-class concern.** `signal-exit` registers teardown; terminal modes are restored synchronously on unmount; Yoga refs are cleared before free; pool growth is bounded by periodic resets. This matters for 30-minute REPL sessions — less so for a short CLI — but the one piece SkillSmith should copy is **file-locking with `proper-lockfile`** (Claude Code uses this for cross-agent coordination via POSIX flock). When multiple `skillsmith` invocations race to write `~/.claude/skills/` or the TOML manifest, a lockfile prevents interleaved writes.

The patterns **not** to copy: the vendored Ink/Yoga stack (massive engineering investment; Claude Code has ~512K LOC mostly to support this), the 5-layer context compaction, and the custom reconciler. SkillSmith is a short-lived, mostly non-interactive tool.

## SkillSmith V1 recommendations, layer by layer

### CLI framework: citty (primary) or commander (fallback)

**Pick `citty`** from UnJS. It is TypeScript-first, has lazy-loaded subcommands, pairs idiomatically with consola for logging, and is actively maintained (v0.2.2 in late 2025). It is what you would reach for in a Bun-first 2026 tool. Claude Code uses `@commander-js/extra-typings` v14 — it works perfectly well, and if you prefer the more battle-tested ecosystem (~365M weekly downloads), use commander instead. Neither is replaced by a Bun built-in; Bun.argv alone is not enough for subcommand routing like `install | list | apply | sync`. Skip cac (stale), clipanion (niche Yarn DX), and oclif (too heavy — optimized for Salesforce-scale plugin CLIs).

### Interactive prompts + TUI: @clack/prompts (single layer)

**`@clack/prompts` covers both layers.** It has `intro`/`outro`, `select`/`multiselect`/`confirm`/`text`, a built-in `spinner()`, and crucially a `group()` helper that composes multi-step wizards with shared context and cancel-handling — exactly SkillSmith's tool-selection → scope-selection → confirmation flow. Weekly downloads ~8.3M, v1.2.0 shipped in April 2026. **Do not add Ink.** Ink on Bun still has open regressions as of early 2026: segfaults under certain child-process patterns (oven-sh/bun#16805), `readline.close()` breaking `useInput` (#21189), and a 100%-CPU busy-spin when Ink + fetch run together on macOS ARM64 (#27766, Bun 1.3.10). Claude Code uses Ink but runs under a carefully pinned Bun build and has vendored the Ink source. A V1 CLI should not take on that operational burden. Keep Ink in your back pocket as a fallback if a future SkillSmith feature — e.g., a live cross-scope diff viewer — genuinely needs arbitrary box layout.

**One Bun-on-Bun caveat to flag:** Bun 1.3.2 broke Clack stdin with `EPERM: operation not permitted` on fd 0 (oven-sh/bun#24615, filed Nov 2025). Pin your minimum Bun version in `package.json` (`"packageManager": "bun@1.3.13"` or later) and include a smoke test that runs `skillsmith install` with piped stdin in CI.

### TOML parsing and writing: Bun built-in (read) + smol-toml (write)

This is the layer where no reference tool guides you (only Codex uses TOML, and it uses Rust's `toml` crate). **For reading the `skillsmith.toml` manifest, use Bun's built-in `import manifest from "./skillsmith.toml"` when the path is known at build time, and `Bun.TOML.parse(await Bun.file(path).text())` when it is resolved at runtime** (user-provided paths, cross-project sync). **For writing, use `smol-toml`'s `stringify()`** — Bun has no serialization API. smol-toml is faster than @iarna/toml, tracks TOML 1.1.0, and is actively maintained in 2025. Fallback: @iarna/toml if smol-toml ever breaks.

**Critical gap to design around: no JavaScript TOML library preserves comments on round-trip.** smol-toml, @iarna/toml, and @ltd/j-toml all drop comments and formatting when you parse-and-restringify. Python has tomlkit, Rust has toml_edit; the JS ecosystem has nothing equivalent (as of April 2026 — confirmed against toml-lang/toml#284 and #836). For SkillSmith's `apply` command, this means you have three options: (1) surgically edit the manifest with a regex-scoped key replacement when pinning a new skill, preserving user comments; (2) accept comment loss on write and document it in the README (what Cargo and Poetry largely do); (3) shell out to a sidecar Rust binary using `toml_edit` if fidelity is critical. For V1, **option 2 is correct** — document the limitation and re-emit a canonical, well-commented header whenever SkillSmith rewrites the file.

### Schema validation: zod v4

**Zod v4 is unanimous among the TS reference tools** (Claude Code: 125+ imports; OpenCode: defines all HTTP contracts with Zod + `@hono/zod-validator`; Kilo: same). Zod v4's JIT compilation makes it roughly 8× faster than v3, it supports Standard Schema, and it has the largest ecosystem of any TS validator. Define the `skillsmith.toml` shape, each tool's scope enum (`"system" | "user" | "project"`), and registry entries as Zod schemas; derive JSON Schema from them via `z.toJSONSchema()` for IDE autocomplete on the manifest. Valibot is 90% smaller if binary size matters, but you will already be shipping a ~55 MB Bun binary — the delta is noise.

### File system, glob, and shell: Bun built-ins

Skip `fs-extra`, `fast-glob`, `globby`, `execa`, `cross-spawn`, and `shelljs` entirely. **Bun.file, Bun.write, Bun.Glob, Bun.$, and Bun.spawn cover every operation SkillSmith needs**, with better performance and zero dependency weight. For cross-scope skill enumeration (find all `*.md` under `~/.claude/skills/`, `~/.codex/skills/`, `.kilocode/skills/`, `.opencode/skills/`, plus the matching project-level paths), `Bun.Glob` with an array of patterns is sufficient. Claude Code's heavier stack (execa, chokidar, picomatch) exists because it needs long-lived file watchers and complex child-process trees; SkillSmith does not. **One exception:** adopt `proper-lockfile` for write coordination — if two `skillsmith apply` invocations race on the same manifest or same scope directory, you want POSIX flock semantics, and this is the library Claude Code trusts for exactly that purpose.

### Git operations: Bun.$ shelling to git

For Git URL-based registries (clone, pull, fetch a tag), use `Bun.$` with the system `git` binary. macOS always has `git`; Linux distros ship it in base images. `Bun.$` gives you shell-injection-safe template literals and streamed output. Fallback to `simple-git` (~9M weekly downloads, active) only if you find yourself wiring many git operations with complex option handling. Do **not** use `isomorphic-git` unless you want SkillSmith to work *without* a system git — that is a V2 concern, not V1, and it would add several megabytes to the compiled binary.

### Terminal styling: picocolors

**Picocolors** (1.6k stars, 90M weekly downloads, 7 kB, zero deps) is the 2026 default. Claude Code uses `chalk` 5 with 47+ imports because its terminal rendering is deeply ANSI-aware (hyperlinks via OSC 8, CJK width, emoji, RTL via `bidi-js`). SkillSmith does not need any of that. If you find picocolors' API insufficient — e.g., you want template-literal styling — swap to chalk; it is still actively maintained. Skip kleur (stale since 2022) and colorette.

### Spinners and logging: @clack built-in + consola

Clack's built-in `spinner()` handles long-running operations (git clone, skill copy, manifest write) with the same visual language as the prompts. No need for ora, yocto-spinner, or nanospinner. For structured logging outside the interactive flow (`skillsmith list`, `--verbose` output, error traces), **consola** pairs with citty naturally and offers tagged loggers that format nicely. Reject signale (dead since 2019). pino is overkill for a CLI.

### Testing: bun:test

**Use Bun's built-in test runner.** It is Jest-compatible, significantly faster than vitest on Bun, and every TS reference tool here uses it (Claude Code, OpenCode, Kilo Code all ship with `bun test`). Snapshot the TUI interactions by capturing prompt outputs, and add a Playwright-style harness only if you later need to test TUI mouse or arbitrary keystrokes. Codex's use of `insta` snapshot tests for Ratatui UI changes is the right mental model — for SkillSmith, that maps to snapshotting the JSON representation of each `Operation[]` log produced by a dry-run `apply`.

### Build and distribution: bun build --compile

`bun build --compile --target=bun-darwin-arm64 --bytecode src/index.ts --outfile skillsmith` is your entire build. Ad-hoc code signing has been default since Bun 1.2.4 (Feb 2025). For Gatekeeper-acceptable distribution on macOS, re-sign with your Developer ID certificate and run `notarytool submit`. The resulting binary is 50–60 MB (Bun runtime embedded). Cross-compilation works from macOS to Linux and Windows with the same `--target` flag. Embed assets (default skill templates, schema files, help text) via `import x from "./file.txt" with { type: "file" }` — they become part of the binary and are readable at runtime through `Bun.embeddedFiles`. **One version trap:** Bun 1.3.12 produces truncated codesign signatures on `bun-darwin-arm64` (oven-sh/bun#29120); pin ≥1.3.13 or set `BUN_NO_CODESIGN_MACHO_BINARY=1` and sign manually.

### State management inside SkillSmith

Adopt Claude Code's pattern explicitly: **an append-only `Operation[]` log as the single source of truth**, with a thin discriminated-union type like `{ kind: "install" | "adapt" | "skip" | "override" | "pin"; tool: Tool; scope: Scope; skill: SkillId; note?: string }`. The `apply` pipeline produces this log deterministically from the manifest + filesystem state; the TUI renders the log as a review step; `--dry-run` prints the log without executing; the actual execution flushes each entry through a concurrency-safe classifier (reads parallel, writes serial). This is Claude Code's pattern stripped to its essentials, and it costs ten lines of code to set up while giving you testability, dry-run, and audit logging for free.

## Gaps, risks, and open questions

**TOML comment preservation is unsolved in JS.** This is the single largest risk for SkillSmith's manifest editing story. Accept comment loss in V1 and revisit in V2 via a Rust sidecar if users complain. **Ink compatibility on Bun remains flaky**, so if future SkillSmith features need arbitrary terminal layout, evaluate OpenTUI (used in production by OpenCode and Kilo on Bun, Zig core, SolidJS reconciler) before reaching for Ink. **Claude Code's exact dependency versions are approximations** — they come from a reverse-engineered `package.json` in the leaked source (claude-code-best/claude-code) and star-history.com's enumeration; major libraries are confirmed but minor version pins are directional. **None of the reference tools uses a dedicated logger** (Claude Code uses OpenTelemetry for analytics and JSONL transcripts for conversation logs, not a logger library) — if SkillSmith needs structured logs for debugging across scopes, consola is the right unprecedented-for-this-space pick. **The Bun 1.3.2 stdin regression on Clack** is the single most likely deployment snag — pin Bun ≥1.3.13 and smoke-test piped stdin in CI.

## The stack, in one block

```
Runtime + bundle:   Bun ≥1.3.13  →  bun build --compile --bytecode
CLI framework:      citty                            (fallback: commander)
Prompts + wizard:   @clack/prompts (group/spinner)   (fallback: @inquirer/prompts)
Schemas:            zod v4
Config read:        Bun built-in TOML import + Bun.TOML.parse
Config write:       smol-toml stringify              (accept comment loss)
Filesystem:         Bun.file / Bun.write / Bun.Glob
Shell + git:        Bun.$  (shells to system git)
HTTP:               native fetch
Locking:            proper-lockfile                  (Claude Code's pick)
Styling:            picocolors
Logging:            consola
Testing:            bun:test
State pattern:      append-only Operation[] log      (borrowed from Claude Code)
```

This collapses to **roughly nine production dependencies** plus Bun — compared to Claude Code's ~65. That is the right shape for a V1 open-source CLI: lean enough to audit in an afternoon, modern enough to still look current in 2027, and aligned with what the Bun-first half of the AI-CLI ecosystem has converged on.