# SkillSmith V1 stack: a lean Bun-native install-only CLI

**For V1, pick citty + @clack/prompts + valibot + gray-matter + smol-toml + consola, and lean hard on Bun's built-ins (`Bun.file`, `Bun.write`, `Bun.which`, `Bun.$`, `Bun.Glob`, `bun test`, `bun build --compile`) for everything else.** This is a roughly ten-package runtime tree that boots in under ~60ms as a compiled binary, ships as a single macOS native executable via Homebrew, and mirrors the parts of Claude Code's stack that actually matter for a skill installer while dropping the React/Ink weight you don't need.

The reasoning rests on three facts the research uncovered. First, **all three reference tools converged on the Anthropic Agent Skills spec** (`SKILL.md` + YAML frontmatter + optional `scripts/references/assets/`) — Claude Code authored it, Codex adopted it in December 2025, and Kilo's new CLI auto-scans the format across a dozen cross-agent directories. That means SkillSmith's job is mostly *where* to place a portable file, not *what* to transform. Second, **Claude Code is itself a Bun-compiled TypeScript CLI distributed via Homebrew + npm-with-per-platform-optional-deps**, and Anthropic's December 2025 Bun acquisition confirms this is the strategic direction — it's the most directly relevant reference implementation you have. Third, **Codex's move from TypeScript+Ink to Rust+Ratatui tells you Ink is overkill** for what SkillSmith does; Codex needed it for a persistent agent loop, not for a file installer, and even *they* migrated off.

## What the three reference CLIs actually use

The three tools look similar at the pitch level but differ sharply under the hood. Claude Code is a **Bun + TypeScript** binary with a vendored Ink reimplementation, Commander for argument parsing, Zod v4 for schema validation, chalk/figures/cli-boxes for visuals, execa for subprocess work, picomatch + ignore + env-paths for filesystem conventions, and `@modelcontextprotocol/sdk` for MCP. Configuration lives in a five-layer precedence stack (managed policy → CLI args → `.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`), with skills in `~/.claude/skills/<name>/SKILL.md` (user) or `.claude/skills/<name>/SKILL.md` (project).

Codex CLI is now **~95% Rust** (Ratatui + Crossterm + clap + tokio, with forked crossterm/ratatui) behind a thin npm shim. Its TypeScript predecessor used `meow` + `ink` + `react` + the OpenAI SDK + Zod. Config is TOML at `~/.codex/config.toml`, merged with project-level `.codex/config.toml` (trusted projects only), with `AGENTS.md` files walked root-down and concatenated. Skills go in `$CODEX_HOME/skills/` globally, `.agents/skills/` per-repo, and Codex auto-migrates `.claude/` skills into `.codex/skills`. A new **Plugins** system (`.codex-plugin/plugin.json` manifests) bundles skills + MCP + app connectors together.

Kilo Code is the messiest of the three and the most informative. It's a **Bun workspaces monorepo** using TypeScript + Solid.js (new) / React (legacy) + Effect + esbuild + turbo, shipping simultaneously as a VS Code extension, a Tauri desktop app, a web app, and a CLI (`@kilocode/cli`, a fork of OpenCode). **Two generations of storage coexist**: the legacy Roo-fork extension reads `~/.kilocode/skills/<name>/SKILL.md` and `<ws>/.kilocode/skills/`, plus mode-tagged variants like `.kilocode/rules-code/`; the new OpenCode-based CLI reads `~/.kilo/skills/`, `.kilo/skills/`, and a long cross-agent compatibility list (`.claude/skills/`, `.agents/skills/`, `.roo/skills/`, `.opencode/skills/`, `.cursor/skills/`, `.windsurf/skills/`, and more). It also has storage inside VS Code's `globalStorage`, which varies per VS Code fork (VS Code, Insiders, Cursor, Windsurf, VSCodium). **For SkillSmith this is the single most important design signal: if you write `SKILL.md` files to the right filesystem locations, Kilo will discover them regardless of which generation the user runs.**

## The V1 stack, chosen by category

### Argument parsing: citty over Commander

