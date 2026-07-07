# Skillsmith Projects

**Status Legend:**
- `[x]` Completed
- `[-]` In Progress
- `[ ]` Not Started
- `[~]` Won't fix / Invalid / False positive

---

> **Revival sequence (2026-07-06):** P10 → P11 → P12 → P09 → P14.
> Execution: superpowers subagent-driven development — feature branch + squash-merge PR per
> project (per CLAUDE.md release flow), fresh implementer subagent per task, task review after
> each, final whole-branch review per project. Model policy: **haiku** = transcription/mechanical
> (complete spec in brief), **sonnet** = standard implementation + routine task reviews,
> **opus** = anything tricky (deep-checker subprocess/stream parsing, store/lockfile,
> atomic-swap correctness) + standard specs, **fable** = major planning (ALL [P*-PL]
> implementation plans + hardest [P*-BR] specs) and all final whole-branch reviews /
> highest-risk verification.
> Ledger: `.superpowers/sdd/progress.md`.

## [x] Project P10: Un-park — consolidate + hygiene (v0.3.2)
**Goal**: Bring the repo back to a healthy, single-home baseline. Finish the in-progress
release-please wiring (P06 `[-]`): diagnose why the release branch exists with no Release PR,
reconcile CHANGELOG (missing 0.2.0/0.3.0/0.3.1 sections; salvage from the stale
`release-please--branches--main--components--skillsmith` branch, then delete it on both
remotes). Deduplicate the twin repos — canonical = `smorinlabs/skillsmith` (private until P14),
archive `smorin/skillsmith` with a deprecation note; repoint local origin. Refresh toolchain
(Bun pin, dep bumps) and prove CI green via a real PR.

**Out of Scope**: any feature work; going public (→ P14).

### Tests & Tasks
- [x] [P10-T01] Diagnose release-please: why branch-but-no-PR; fix wiring (workflow perms/config) — *orchestrator + sonnet*
- [x] [P10-T02] Reconcile CHANGELOG (0.2.0/0.3.0/0.3.1) via the documented manual path; delete stale branch both remotes — *sonnet*
- [x] [P10-T03] Dedup repos: canonical smorinlabs, archive smorin w/ notice, repoint local origin, update repo URLs in docs — *orchestrator*
- [x] [P10-T04] Toolchain refresh: Bun + deps bump; `bun run check` green — *sonnet*
- [x] [P10-T05] Commit the load-verification research doc; scrub-check `research/` (no machine paths/PII) — *haiku*
- [x] [P10-TS01] CI green on a PR; squash-merge lands; release-please behaves correctly (Release PR opens or correctly abstains)

### Automated Verification
- `bun run check` green; `gh api repos/smorinlabs/skillsmith` canonical; `smorin/skillsmith` confirmed as transfer redirect to canonical; CHANGELOG sections 0.1.0→0.3.1 contiguous.

---

## [-] Project P11: `skillsmith verify` — cross-tool load verification (v0.4.0)
**Goal**: `skillsmith verify <path> [--tool claude-code|codex]... [--static|--deep] [--json]` —
per-tool result **matrix** (never one merged verdict), per-tool severities surfaced, exit codes
for CI. Engine per `research/skill-plugin-load-verification-2026-07-06.md`: Claude static
(`claude plugin validate --strict`), Claude deep (stream-json `init` event via `--plugin-dir` +
`--setting-sources ""`), Codex static (temp-`CODEX_HOME` marketplace/plugin add), Codex deep
(`codex exec` stderr `failed to load skill`). Checkers live in the per-agent dirs
(`agents/<tool>/verify.ts`); core returns `Result`, CLI owns exit codes/output. The `--json`
schema is the public contract consumed by the skill-fleet `skill-verify` skill (smorin-harness P09).

**Out of Scope**: skill *execution* testing (load only); kilo-code/opencode verify; Agent-SDK
mechanism (CLI shell-out first; SDK evaluated as follow-up).

