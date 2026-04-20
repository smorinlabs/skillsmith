# SkillSmith V1 Stack — Summary

> Condensed reference. See the full analysis docs for rationale and reference-tool comparisons.

## Runtime & build

- **Bun** ≥ 1.3.13 (pin in `package.json` "engines")
- **Build:** `bun build --compile --bytecode --target=bun-darwin-arm64 src/index.ts --outfile dist/skillsmith`
- **Distribution (V1):** Homebrew cask (primary for Mac POC), plus npm package with per-platform optional deps so `bunx`/`npx skillsmith` works without Bun installed

## Final dependency list (9 runtime)

```
commander            # CLI framework
@clack/prompts       # interactive prompts + spinner + group wizard
chalk                # terminal styling (16/256/truecolor, hex)
consola              # structured logging outside interactive flow
zod                  # schema validation (v4)
smol-toml            # TOML write (read via Bun's built-in import)
gray-matter          # SKILL.md YAML front-matter
proper-lockfile      # cross-process write coordination
env-paths            # platform-correct user config dirs (fallback only)
```

Dev-only: `@types/bun`, `@types/node`.

Everything else — file I/O, globs, shelling to git, subprocess spawn, HTTP, test runner — comes from **Bun built-ins** (`Bun.file`, `Bun.write`, `Bun.Glob`, `Bun.$`, `Bun.spawn`, native `fetch`, `bun test`).

## Swaps from the prior nine-package stack

| Layer | Was | Now | Why |
|---|---|---|---|
| CLI framework | citty | **commander** | 365M weekly downloads, what Claude Code uses, battle-tested plugin ecosystem |
| Styling | picocolors | **chalk** | Need hex/truecolor for branded output (install/skip/override badges, diffs). Picocolors is 16-color only. |

## Key patterns to reuse from Claude Code

These are architectural patterns lifted from the leaked source, adapted for SkillSmith's much smaller surface area.

### 1. Append-only `Operation[]` log as single source of truth

Claude Code's entire session is an immutable `Message[]` log — tool results, permissions, errors, and user turns are all appended entries. Resuming = replay, forking a subagent = clone.

**For SkillSmith:** the `install` / `apply` / `sync` pipeline produces an `Operation[]` log deterministically from manifest + filesystem state. The TUI renders the log as a review step; `--dry-run` prints it without flushing; execution flushes entries in order.

```ts
type Operation =
  | { kind: "install"; tool: Tool; scope: Scope; skill: SkillId; source: string }
  | { kind: "skip"; reason: "already-installed" | "broader-scope-exists"; at: Scope; skill: SkillId }
  | { kind: "adapt"; from: Tool; to: Tool; skill: SkillId; rules: string[] }
  | { kind: "override"; scope: Scope; skill: SkillId; force: boolean }
  | { kind: "pin"; skill: SkillId; ref: string };
```

Benefits: `list`, `apply --dry-run`, audit logs, and cross-scope reconciliation all fall out of this one structure. Tests snapshot the JSON.

### 2. Cross-process file locking via `proper-lockfile`

Claude Code uses POSIX flock through `proper-lockfile` for cross-agent coordination. SkillSmith will face the same race when two `apply` invocations or a user and a CI job both write to `~/.claude/skills/` or rewrite `skillsmith.toml`.

**Apply to:** manifest writes, per-scope skill directory writes, registry cache updates.

### 3. Streaming executor with concurrent-safe classification

Claude Code classifies tool calls as *concurrent-safe* (read-only) or *exclusive* (writes); reads parallelize, writes serialize.

**For SkillSmith:** the `apply` executor does the same with the `Operation[]` log. Two installs to different `(tool, scope)` tuples run in parallel; two writes to the same target directory are serialized. Zero-config speedup for multi-skill manifests.

### 4. Graceful lifecycle with `signal-exit`

Claude Code registers teardown through `signal-exit` to restore terminal modes on SIGINT and release locks synchronously. SkillSmith should register release-lockfile + restore-tty handlers via the same lib — critical for the install-interrupted case where a lockfile would otherwise leak.

### 5. Mode-dispatch registry for subcommand flags

Claude Code dispatches input on the first character (`/`, `!`, `#`, `@`) through a registry table with Fuse.js autocomplete. SkillSmith won't need four modes, but the *pattern* — one dispatch table for subcommands + inline override tokens — keeps the parser honest when features accrue.

### 6. State-via-hooks, no external store

Claude Code uses React hooks + Context only — no Zustand, no Jotai, no XState. The `Message[]` log is the state; UI components are pure functions of it.

**For SkillSmith:** even if V2 adds an Ink screen, keep state as the `Operation[]` log + derived selectors. Don't reach for Zustand or similar.

## State management in practice

The rule of thumb lifted from the above:

1. **One immutable log.** Everything interesting appends to `Operation[]`.
2. **Pure functions over the log.** `pendingWrites(log)`, `conflictsAt(log, scope)`, `summarize(log)` — all derived, never stored.
3. **Flush is a separate phase.** Build the log from intent + filesystem probe, review it (interactive) or print it (`--dry-run`), then execute it under a lockfile.
4. **Snapshot tests = JSON snapshots of the log** for each representative scenario (fresh install, cross-scope duplicate, forced override, adapt-on-install, sync diff).

This is ~40 lines of TypeScript total and gives you dry-run, audit, diff-view, and testability for free.

## Known Bun caveats to document in README

- **Bun ≥ 1.3.13 required.** Bun 1.3.2 broke `@clack/prompts` stdin with EPERM on fd 0 (oven-sh/bun#24615).
- **Bun 1.3.12 has a codesign truncation bug** on `bun-darwin-arm64` (#29120). Use 1.3.13+.
- **`bun build --compile --target=bun` inlines `process.env`** at build time (#11191). Run CI in a clean environment or use `--define` explicitly to avoid baking secrets into binaries.
- **`Bun.TOML.parse` reads only** — no serializer. Use smol-toml for writes; accept comment loss on rewrite.

## Commands cheat sheet

```bash
# Dev
bun install
bun test
bun run src/index.ts install acme/agent-tools/code-review

# Build for macOS (POC target)
bun build --compile --bytecode \
  --target=bun-darwin-arm64 \
  src/index.ts \
  --outfile dist/skillsmith

# Codesign + notarize (Gatekeeper-friendly Homebrew cask)
codesign --sign "Developer ID Application: …" --options runtime dist/skillsmith
xcrun notarytool submit dist/skillsmith.zip --apple-id … --wait
```

## What this stack deliberately does NOT include

- **No Ink / React** — SkillSmith's UI is a linear wizard, not a persistent REPL. Clack's `group()` covers it. Revisit if V2 needs arbitrary box layout.
- **No fs-extra / globby / execa / cross-spawn** — Bun built-ins replace all four.
- **No axios / undici / ky** — native `fetch` is enough for registry clients.
- **No ora / yocto-spinner** — Clack's built-in `spinner()` matches its prompt aesthetic.
- **No Zustand / Jotai / XState** — the `Operation[]` log is the state.

## Install

```bash
bun add commander @clack/prompts chalk consola zod \
        smol-toml gray-matter proper-lockfile env-paths
bun add -d @types/bun @types/node
```

That's the whole V1 surface. Nine runtime deps, Bun-native everything else, one binary at the end.