**citty** (unjs) is the right pick for a tool whose CLI shape is `skillsmith install <skill> --tool claude|codex|kilo --scope user|project|system`. It gives you declarative `defineCommand` + `subCommands` with typed positionals, lazy subcommand imports (every ms of cold start counts in a compiled binary), auto `--help`/`--version`, and clean SIGINT handling via `runMain()`. Commander is the conservative alternative — it's what Claude Code uses — but citty's lazy-subcommand pattern and unjs family cohesion (pairs naturally with consola and ofetch below) win on a greenfield Bun project. **Avoid clipanion** (too heavy for <10 commands) and **avoid raw `node:util`'s `parseArgs`** (no subcommand routing, no auto-help; you'd reinvent both).

### Interactive prompts: @clack/prompts, not Ink

`@clack/prompts` is the clear winner for V1. It's ~4 KB gzipped, provides `text`/`select` (with `hint` descriptions)/`multiselect`/`confirm`/`group`/`spinner`/`progress`/`tasks` in one import, and has the best default visuals in the ecosystem — the same aesthetic you see in `create-vite` and `create-astro`. It handles the exact flows SkillSmith needs: detect installed tools, show them alongside "also-available" suggestions as a grouped multiselect, then prompt for scope. **Do not pull in Ink for V1.** Ink makes sense for persistent dashboards with live data and keyboard navigation; a sequential install wizard doesn't need React reconciliation or yoga flexbox. Codex's TS→Rust rewrite, which dropped Ink, confirms the direction. **One Bun-specific caveat:** `@clack/prompts` hits an EPERM on stdin under Bun 1.3.2 specifically (fixed in 1.3.3); require `bun >= 1.3.3` in your README.

### Terminal styling: picocolors plus `Bun.color` for accents

**picocolors** is the smallest and fastest lib for the 90% case (simple `red`/`bold`/`dim` wraps), zero deps, always cache-warm because every build tool depends on it. Drop to **`Bun.color("#ff5c5c", "ansi")`** for one-off branded hex values. Claude Code uses chalk (47+ imports in the leaked v2.1.88 source), but chalk v5's ESM + chained API isn't worth the 44KB on a startup-sensitive CLI. Skip kleur (stale) and yoctocolors (fine, but picocolors' ecosystem inertia is decisive).

### Spinners: `@clack/prompts`'s `spinner` and `tasks`

Since you're already in Clack, use its built-in `spinner()` and `tasks()` helpers — they share borders/guide lines with the prompts for a consistent UI. If you ever drop Clack, switch to **yocto-spinner** (Sindre's lighter replacement for ora) rather than ora itself; Astro made exactly this move in 2024.

### Filesystem: `Bun.file` + `Bun.write` hot path, `node:fs/promises` for directory ops

For reading and writing `SKILL.md` files, use `Bun.file(path).text()` and `Bun.write(path, data)` — they're Bun-native and ~2× faster than `node:fs/promises` on identical workloads. For `mkdir -p`, `readdir`, `rm -rf`, `stat`, `chmod` (all of which you'll hit while creating `~/.claude/skills/<name>/` trees), use `node:fs/promises` directly — Bun has no special wrappers for these and the Node API is plenty fast on Bun. For globs, start with **`Bun.Glob`** (zero deps, async-iterator `.scan()`); reach for **tinyglobby** only if you need multi-pattern or ignore-list logic. Avoid fast-glob and globby — the e18e ecosystem has moved on.

### Tool detection: `Bun.which` + `Bun.$`, plus a hand-rolled variant table

For the `claude` / `codex` / `kilo` binaries on PATH, **`Bun.which("claude")`** returns an absolute path or null with no subprocess spawn. When you also need the version string, use **`Bun.$`**: `await $\`claude --version\`.nothrow().quiet()`. For detecting Kilo Code (which runs as a VS Code extension), parse `~/.vscode/extensions/extensions.json` via `Bun.file(path).json()` and look for `identifier.id === "kilocode.kilo-code"`. Iterate a variant table covering VS Code, Insiders, Cursor, Windsurf, and VSCodium — each has its own extensions dir (`~/.vscode/`, `~/.vscode-insiders/`, `~/.cursor/`, `~/.windsurf/`, `~/.vscode-oss/`) and its own `globalStorage` under `~/Library/Application Support/<AppName>/User/globalStorage/`. Shelling out to `code --list-extensions` is slower and doesn't cover forks.