### Tests & Tasks
- [x] [P11-BR] Brainstorm + spec (`docs/superpowers/specs/`): CLI surface, JSON schema, severity model, skip semantics (deep mode proven auth-free) — *opus*
- [ ] [P11-PL] Implementation plan (`docs/superpowers/plans/`) — *fable*
- [ ] [P11-TS01] Port the broken-fixture suite (good/bad-yaml/bad-noframe/bad-nodesc skills; bad manifests ×2 formats) into `packages/core/tests/fixtures/` — *haiku*
- [ ] [P11-T01] Core types: `VerifyReport`/`ToolVerdict`/`Finding` + Result plumbing — *sonnet*
- [ ] [P11-T02] `agents/claude-code/verify.ts`: static validate parser — *sonnet*
- [ ] [P11-T03] `agents/claude-code/verify.ts`: deep init-event check — *opus*
- [ ] [P11-T04] `agents/codex/verify.ts`: static manifest check (temp CODEX_HOME) — *sonnet*
- [ ] [P11-T05] `agents/codex/verify.ts`: deep stderr scrape — *opus*
- [ ] [P11-T06] CLI command: matrix rendering, `--json`, exit codes, help topic — *sonnet*
- [ ] [P11-TS02] Env-gated live e2e against real `claude`/`codex` (skipped in CI, run locally) — *sonnet*
- [ ] [P11-RV] Final whole-branch review — *fable*

### Automated Verification
- `bun run check` green; fixture suite passes; `verify --json` output validates against the schema.

---

## [ ] Project P12: `promote` ⇄ `dev` — bidirectional placement flip (v0.5.0)
**Goal**: Flip a skill/plugin between **dev mode** (symlink → source checkout) and **production**
(pinned copy from a content-addressed store). `skillsmith promote <target>`: verify → snapshot
store@git-SHA → atomic swap symlink→pinned → lockfile record. `skillsmith dev <target>`
(**alias: `demote`**): record prod placement → swap to dev-symlink → lockfile. Round-trip
lossless (lockfile stores both placements); `--rollback` restores prior state. Targets both
Claude (`~/.claude/skills`) and Codex skill dirs where present.