### Schema validation: valibot over zod

This is a mild contrarian pick. Claude Code ships Zod v4 (125+ imports) and you could do the same without risk. But SkillSmith is a startup-sensitive CLI that validates one `SKILL.md` frontmatter per invocation, not millions of API payloads — so **bundle size and cold-start init matter more than peak validation throughput**. **Valibot** is ~1.4 KB versus Zod's ~15–18 KB, has no JIT warm-up penalty, and is Standard Schema-compliant so you can port to Zod later if ergonomics bite. Use it for frontmatter, CLI flags, and `config.toml` shape. Fall back to Zod v4 only if you want to reuse existing schemas from the Claude/Anthropic ecosystem (e.g., MCP schemas).

### Content parsing: gray-matter for SKILL.md, smol-toml for Codex config

**gray-matter** is the right call for SKILL.md frontmatter parsing — it's what Astro, VitePress, Next, and Gatsby use, handles CRLF and YAML-inside-Markdown edge cases correctly, and composes with `Bun.file(path).text()` → `matter(text)` cleanly. Its only transitive dep is `js-yaml`. For rewriting `~/.codex/config.toml`, use **smol-toml** — fastest parser in the 2025 benchmarks (~2.1× @iarna/toml), TOML 1.1.0-compliant, actively maintained by squirrelchat, and critically it has a `stringify()` so you can round-trip changes. Also add **jsonc-parser** (Microsoft's) for reading Kilo's `kilo.jsonc` without losing comments.

### Logging: consola (with JSON reporter for --json)

**consola** is purpose-built for CLIs: TTY-auto detection, level methods (`info/success/warn/error/debug/trace/box/start`), `withTag()` scoped loggers, and a `JSONReporter` you can swap in when `--json` is passed. It's part of the same unjs family as citty and ofetch, so your idioms stay consistent. Pino is the wrong shape (server throughput, not user-facing). Picocolors + a 20-line level wrapper is fine if you want zero runtime dependencies, but you lose the JSON-mode swap.

### HTTP for remote skills: ofetch

For fetching skills from GitHub raw, tarballs, or custom marketplaces, **ofetch** wraps native fetch with auto-retry on transient 5xx, timeouts, typed responses, `baseURL`, and lifecycle hooks. Bun support is explicitly documented. Native `fetch` alone works but you'll reinvent retries and error-shape normalization. ky is the 4 KB alternative if binary size is paramount.

### Testing and distribution: bun test + `bun build --compile`, Claude-Code-style triple-channel

Use **`bun test`** — Jest-compatible API, ~10× faster than Vitest on a 50-test suite, and critically it runs tests under the *exact* runtime the CLI ships with (Vitest under Node would mask Bun-specific bugs). Prefer real `fs.mkdtempSync(os.tmpdir())` fixtures over module mocks for filesystem tests. Distribute exactly like Claude Code: **`bun build --compile --minify --bytecode`** to produce per-platform binaries (~55–95 MB, ~20–60 ms cold start on Apple Silicon), shipped through a **Homebrew cask (primary macOS)**, a `curl … | bash` install script (Linux/Windows fallback), and an **npm package with per-platform optional dependencies + a postinstall linker** (covers `bunx skillsmith` and `npx skillsmith` without a Bun install on the user's box). Cross-compile the whole matrix from one macOS CI runner; codesign and notarize for Gatekeeper; pin the `darwin-arm64` and `darwin-x64` artifacts in the cask with a proper `arch` stanza to avoid the bug that recently hit Claude Code's cask.

## The scope/location matrix SkillSmith must implement

This is the operational core — the table below is what actually differentiates SkillSmith from "just copy a folder." These are the destinations your installer must write to, grouped by tool and scope:

| Tool | User scope | Project scope | Format |
|---|---|---|---|
| **Claude Code** | `~/.claude/skills/<name>/SKILL.md` | `.claude/skills/<name>/SKILL.md` | SKILL.md (Anthropic spec); folder name **must equal** frontmatter `name` |
| **Codex CLI** | `$CODEX_HOME/skills/<name>/SKILL.md` (defaults to `~/.codex/skills/`) | `.agents/skills/<name>/SKILL.md` (walked to repo root) or `.codex/skills/` | Same SKILL.md; optional `agents/openai.yaml` for UI metadata |
| **Kilo (new)** | `~/.kilo/skills/<name>/SKILL.md` | `.kilo/skills/<name>/SKILL.md` | Same SKILL.md |
| **Kilo (legacy)** | `~/.kilocode/skills/<name>/SKILL.md` | `.kilocode/skills/<name>/SKILL.md` | Same SKILL.md |

For **maximum cross-tool portability with zero adaptation**, SkillSmith's `--tool all` (or detection-based install) should write to **`.agents/skills/<name>/`** at the project root when scope=project and to **`~/.agents/skills/<name>/`** when scope=user — both Kilo's new CLI and Codex auto-discover this location, and Claude Code loads `.claude/skills/` from any `--add-dir`-added directory. A clean fallback when portability is required is to install to each tool's native directory and symlink the others, but symlinks are fragile across Windows WSL boundaries; prefer file duplication with a small `.skillsmith.json` manifest tracking what you wrote so `skillsmith uninstall` is clean.

**System scope is real only for Claude Code**: `/Library/Preferences/com.anthropic.claudecode` plist on macOS (MDM territory) and `managed-settings.json`. Codex and Kilo have no equivalent. Treat `--scope system` as a Claude-only flag in V1 and error helpfully otherwise.

## Known Bun-specific caveats worth flagging in the README

Four gotchas emerged from the research that will bite V1 if ignored. First, **`@clack/prompts` breaks on stdin under Bun 1.3.2** (oven-sh/bun#24615, EPERM); pin `bun >= 1.3.3` as a hard requirement. Second, **`bun build --compile --target=bun` inlines `process.env`** at build time (#11191) — run CI builds in a clean environment or use `--define` explicitly, or you'll bake developer secrets into shipped binaries. Third, **`--bytecode` flag occasionally fails on complex bundles** according to Claude Code's build notes; benchmark with and without before enabling for release. Fourth, **if you also publish to npm for `bunx`/`npx` users, wrap `Bun.*` APIs behind `typeof Bun !== "undefined"` fallbacks** to `node:fs/promises`, `tinyexec`, `which`, and `tinyglobby` — otherwise non-Bun users get runtime errors. The cleaner alternative, which Claude Code uses, is to ship only compiled binaries through the npm package's per-platform optional deps so the JS shim never runs user code under Node.

## Closing take: SkillSmith should be deliberately boring

The temptation when tooling agent tools is to match their sophistication — Ink UIs, MCP servers, plugin systems. Resist it for V1. Claude Code needs Ink because it's a persistent agent loop; Codex needed Ratatui for the same reason and still migrated to Rust for sandboxing and GC predictability; Kilo needs Effect + Solid.js because it's simultaneously four products. **SkillSmith is a file copier with taste.** The highest-leverage architectural decision is writing skills into the cross-agent-compatible directories (`.agents/skills/` at project scope, target-specific dirs when requested) so that Kilo and Codex's auto-discovery machinery does your portability work for free. The second-highest is keeping the dependency count low enough that the compiled binary boots in under 100ms — that's what makes an installer feel like a native tool rather than a Node script. The ten-package stack above gets you both, and leaves every door open (swap valibot for Zod, add Ink for a future dashboard, add MCP if skill discovery goes remote) without rework.

```bash
bun add citty @clack/prompts picocolors consola valibot \
        gray-matter smol-toml jsonc-parser ofetch env-paths
# dev-only
bun add -d @types/bun
```

That's the whole V1 surface. Ship it, watch which skill-install flows users actually want, and let the telemetry (if you add any — consider OpenTelemetry lazy-load the way Claude Code does) drive V2 additions.