### Tests & Tasks
- [ ] [P12-BR] Brainstorm + spec: lockfile schema, store layout (seed of P09's store), atomicity, multi-tool semantics, naming (`dev` primary / `demote` alias) — *fable*
- [ ] [P12-PL] Implementation plan — *fable*
- [ ] [P12-TS01] Fixture fleet (fake `~/.claude`/`~/.codex` trees with symlink + copy placements) — *haiku*
- [ ] [P12-T01] Placement detection (symlink→repo vs pinned vs absent), per agent dir — *sonnet*
- [ ] [P12-T02] Store snapshot @ SHA + lockfile read/write — *opus*
- [ ] [P12-T03] Atomic swap + `--rollback` (crash-safe ordering) — *opus*
- [ ] [P12-T04] CLI: `promote` / `dev` (alias `demote`), verify-gate integration — *sonnet*
- [ ] [P12-TS02] Round-trip e2e: dev→promote→dev lossless on fixture fleet — *sonnet*
- [ ] [P12-RV] Final whole-branch review — *fable*

### Automated Verification
- Round-trip test green; interrupted-swap test leaves a recoverable state; `bun run check` green.

---

## [ ] Project P14: Production flip — skillsmith v1.0.0
**Goal**: Skillsmith itself dev→production: flip canonical repo public (post scrub), per-platform
compiled binaries, distribution via `smorinlabs/homebrew-tap` + npm, docs refresh (README command
surface, verified-against `claude`/`codex` version matrix), `Release-As: 1.0.0`.

### Tests & Tasks
- [ ] [P14-T01] Public-flip scrub pass (research/ + history review) — *sonnet*
- [ ] [P14-T02] Release binaries (darwin/linux × arm64/x64) wired into release-please release assets — *sonnet*
- [ ] [P14-T03] Homebrew tap formula + npm publish — *sonnet*
- [ ] [P14-T04] README/docs refresh + version matrix — *sonnet*
- [ ] [P14-RV] Final review + `Release-As: 1.0.0` — *fable*

---

## [ ] Project P09: MVP-2c — `install` + `uninstall` (write path) (v0.6.0)
**Goal**: Ship the write path for SkillSmith — `install` and `uninstall` commands targeting **claude-code only**. Introduces the source resolver (Git URL + GitHub shorthand, 4-form parser), partial-clone Git fetch, content-addressed store at `$XDG_DATA_HOME/skillsmith/store/<owner>/<repo>@<sha>/<skill>/`, symlinked entry points, scope flags + auto-default, idempotence, cross-scope duplicate detection, and the remaining exit codes (2/4/5/6/130).

**Out of Scope**
- `install`/`uninstall` for `codex`, `kilo-code`, `opencode` (→ MVP-3).
- `sync`, `apply` (→ MVP-4).
- Cross-tool adaptation; non-claude-code-authored skills install as-authored or are refused.
- `--direct`, lifecycle hooks, values layering, meta-skills, `[compat]` enforcement (→ MVP-5).
- PowerShell completion + Windows in CI matrix (→ Phase 2).

### Tests & Tasks
- [ ] [P09-BR] Brainstorm + spec — design doc at `docs/superpowers/specs/YYYY-MM-DD-mvp-2c-install-design.md`.
- [ ] [P09-PL] Implementation plan — `docs/superpowers/plans/YYYY-MM-DD-mvp-2c-install.md`.
- (Tasks expanded after brainstorm.)

---

## [x] Project P08: MVP-2b.1.1 — plugin-scope discovery + commands primitive (v0.3.1)
**Goal**: Fix `skillsmith list --tool claude-code` reporting 1 skill on a machine with 40+ active skills. Add plugin-bundled skill discovery, slash commands as a separate primitive, `managed` scope, `Origin` tagged union (`standalone | plugin | policy`), and 3-state `EnabledState` (`on | off | unset`).

**Out of Scope**
- Other agents' plugin systems (codex/kilo-code/opencode return stub `[]`/`null`).
- Policy (managed) command discovery — Claude Code policy only ships skills, not commands.

### Tests & Tasks
- [x] [P08-T01] Add `'managed'` to `Scope` union; extend `SCOPES` in `config/types.ts`.
- [x] [P08-T02] Add `PluginProvenanceScope`, `EnabledState`, `Origin` tagged union to `skills/types.ts`; extend `SkillEntry` with `origin` + `enabled`.
- [x] [P08-T03] Add `CommandEntry` in `commands/types.ts` parallel to `SkillEntry`.
- [x] [P08-T04] Add `plugins/installed.ts` (zod-validated `installed_plugins.json` reader).
- [x] [P08-T05] Add `plugins/enablement.ts` (4-layer: managed / user / project / local settings resolver).
- [x] [P08-T06] Add `plugins/discover.ts` (joins installed + enablement; filters project/local by `cwd`).
- [x] [P08-T07] Add `agents/claude-code/managed-path.ts` honoring `CLAUDE_CODE_MANAGED_SETTINGS_PATH` and `CLAUDE_CODE_DISABLE_POLICY_SKILLS`.
- [x] [P08-T08] Extend `Agent` interface with `getCommandRoots`, `getPluginSkillDir`, `getPluginCommandDir`; wire all 4 agents (claude-code real, others stubs).
- [x] [P08-T09] Add `commands/walk.ts` (scans `.md` files, parses frontmatter).
- [x] [P08-T10] Rewrite `scan/list-skills.ts` with `scanStandalone` + `scanPluginBundled`; tag managed scope as `origin: 'policy'`.
- [x] [P08-T11] Add `scan/list-commands.ts` orchestrator (user/project scopes only).
- [x] [P08-T12] Extend `scope-resolver.ts` with `--managed` shorthand.
- [x] [P08-T13] Add `--managed`, `--enabled`, `--disabled`, `--unconfigured` flags to `list` command.
- [x] [P08-T14] Add `commands` subcommand with same flags; reject `--scope=system|managed` with exit 2.
- [x] [P08-T15] Export `CommandEntry`, `Origin`, `EnabledState`, `PluginProvenanceScope` from public API.
- [x] [P08-T16] Add ESLint zones for `plugins/**` and `commands/**` (with `except: ['./types.ts']` for shared type imports).
- [x] [P08-TS01] Unit tests for installed/enablement/discover readers, commands/walk, list-skills origin tagging, list-commands.
- [x] [P08-TS02] Smoke test on author's machine: `skillsmith list --tool claude-code --json` returns 40+ skills with mixed `standalone`/`plugin` origins; `skillsmith commands --tool claude-code --json` returns 48.
- [x] [P08-TS03] `just check` stays green (222 tests).

### Deliverable
```bash
$ skillsmith list --tool claude-code --json | jq '.skills | length'
40
$ skillsmith commands --tool claude-code --json | jq '.commands | length'
48
$ skillsmith --version
0.3.1
```

---

## [x] Project P07: Upgrade commit-msg enforcement to commitlint (v0.2.0)
**Goal**: Replace the grep-based `commit-msg` lefthook hook with `@commitlint/cli` + `@commitlint/config-conventional`, enforce scope allowlist (`cli`, `core`, `main`), and validate PR titles in CI.

### Tests & Tasks
- [x] [P07-T01] Install `@commitlint/cli` and `@commitlint/config-conventional` as root devDependencies.
- [x] [P07-T02] Add `commitlint.config.js` (ESM) extending `@commitlint/config-conventional` with `scope-enum: [cli, core, main]`.
- [x] [P07-T03] Update `lefthook.yml` `commit-msg` hook to use `bunx commitlint --edit {1}`.
- [x] [P07-T04] Add `lint-pr-title` job in `ci.yml` (PR-only, ubuntu, lints `${{ github.event.pull_request.title }}` via commitlint).
- [x] [P07-TS01] Valid message `feat(cli): ...` passes; invalid scope `feat(clie): ...` fails; `chore(main): release X.Y.Z` passes.
- [x] [P07-TS02] `just all` passes green.

---

## [x] Project P04: OSS basics — README, LICENSE, CONTRIBUTING, CHANGELOG (v0.3.0)
**Goal**: Give skillsmith the baseline docs a reader landing on GitHub expects. Phase 1 of the Option B documentation plan.

**Out of Scope**
- Architecture explainer, ADRs, release-process doc (deferred to P05).
- User-facing command reference (deferred; will be added per-command as features ship).
- Docs site, typedoc, auto-generated CLI reference.

### Tests & Tasks
- [x] [P04-T01] Add `LICENSE` (verbatim Apache-2.0) and `NOTICE` (© 2026 Steve Morin) at repo root.
- [x] [P04-T02] Add root `README.md`: what skillsmith is, current status (pre-1.0), install via `bun run build`, quickstart (`skillsmith agents`), link to `CONTRIBUTING.md` and `PROJECTS.md`.
- [x] [P04-T03] Add `CONTRIBUTING.md`: clone → `bun install` → `bun run check`, conventional-commits rule, lefthook notes, ESLint boundary rules pointer.
- [x] [P04-T04] Seed `CHANGELOG.md` from conventional commits; single `[Unreleased]` section above the tagged `[0.1.0]` baseline.
- [x] [P04-T05] Add slim `packages/core/README.md` (library for embedders; public API surface) and `packages/cli/README.md` (pointer to root README).
- [x] [P04-T06] Set `license: "Apache-2.0"` field in each `package.json`.
- [x] [P04-TS01] `bun run check` stays green.
- [x] [P04-TS02] `skillsmith --help` and `skillsmith agents --help` run successfully from source via `bun run dev`.

### Automated Verification
- `bun run check` passes.
- `LICENSE` present; each `package.json` declares `"license": "Apache-2.0"`.

### Manual Verification
- README renders correctly on GitHub (headings, code blocks, links).
- CONTRIBUTING.md `bun run check` instructions work from a fresh clone.

---

## [-] Project P06: Automate CHANGELOG + releases via release-please (v0.3.0)
**Goal**: Replace manual CHANGELOG maintenance and version bumping with `googleapis/release-please-action`. On every push to `main`, release-please parses Conventional Commits and opens/updates a single rolling "Release PR" that bumps root + both workspace package versions and appends to `CHANGELOG.md`. Merging the Release PR creates the git tag and GitHub Release.

**Out of Scope**
- Publishing to npm (core/CLI stay unpublished for now; can be added as a follow-up job triggered by the `release-created` output).
- Building native binaries on release (separate job driven off the release tag, added later).
- Migrating away from Conventional Commits or changing the commit-message policy.

### Tests & Tasks
- [x] [P06-T01] Add `release-please-config.json` (root): `release-type: node`, single `.` package with `package-name: skillsmith`, `changelog-path: CHANGELOG.md`, and `extra-files` bumping `packages/cli/package.json` + `packages/core/package.json` `$.version`. Linked versioning via single-package config.
- [x] [P06-T02] Add `.release-please-manifest.json` seeded at `{ ".": "0.1.0" }`.
- [x] [P06-T03] Add `.github/workflows/release-please.yml` (push to `main`, `contents: write` + `pull-requests: write`, `googleapis/release-please-action@v4`).
- [x] [P06-TS01] `bun run check` stays green (actionlint validates the new workflow).
- [ ] [P06-TS02] After first merge to `main`, confirm a "Release PR" appears with a generated `CHANGELOG.md` entry and synchronized version bumps in all three `package.json` files.

### Automated Verification
- `bun run check` passes (actionlint accepts the new workflow).
- Workflow file exists at `.github/workflows/release-please.yml` and references the `v4` action.

### Manual Verification
- On next push to `main` with a `feat:`/`fix:`/`chore:` commit, release-please opens a PR titled `chore(main): release <version>`.
- Merging that PR creates tag `v<version>` and a GitHub Release whose body matches the CHANGELOG entry.

---

## [x] Project P05: Architecture + ADRs + release doc (v0.3.1)
**Goal**: Capture the non-obvious design decisions already baked into the codebase so future contributors (and future-you) have the rationale. Phase 2 of the Option B documentation plan.

**Out of Scope**
- Auto-generated API docs (typedoc).
- Docs site.
- Per-command user reference (still deferred).

### Tests & Tasks
- [x] [P05-T01] `docs/architecture.md`: one-pager covering package split (`@skillsmith/core` + `skillsmith` CLI), `Result<T, SkillSmithError>` pattern, `ScanEnv` injection, agent registry, detection pipeline, and ESLint boundaries as enforcement.
- [x] [P05-T02] `docs/releases.md`: release-please automated flow, conventional-commits → SemVer mapping, supported binary targets, pre-1.0 manual-override escape hatch.
- [x] [P05-T03] `docs/adr/0001-core-cli-split.md`: why `@skillsmith/core` has zero CLI deps and no side effects.
- [x] [P05-T04] `docs/adr/0002-result-type.md`: why Result-over-exceptions in core.
- [x] [P05-T05] `docs/adr/0003-eslint-import-boundaries.md`: what zones are enforced and why (derived from P01 + P02).
- [x] [P05-T06] Link from root `README.md` → `docs/architecture.md` and `docs/adr/README.md`; link to `docs/releases.md` from CONTRIBUTING-nearby pointer.
- [x] [P05-T07] `docs/adr/README.md` ADR index with numbering convention and "when to write one" guidance.
- [x] [P05-TS01] `bun run check` stays green.
- [x] [P05-TS02] No dead internal links in the new docs (verified by grep scan).

### Automated Verification
- All linked files exist; no dead internal links.
- `bun run check` passes.

### Manual Verification
- Each ADR follows Michael Nygard format (Status/Context/Decision/Consequences).

---

## [x] Project P01: ESLint import boundaries (v0.2.0)
**Goal**: Enforce architectural import boundaries via ESLint's `import/no-restricted-paths` rule, alongside existing Biome lint/format. Option B zones: cross-package boundary (core ↔ cli), in-package CLI layering, and in-package core layering.

**Out of Scope**
- Replacing Biome with ESLint for anything else.
- Adding `@typescript-eslint/eslint-plugin` rules.
- Test-file boundary enforcement (tests are ignored).

### Tests & Tasks
- [x] [P01-T01] Add devDeps: `eslint`, `@typescript-eslint/parser`, `eslint-plugin-import`, `eslint-import-resolver-typescript`.
- [x] [P01-T02] Create root `eslint.config.js` (flat config) with only `import/no-restricted-paths` enabled and the Option B zones defined.
- [x] [P01-T03] Add root scripts: `lint:boundaries`, wire into `check`.
- [x] [P01-T04] Add ESLint step to `lefthook.yml` pre-commit for staged `*.ts` files.
- [x] [P01-TS01] Verify current HEAD passes `bun run lint:boundaries` with zero violations.
- [x] [P01-TS02] Write a deliberate violation and confirm ESLint flags it with `import/no-restricted-paths`, then revert.
- [x] [P01-TS03] `bun run check` is green end-to-end.

### Option B zones (reference)
- `packages/core/src/**` must NOT import from `packages/cli/**`.
- `packages/cli/src/**` must NOT import from `packages/core/src/**` (use `@skillsmith/core` public entry).
- `packages/cli/src/output/**` must NOT import `commands/**` or `index.ts`.
- `packages/cli/src/help/**` must NOT import `commands/**`, `output/**`, or `index.ts`.
- `packages/cli/src/util/**` must NOT import `commands/**`, `output/**`, `help/**`, or `index.ts`.
- `packages/core/src/env/**` must NOT import `agents/**` or `detect/**`.
- `packages/core/src/detect/**` must NOT import `agents/**`.

### Deliverable
```bash
$ bun run lint:boundaries
# exits 0 with no output on clean tree

$ bun run check
# lint + typecheck + actionlint + test all pass
```

### Automated Verification
- `bun run lint:boundaries` exits 0 on current HEAD.
- A deliberate violation exits non-zero and names the offending rule.
- `bun run check` passes.

### Manual Verification
- New `eslint.config.js` present at root.
- `lefthook.yml` includes an `eslint-boundaries` pre-commit command.
- Biome config unchanged.

---

## [x] Project P03: Bug audit round 1 (v0.2.2)
**Goal**: Fix all bugs identified in the round-1 code-wide audit across `packages/core`, `packages/cli`, and project tooling.

**Out of Scope**
- Widening agent detection to new tools.
- Full CLI color palette; wiring `--color` only sets NO_COLOR/FORCE_COLOR env vars.

### Tests & Tasks
- [x] [P03-T01] exec.ts: early-return on pre-aborted signal; read stdout concurrently with `proc.exited`.
- [x] [P03-T02] Root `build` script no longer hardcodes `bun-darwin-arm64`; per-target scripts plus native detection via `scripts/build-native.ts`.
- [x] [P03-T03] `detectTool` accepts a signal; `detectAll` forwards `opts.signal` to each agent.
- [x] [P03-T04] `renderAgentsMarkdown` escapes `|`, `\`, and newlines in cells.
- [x] [P03-T05] `--color` flag reads via `resolveColorMode` and sets `NO_COLOR`/`FORCE_COLOR`.
- [x] [P03-T06] lefthook Biome and typecheck globs use `**/` prefix.
- [x] [P03-T07] Core boundary refactor: moved `exec.ts` to `env/`, split `InstallMethod`/`InstallRecord` into `detect/types.ts`, moved orchestrator to `scan/`. ESLint zones added for env↛agents, env↛detect, detect↛agents.
- [x] [P03-T08] `defaultScanEnv` uses platform `path.delimiter` for PATH split.
- [x] [P03-T09] `classifyInstallMethod` returns new `'bun-global'` for `~/.bun/install/global/**`.
- [x] [P03-T10] `fileExists` drops `existsSync` fallback; `catch { return false; }`.
- [x] [P03-T11] SIGINT handler sets `process.exitCode = 130` and exposes `wasInterrupted()`; `main()` returns 130 on interrupt.
- [x] [P03-T12] `help [topic]` emits an internal-error and exits 1 if a known topic has no content.
- [x] [P03-TS01] New test for bun-global classification.
- [x] [P03-TS02] New test for markdown cell escaping.

### Automated Verification
- `bun run check` passes (biome + eslint + tsc + actionlint + bun test).
- `bun run build` produces a native binary; `./dist/skillsmith agents --format json` parses.

---

## [x] Project P02: Port `check-core-boundary.ts` to ESLint (v0.2.1)
**Goal**: Replace the custom `scripts/check-core-boundary.ts` runtime check with equivalent ESLint rules, consolidating the core-isolation boundary into a single tool.

**Out of Scope**
- Widening forbidden imports or calls beyond the script's original list.
- Enforcing these rules against `packages/core/tests/**`.

### Tests & Tasks
- [x] [P02-T01] Add a second config block in `eslint.config.js` scoped to `packages/core/src/**/*.ts` with `no-restricted-imports` (commander, chalk, consola, @clack/prompts) and `no-restricted-syntax` (`process.exit`, `console.{log,info,warn,error,debug}`).
- [x] [P02-T02] Replace the "Core boundary check" step in `.github/workflows/ci.yml` with an ESLint boundaries step.
- [x] [P02-T03] Delete `scripts/check-core-boundary.ts`.
- [x] [P02-TS01] `bun run lint:boundaries` is clean on HEAD.
- [x] [P02-TS02] Deliberate probe file importing `commander`/`chalk` and calling `console.log`/`process.exit` is flagged by both rules; revert.
- [x] [P02-TS03] `bun run check` is green end-to-end.

### Automated Verification
- `bun run lint:boundaries` exits 0 on HEAD.
- `scripts/check-core-boundary.ts` no longer exists.
- CI workflow no longer references the script.
