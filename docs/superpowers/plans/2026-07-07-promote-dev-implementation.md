# SkillSmith P12 Implementation Plan — `skillsmith promote` ⇄ `skillsmith dev`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Each task below is self-contained and dispatchable to a
> fresh implementer subagent that has **not** read the design spec — every schema, path grammar,
> phase order, and recovery rule an implementer needs is copied inline.

**Goal:** Ship `skillsmith promote <skill>…` and `skillsmith dev <skill>…` (alias `demote`)
(v0.5.0, internal milestone): flip an installed skill between **dev mode** (the tool's skills
directory holds a symlink into a local source checkout) and **production** (a pinned copy
materialized from a content-addressed store). `promote` = verify gate → snapshot store@rev →
journaled atomic swap → ledger record. `dev` = pinned → symlink from the recorded source. The
round trip is lossless (the ledger retains both placements) and `--rollback` restores the prior
state, including from an interrupted swap.

**Architecture:** Per-agent placement detection lives in
`packages/core/src/agents/claude-code/placement.ts` and `packages/core/src/agents/codex/placement.ts`
(house per-agent boundary — separate files even when similar, sharing a one-call helper). A new
high-level orchestrator `packages/core/src/place/` (like `verify/`) owns the ledger, store, swap
state machine, planning, and the promote/dev/rollback entry points. Core returns
`Result<T, SkillSmithError>` and never prints or exits; the CLI
(`packages/cli/src/commands/promote.ts`, `dev.ts`) owns flags, exit codes, and rendering
(`output/flip-human.ts`, `output/flip-json.ts`). All filesystem mutation goes through injected
`ScanEnv` primitives so the swap engine is unit-testable with deterministic crash injection.

**Tech stack:** Bun ≥ 1.3.14 workspace; TypeScript; `bun:test`; `zod` (already in both packages);
`proper-lockfile` — **already a runtime dependency of `@skillsmith/core`** (used by
`config/save.ts` since MVP-2a) with `@types/proper-lockfile` present. **No dependency changes of
any kind in this project.**

**Spec:** `docs/superpowers/specs/2026-07-07-promote-dev-design.md`
**Command surface:** `research/commands/promote.md`, `research/commands/dev.md`
**Prerequisite:** `v0.4.0` (P11) shipped — the verify gate calls `verifyPlugin` and git
interrogation reuses `ScanEnv.exec`.
**Branch:** `p12-promote-dev`, squash-merge PR at the end.
**Suggested PR title (becomes the release commit):**
`feat(cli): add skillsmith promote and dev placement flip commands`

Adjudicated open questions (do not design for them): P09 journal reuse is deferred — build
nothing speculative for it; `dev --source` accepts a **local path only** — no `owner/repo`
shorthand, no fetching.

---

## Global Constraints (binding — copy verbatim into every implementer and reviewer prompt)

1. **Core purity.** `@skillsmith/core` (`packages/core/src/**`) must not import `commander`,
   `chalk`, `consola`, `@clack/prompts`, or `node:console`, and must not call `process.exit(...)`
   or `console.{log,info,warn,error,debug}(...)`. Fallible core functions return
   `Result<T, SkillSmithError>`. The CLI alone decides exit codes and output. Enforced by
   `bun run lint:boundaries` (ESLint).
2. **Import direction.** `core/src/env/` is the lowest layer; `detect/` may import `env/`;
   `agents/` may import `env/` + `detect/`. New `core/src/place/` is a high-level orchestrator
   (like `verify/`): it may import `env/`, `detect/`, `agents/`, `verify/` (promote gate),
   `errors.ts`, `result.ts`; the leaves `skills/`, `plugins/`, `commands/` and also `verify/`
   must NOT import `place/` (place → verify is one-way). `agents/<tool>/placement.ts` must NOT
   import `place/` (types it shares live under `agents/`). In the CLI, `output/`, `help/`,
   `util/` are leaves that must not import `commands/` or `index.ts`; CLI imports core only via
   the `@skillsmith/core` package entry.
3. **Per-agent boundary.** `agents/claude-code/placement.ts` and `agents/codex/placement.ts` stay
   separate files even where bodies look similar. Share mechanics via a helper each file calls in
   one line (pattern: `agents/detect-factory.ts`). Codex dual-root policy lives inside
   `agents/codex/placement.ts` only. Do not touch kilo-code / opencode.
4. **Ledger contract stability.** The placements ledger at `$SKILLSMITH_DATA/placements.json` is
   `{"schemaVersion": 1, "kind": "skillsmith.placements", ...}` — a versioned contract. Evolution
   is **additive only** within v1 (new optional fields; renaming/removing/retyping bumps the
   version). Copy field names exactly as given in Task 3. A missing ledger file is initialized
   fresh; an **unparseable ledger is a hard error (exit 3) and is never silently regenerated** —
   it holds the only copy of dev↔prod round-trip state.
5. **Never delete from the store.** Store entries under `$SKILLSMITH_DATA/store/` are write-once
   and immutable. P12 code must contain **no store-entry deletion path** (GC is P09's). The only
   deletions P12 ever performs: staging remnants (`store/.staging/<txId>`, placement
   `.skillsmith-staging-*`) and a demoted placement's backup copy **only after** its content hash
   matches the retained store entry.
6. **An unresolved journal blocks everything.** A (skill, tool) pair whose ledger `journal` is
   non-null with `phase !== 'committed'` refuses **every** operation except `--rollback` and a
   same-op re-run — exit 2, message naming both options. No command may bypass this.
7. **Store path / rev grammar (frozen — P09 inherits it byte-for-byte):**

   ```text
   $SKILLSMITH_DATA/store/<ns>/<name>@<rev>/<skill>/
     ns/name  := <owner>/<repo>      # origin remote parseable as a GitHub-style owner/repo
               | local/<dirname>     # no repo, or no parseable remote (dirname = repo-root or source basename)
     rev      := <sha12>             # clean git tree (P09-identical form)
               | dirty-<hash12>      # dirty git tree, via --allow-dirty
               | content-<hash12>    # non-git source
     skill    := skill leaf name
   ```

   `<sha12>` = first 12 hex of the full commit SHA (full SHA lives in the ledger). `<hash12>` =
   first 12 hex of the canonical content hash. The prefixed forms (`dirty-`, `content-`) and the
   `local/` namespace can never collide with bare `<sha12>` under a GitHub owner name. Nothing
   else may ever be minted as a rev.
   `$SKILLSMITH_DATA` = `$SKILLSMITH_HOME` if set, else `$XDG_DATA_HOME/skillsmith`, else
   `~/.local/share/skillsmith`.
8. **Exit codes (the CI contract; batch = highest per-(skill,tool) code):**

   | Code | Meaning for `promote` / `dev` |
   |---|---|
   | `0` | All pairs `flipped` / `updated` / `noop` / `skipped` / `rolled-back`. Idempotent no-ops are successes. |
   | `1` | A pair `failed` (verify-gate `fail`, snapshot integrity error, mid-flight I/O error — state left recoverable). |
   | `2` | Usage or refusal: bad flag combination, `--all` + positionals, unknown `--tool` value, path target outside every skills root, `--source` invalid/missing when required, dirty tree without `--allow-dirty`, codex dual-location conflict, unresolved journal without `--rollback`/same-op re-run. |
   | `3` | Placements ledger unreadable/unparseable (never silently regenerated). |
   | `4` | No placement for an explicitly requested target/tool: unknown skill name, or `--tool`-named tool has no flippable placement. |
   | `5` | Dev source unresolvable: dangling dev symlink on `promote`, recorded `dev.sourcePath` missing on `dev`. |
   | `6` | Permission: skills root, store, or ledger path not writable. |
   | `130` | SIGINT — in-flight pair finishes its current journal write, then aborts; state recoverable. |

   Exit codes are computed by the CLI from the report (per-result `error` → code via
   `exitCodeForError`, batch max), never inside core. **Verify-gate `fail` is action `failed`,
   exit 1** (spec §9 + §12 + the mockup in `research/commands/promote.md`; the §11 aside listing
   it under `refused` is superseded by those three).
9. **JSON contract stability.** `--json` emits `{"schemaVersion": 1, "kind": "skillsmith.flip", ...}`
   (one schema for both commands and `--rollback`), zod-validated before writing, additive-only
   evolution within v1. Copy field names exactly as given in Task 5.
10. **Commits.** Conventional Commits; commitlint enforces scope ∈ `{cli, core, main}` or **no
    scope** (root configs, docs, cross-package tests, tooling). Body lines ≤ 100 chars. `feat:`
    bumps minor; `test:`/`docs:`/`chore:` bump nothing. `main` scope is reserved for
    release-please.
11. **No hand-edits to release-please-managed files:** root `package.json` version,
    `packages/cli/package.json`, `packages/core/package.json`, `CHANGELOG.md`,
    `.release-please-manifest.json`. The bump to 0.5.0 happens via the squash-merged PR title.
12. **Crash contract (D9).** Full recovery from process death at any instant is mandatory and
    test-proven; power-loss safety is best-effort via plain `fsync` of staged files, the ledger,
    and parent directories. Do **not** "upgrade" fsync to `F_FULLFSYNC` — that trades 3× I/O for
    a guarantee D9 deliberately does not make.
13. **Tests first.** Write the failing test, watch it fail, then implement. Verification for
    every task ends with `bunx tsc --noEmit`, `bun run lint:boundaries`, targeted `bun test`, and
    `bunx @biomejs/biome check --write <changed paths>`; the branch must keep `bun run check`
    green.

---

## Conventions

- Paths are repo-relative from the workspace root.
- `bun test` auto-discovers `*.test.ts`; helper files without that suffix are not collected.
- Model per task follows PROJECTS.md P12: TS01 = haiku; T01, T04, TS02 = sonnet; T02, T03 = opus.
  Task review after each; the final whole-branch review (P12-RV, fable) is outside this plan's
  task list.
- The orchestrator (not the implementer) flips the matching PROJECTS.md checkbox after each task
  is reviewed.
- Everything operates on **user scope only**. Skills roots come from the existing
  `agents/<tool>/skill-roots.ts` with scope `'user'`: claude-code `~/.claude/skills`
  (honors `CLAUDE_CONFIG_DIR`); codex `~/.agents/skills` (current, ranked first) **and**
  `~/.codex/skills` (legacy, honors `CODEX_HOME`).

---

## Task 1 [P12-TS01] — Fixture fleet builder (model: haiku)

A reusable test fixture that reproduces the real-world fleet: hand-made dev symlinks into a git
checkout, hand-copied pinned dirs, a dangling symlink, codex dual roots with a duplicate, dot
entries, and a non-git source. Built **at test time into a temp dir** (committed fixtures cannot
hold absolute symlinks or a `.git` dir); the builder code lives under
`packages/core/tests/fixtures/place/`.

**Files:**
- Create: `packages/core/tests/fixtures/place/fleet.ts` (builder helper — not a test file)
- Create: `packages/core/tests/place/fleet.test.ts`

**Interface produced (exact — every later task consumes this):**

```ts
import type { ScanEnv } from '../../../src/env/types.ts';

export interface FixtureFleet {
  base: string;      // mkdtemp root; everything lives under it
  home: string;      // <base>/home — fake $HOME
  data: string;      // <base>/data — $SKILLSMITH_DATA (store + ledger land here)
  checkout: string;  // <base>/checkout — a REAL git repo (init + commit at build time)
  alphaSrc: string;  // <checkout>/plugins/fh/skills/alpha
  betaSrc: string;   // <checkout>/plugins/fh/skills/beta
  gammaSrc: string;  // <base>/loose/gamma — non-git skill source
  headSha: string;   // full 40-hex HEAD SHA of the checkout
  env: ScanEnv;      // defaultScanEnv() with homeDir overridden to <home>
  envVars: Record<string, string | undefined>; // { SKILLSMITH_HOME: <data> }
  makeCheckoutDirty(): Promise<void>; // appends a line to alpha's SKILL.md (unstaged change)
}

export const buildFixtureFleet = (): Promise<FixtureFleet>;
export const destroyFixtureFleet = (f: FixtureFleet): Promise<void>; // rm -rf <base>
```

**Fleet contents (exact; create in this order):**

| Path (under `<base>`) | Kind | Target / content |
|---|---|---|
| `checkout/` | git repo | `git init` then one commit (see below) |
| `checkout/plugins/fh/skills/alpha/SKILL.md` | file | frontmatter `name: alpha`, `description: Fixture skill alpha.`, body `# alpha` |
| `checkout/plugins/fh/skills/alpha/bin/run.sh` | file, **exec bit set** (`chmod 0o755`) | `#!/bin/sh\necho alpha\n` |
| `checkout/plugins/fh/skills/alpha/link.md` | **relative symlink** | target `SKILL.md` |
| `checkout/plugins/fh/skills/beta/SKILL.md` | file | frontmatter `name: beta`, `description: Fixture skill beta.` |
| `loose/gamma/SKILL.md` | file | frontmatter `name: gamma`, `description: Non-git fixture skill.` |
| `home/.claude/skills/alpha` | symlink | **absolute** path of `alphaSrc` (a hand-made dev placement) |
| `home/.claude/skills/copied` | real dir | contains `SKILL.md` (`name: copied`) — a hand-copied pinned-class placement, no ledger record |
| `home/.claude/skills/dangler` | symlink | `<checkout>/plugins/fh/skills/deleted` (target does NOT exist — dangling) |
| `home/.claude/skills/.system/keep` | file | any content — dot-entry that detection must ignore |
| `home/.agents/skills/beta` | symlink | absolute path of `betaSrc` (codex current root, dev) |
| `home/.codex/skills/legacy-only` | symlink | absolute path of `alphaSrc` (codex legacy root only) |
| `home/.agents/skills/dup` | real dir | contains `SKILL.md` (`name: dup`) |
| `home/.codex/skills/dup` | real dir | contains `SKILL.md` (`name: dup`) — the both-roots conflict |
| `home/.codex/skills/gamma` | symlink | absolute path of `gammaSrc` (non-git dev source) |
| `data/` | empty dir | ledger/store parent |

**Git recipe (deterministic, hermetic):** run via `Bun.spawnSync` with
`cwd: <base>/checkout` and `env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }`:

1. `git init -q -b main`
2. `git -c user.email=fixture@skillsmith.test -c user.name=fixture -c commit.gpgsign=false add -A`
3. `git -c user.email=fixture@skillsmith.test -c user.name=fixture -c commit.gpgsign=false commit -qm "fixture: initial"`
4. `git remote add origin git@github.com:smorinlabs/fixture-harness.git`
5. `headSha` = stdout of `git rev-parse HEAD`, trimmed (must match `/^[0-9a-f]{40}$/`).

`env` member: `{ ...(await defaultScanEnv()), homeDir: f.home }` (import `defaultScanEnv` from
`../../../src/env/default.ts`). `makeCheckoutDirty` appends `\ndirty edit\n` to
`alphaSrc/SKILL.md` and does not commit.

- [ ] **Step 1: Write the failing shape test** `packages/core/tests/place/fleet.test.ts` using
  `node:fs/promises` `lstat`/`readlink`/`stat`:
  - `buildFixtureFleet()` resolves; `checkout/.git` exists; `headSha` matches `/^[0-9a-f]{40}$/`.
  - `git -C <checkout> status --porcelain` (spawnSync) is empty; after `makeCheckoutDirty()` it
    is non-empty and contains `plugins/fh/skills/alpha/SKILL.md`.
  - `home/.claude/skills/alpha` is a symlink whose `readlink` equals `alphaSrc` exactly.
  - `home/.claude/skills/copied` is a real directory (lstat `isDirectory()`, not a symlink).
  - `home/.claude/skills/dangler` is a symlink and `stat` on it rejects (dangling).
  - `home/.agents/skills/dup` and `home/.codex/skills/dup` are both real directories.
  - `home/.codex/skills/gamma` readlink equals `gammaSrc`.
  - `alpha/bin/run.sh` mode has the owner-exec bit (`(mode & 0o100) !== 0`); `alpha/link.md` is a
    symlink with literal target `SKILL.md`.
  - `env.homeDir` equals `f.home`; `envVars.SKILLSMITH_HOME` equals `f.data`.
  - `destroyFixtureFleet` removes `<base>`.
  Run: `bun test packages/core/tests/place/fleet.test.ts` — expect FAIL (module missing).
- [ ] **Step 2: Implement** `fleet.ts` with `node:fs/promises` (`mkdtemp`, `mkdir`, `writeFile`,
  `symlink`, `chmod`, `rm`) + `Bun.spawnSync` for git. Throw a plain `Error` if any git step
  exits non-zero (fixtures may assume git is installed — the repo's own toolchain requires it).
- [ ] **Step 3: Verify** — the shape test passes; `bunx tsc --noEmit` clean;
  `bunx @biomejs/biome check --write packages/core/tests`.
- [ ] **Step 4: Commit**

```bash
git add packages/core/tests/fixtures/place/fleet.ts packages/core/tests/place/fleet.test.ts
git commit -m "test(core): add P12 placement fixture fleet builder" \
  -m "Temp-dir fleet: real git checkout (clean/dirty/SHA), hand-made dev symlinks, hand-copied" \
  -m "pinned dir, dangling link, codex dual roots with duplicate, dot entries, non-git source."
```

**Automated verification:** `bun test packages/core/tests/place/fleet.test.ts` · `bunx tsc --noEmit`

---

## Task 2 [P12-T01] — Env fs primitives + placement detection per agent (model: sonnet)

**Consumes:** Task 1's `buildFixtureFleet`.

**Files:**
- Modify: `packages/core/src/env/types.ts` (add fs primitives to `ScanEnv`)
- Modify: `packages/core/src/env/default.ts` (implement them)
- Modify: `packages/core/src/errors.ts` (six new error variants)
- Modify: `packages/cli/src/util/exit-codes.ts` (map the new variants — keeps the exhaustive
  switch compiling)
- Create: `packages/core/src/place/types.ts` (placement + flip type foundation)
- Create: `packages/core/src/place/paths.ts` (`$SKILLSMITH_DATA` resolution)
- Create: `packages/core/src/agents/placement-shared.ts` (classification helper + types)
- Create: `packages/core/src/agents/claude-code/placement.ts`
- Create: `packages/core/src/agents/codex/placement.ts`
- Modify: `eslint.config.js` (place/ zones), `docs/adr/0003-eslint-import-boundaries.md` (zone note)
- Create: `packages/core/tests/env/fs-primitives.test.ts`,
  `packages/core/tests/agents/claude-code/placement.test.ts`,
  `packages/core/tests/agents/codex/placement.test.ts`,
  `packages/core/tests/place/paths.test.ts`
- Modify (mechanical): every existing test file that builds a `ScanEnv` object literal — add the
  stub block below. Find them with `grep -rln "exec: async" packages/core/tests packages/cli/tests`.

**Interfaces produced (exact — consumed by every later task):**

`packages/core/src/env/types.ts` additions:

```ts
export type PathKind = 'file' | 'dir' | 'symlink' | 'absent';

// added members on ScanEnv (all lstat-flavored; a dangling symlink is 'symlink', never 'absent'):
pathKind(p: string): Promise<PathKind>;
isExecutable(p: string): Promise<boolean>;         // owner-exec bit of a regular file
readBytes(p: string): Promise<Uint8Array>;         // binary-safe read (content hashing)
readLink(p: string): Promise<string>;              // LITERAL symlink target, no resolution
makeSymlink(target: string, linkPath: string): Promise<void>;
rename(from: string, to: string): Promise<void>;   // rename(2); atomic within a filesystem
copyTree(from: string, to: string): Promise<void>; // recursive; preserves symlinks verbatim + file modes
removeTree(p: string): Promise<void>;              // rm -rf; succeeds when absent
makeDir(p: string): Promise<void>;                 // mkdir -p
writeTextFile(p: string, text: string): Promise<void>;
fsyncFile(p: string): Promise<void>;
fsyncDir(p: string): Promise<void>;
withFileLock<T>(p: string, fn: () => Promise<T>): Promise<T>; // proper-lockfile; see below
```

Spec-name mapping (design D15): the spec's `readDir`/`readTextFile` are the **existing**
`listDir`/`readText` — do not duplicate them; `readBytes`/`isExecutable` are additions required
by the canonical content hash (exec bit + binary-safe bytes). Everything else matches D15 by name.

`defaultScanEnv()` implementations (`node:fs/promises` unless noted): `pathKind` via `lstat`
(`ENOENT` → `'absent'`; `isSymbolicLink()` → `'symlink'`; `isDirectory()` → `'dir'`; else
`'file'`); `isExecutable` via `stat` `(mode & 0o100) !== 0`; `readBytes` via `readFile`;
`readLink` via `readlink`; `makeSymlink(target, linkPath)` via `symlink(target, linkPath)`;
`rename` via `rename`; `copyTree` via `cp(from, to, { recursive: true, verbatimSymlinks: true })`;
`removeTree` via `rm(p, { recursive: true, force: true })`; `makeDir` via
`mkdir(p, { recursive: true })`; `writeTextFile` via `writeFile(p, text, 'utf8')`; `fsyncFile` /
`fsyncDir` via `open(p, 'r')` → `handle.sync()` → `handle.close()` (close in `finally`);
`withFileLock` via `proper-lockfile`'s `lock(p, { stale: 30_000, update: 5_000, retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 2_000 } })`,
release in `finally` with `.catch(() => {})` (pattern: `config/save.ts`). The lock **target file
must already exist** — callers (Task 3's ledger) guarantee that.

`packages/core/src/errors.ts` additions (append to the union + one constructor each, house style):

```ts
| { code: 'placement-not-found'; message: string }   // exit 4
| { code: 'source-unresolvable'; message: string }   // exit 5
| { code: 'ledger-error'; message: string; file?: string } // exit 3
| { code: 'permission-denied'; message: string; path?: string } // exit 6
| { code: 'flip-refused'; message: string }          // exit 2
| { code: 'flip-failed'; message: string }           // exit 1
```

`packages/cli/src/util/exit-codes.ts`: extend the switch — `flip-failed` → 1, `flip-refused` → 2,
`ledger-error` → 3, `placement-not-found` → 4, `source-unresolvable` → 5, `permission-denied` → 6.

`packages/core/src/agents/placement-shared.ts` (whole contract):

```ts
import type { ScanEnv } from '../env/types.ts';

export type PlacementClass = 'dev' | 'pinned' | 'store-linked' | 'absent';

export interface Placement {
  skill: string;               // leaf name in the skills root
  root: string;                // the skills root it was found in
  path: string;                // join(root, skill)
  class: PlacementClass;
  symlinkTarget: string | null; // LITERAL readlink value for 'dev'/'store-linked'; null otherwise
  dangling: boolean;            // 'dev' symlink whose resolved target is absent
}

/** Classification per spec §2: symlink outside the store → 'dev'; real dir → 'pinned';
 *  symlink inside storeRoot → 'store-linked'; nothing → 'absent'. */
export const classifyPlacement = (
  env: ScanEnv,
  root: string,
  skill: string,
  storeRoot: string,
): Promise<Placement>;

/** Every non-dot entry of the root, classified. A missing root yields []. Dot-prefixed entries
 *  (`.system`, `.skillsmith-staging-*`, `.skillsmith-backup-*`) are never placements. */
export const listPlacements = (
  env: ScanEnv,
  root: string,
  storeRoot: string,
): Promise<Placement[]>;
```

Classification rules (implement exactly):
- `pathKind(path) === 'absent'` → `class: 'absent'`.
- `'dir'` → `'pinned'`. `'file'` → `'absent'` (a stray file is not a placement).
- `'symlink'` → `readLink` for the literal target; resolve it against `dirname(path)` when
  relative; if the resolved path is inside `storeRoot` (prefix match on path segments) →
  `'store-linked'`, else `'dev'`. `dangling` = resolved target `pathKind` is `'absent'` (a
  dangling symlink is still `'dev'` — spec §2).

`packages/core/src/agents/claude-code/placement.ts`:

```ts
import type { SkillRootsCtx } from './skill-roots.ts';
export const claudeCodeSkillRootsUser = (env: ScanEnv, ctx: SkillRootsCtx): readonly string[];
  // = getSkillRoots(env, 'user', ctx) from './skill-roots.ts' — exactly one root
export const listClaudeCodePlacements = (
  env: ScanEnv, ctx: SkillRootsCtx, storeRoot: string,
): Promise<Placement[]>; // listPlacements over the single user root
```

`packages/core/src/agents/codex/placement.ts` (dual-root policy data lives here):

```ts
export interface CodexPlacementScan {
  placements: Placement[];      // from both roots; current root (~/.agents/skills) listed first
  duplicates: string[];         // skill names present (as flippable classes) in BOTH roots
  legacyRoot: string;           // resolved legacy root (~/.codex/skills or $CODEX_HOME/skills)
  currentRoot: string;          // resolved current root (~/.agents/skills)
}
export const listCodexPlacements = (
  env: ScanEnv, ctx: SkillRootsCtx, storeRoot: string,
): Promise<CodexPlacementScan>;
```

Roots come from `getSkillRoots(env, 'user', ctx)` in `./skill-roots.ts` (already returns
`[~/.agents/skills, $CODEX_HOME|~/.codex/skills]` in that order). A skill counts as a duplicate
when it is non-`absent` in both roots.

`packages/core/src/place/paths.ts`:

```ts
export const resolveDataDir = (
  env: ScanEnv, envVars: Record<string, string | undefined>,
): string; // envVars.SKILLSMITH_HOME ?? join(env.xdg.data, 'skillsmith')
export const storeRootOf = (dataDir: string): string;   // join(dataDir, 'store')
export const ledgerPathOf = (dataDir: string): string;  // join(dataDir, 'placements.json')
```

`packages/core/src/place/types.ts` — create with what this task needs; later tasks **append**:

```ts
export const FLIP_TOOLS = ['claude-code', 'codex'] as const;
export type FlipTool = (typeof FLIP_TOOLS)[number];
export type FlipOp = 'promote' | 'dev' | 'rollback';
export type { Placement, PlacementClass } from '../agents/placement-shared.ts'; // re-export
```

- [ ] **Step 1: Failing tests for the fs primitives.** `packages/core/tests/env/fs-primitives.test.ts`
  with `defaultScanEnv()` against a `mkdtemp` scratch dir: `pathKind` on file/dir/symlink/absent
  and on a **dangling** symlink (→ `'symlink'`); `readLink` returns the literal relative target
  (`SKILL.md`, not an absolute resolution); `makeSymlink` + `readLink` round-trip; `rename`
  moves; `copyTree` copies a tree containing a relative symlink (stays a symlink with the same
  literal target) and an exec-bit file (bit preserved); `removeTree` on absent path resolves;
  `makeDir` is recursive; `writeTextFile`/`readBytes` round-trip bytes; `fsyncFile`/`fsyncDir`
  resolve on real paths; `withFileLock` runs the fn and releases (a second sequential
  `withFileLock` on the same path succeeds); two **concurrent** `withFileLock` calls on one path
  never interleave (assert via a shared counter and a 50 ms hold).
- [ ] **Step 2: Implement + mechanical stub update.** Implement `env/types.ts` + `env/default.ts`.
  Then add this exact stub block to every existing test `ScanEnv` literal (same files as the
  `exec: async` grep):

  ```ts
  pathKind: async () => 'absent' as const,
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  makeSymlink: async () => {},
  rename: async () => {},
  copyTree: async () => {},
  removeTree: async () => {},
  makeDir: async () => {},
  writeTextFile: async () => {},
  fsyncFile: async () => {},
  fsyncDir: async () => {},
  withFileLock: (_p, fn) => fn(),
  ```

  Run `bunx tsc --noEmit` — clean compile proves you found every literal.
- [ ] **Step 3: errors + exit map.** Add the six variants + constructors
  (`placementNotFoundError(message)`, `sourceUnresolvableError(message)`,
  `ledgerError(message, file?)`, `permissionDeniedError(message, path?)`,
  `flipRefusedError(message)`, `flipFailedError(message)`) and extend
  `packages/cli/src/util/exit-codes.ts` per the table above. Append the new codes to
  `packages/core/tests/errors.test.ts` if it enumerates constructors.
- [ ] **Step 4: Failing detection tests.** Both placement test files build the Task-1 fleet
  (`buildFixtureFleet`) with `storeRoot = join(f.data, 'store')` and
  `ctx = { cwd: f.base, envVars: {} }`:
  - claude-code: `alpha` → `class 'dev'`, `symlinkTarget === f.alphaSrc`, `dangling false`;
    `copied` → `'pinned'`, `symlinkTarget null`; `dangler` → `'dev'`, `dangling true`; a name
    with no entry → `'absent'`; `listClaudeCodePlacements` returns exactly
    `{alpha, copied, dangler}` — **no `.system`**.
  - store-linked: create `<storeRoot>/local/x@content-abcdef123456/x` (real dir) and a symlink
    `home/.claude/skills/slink` pointing at it inside the test → `classifyPlacement` →
    `'store-linked'`.
  - dot-staging invisibility (spec §15): create
    `home/.claude/skills/.skillsmith-staging-alpha-deadbeef` and
    `.skillsmith-backup-alpha-deadbeef` dirs → `listClaudeCodePlacements` output unchanged.
  - codex: `listCodexPlacements` → placements include `beta` (current root, dev),
    `legacy-only` (legacy root, dev), `gamma` (legacy root, dev, target `f.gammaSrc`);
    `duplicates === ['dup']`; `currentRoot` ends with `.agents/skills`; `legacyRoot` ends with
    `.codex/skills`; with `ctx.envVars.CODEX_HOME` set to a temp dir, `legacyRoot` honors it.
  - `place/paths.ts`: `resolveDataDir` prefers `SKILLSMITH_HOME`, falls back to
    `join(env.xdg.data, 'skillsmith')`.
- [ ] **Step 5: Implement** `placement-shared.ts`, both per-agent files, `place/paths.ts`,
  `place/types.ts`.
- [ ] **Step 6: ESLint zones + ADR note.** In `eslint.config.js`, after the verify zones add:

  ```js
  // place is a high-level orchestrator; leaves must not import it. place imports verify
  // (promote gate), so verify must never import place back.
  { target: './packages/core/src/skills', from: './packages/core/src/place' },
  { target: './packages/core/src/plugins', from: './packages/core/src/place' },
  { target: './packages/core/src/commands', from: './packages/core/src/place' },
  { target: './packages/core/src/verify', from: './packages/core/src/place' },
  ```

  Append to the zone list in `docs/adr/0003-eslint-import-boundaries.md` (Decision §1):
  `- packages/core/src/{skills,plugins,commands,verify} ↛ place (place is a high-level orchestrator that imports verify for the promote gate).`
- [ ] **Step 7: Verify and commit.**

```bash
git add -A packages/core packages/cli/src/util/exit-codes.ts eslint.config.js docs/adr/0003-eslint-import-boundaries.md packages/cli/tests
git commit -m "feat(core): add fs env primitives and per-agent placement detection" \
  -m "ScanEnv gains lstat-flavored fs + lock primitives (injected, fake-able); placement" \
  -m "classification dev/pinned/store-linked/absent per agent dir with codex dual-root scan;" \
  -m "flip error codes mapped to exit codes; eslint zones for place/."
```

**Automated verification:** `bun test packages/core/tests/env/fs-primitives.test.ts packages/core/tests/agents packages/core/tests/place` · `bunx tsc --noEmit` · `bun run lint:boundaries`

---

## Task 3 [P12-T02] — Content-addressed store + placements ledger (model: opus)

**Consumes:** Task 2's env primitives, `place/paths.ts`, error constructors; `env.exec` (P11) for
git; Task 1's fleet.

**Files:**
- Create: `packages/core/src/place/store.ts`
- Create: `packages/core/src/place/ledger.ts`
- Modify: `packages/core/src/place/types.ts` (append ledger/store types)
- Create: `packages/core/tests/place/content-hash.test.ts`,
  `packages/core/tests/place/store.test.ts`, `packages/core/tests/place/ledger.test.ts`
- Create: `packages/core/tests/fixtures/place/ledger.golden.json`

### The ledger contract (copy exactly — this JSON shape is frozen at schemaVersion 1)

Location: `$SKILLSMITH_DATA/placements.json` (`$SKILLSMITH_DATA` = `$SKILLSMITH_HOME` if set,
else `$XDG_DATA_HOME/skillsmith`, else `~/.local/share/skillsmith` — `place/paths.ts`).

```jsonc
{
  "schemaVersion": 1,
  "kind": "skillsmith.placements",
  "updatedAt": "2026-07-07T18:20:11Z",
  "skills": {
    "factor-scan": {
      "tools": {
        "claude-code": {
          "placementPath": "/Users/alice/.claude/skills/factor-scan",
          "mode": "pinned",                          // 'dev' | 'pinned'
          "dev": {                                   // retained across promote (D5); null when never recorded
            "sourcePath": "/Users/alice/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan",
                                                     // LITERAL symlink target, restored verbatim on demote
            "resolvedPath": "/Users/alice/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan",
            "repoRoot": "/Users/alice/c/smorinlabs-harness",              // null when non-git
            "sourceRelPath": "plugins/factor-harness/skills/factor-scan", // null when non-git
            "remote": "smorinlabs/smorinlabs-harness",                    // parsed owner/repo; null when unparseable
            "recordedAt": "2026-07-07T18:20:11Z"
          },
          "pinned": {                                // retained across dev (D5); null when never promoted
            "storePath": "/Users/alice/.local/share/skillsmith/store/smorinlabs/smorinlabs-harness@3f2a1b9c0d4e/factor-scan",
            "rev": "3f2a1b9c0d4e",                   // the rev path segment
            "gitSha": "<full 40-hex sha>",           // null when the source was not a git tree
            "dirty": false,
            "contentHash": "sha256:<64hex>",
            "snapshotAt": "2026-07-07T18:20:11Z",
            "verify": "passed"                       // 'passed' | 'warned' | 'skipped' (gate outcome at snapshot time)
          },
          "journal": null                            // or the last/in-flight transition (Task 4)
        }
      }
    }
  }
}
```

Field rules (enforce in the zod schema and in tests):
- `dev.sourcePath` is the **literal** symlink target string exactly as the link stores it;
  `resolvedPath` is its absolute resolution at record time. Demotion recreates the symlink from
  `sourcePath` verbatim — this is what makes the round trip byte-identical.
- `pinned.gitSha` is the full 40-hex SHA when the source was a git tree (clean or dirty); `null`
  for non-git sources. `dirty: true` pairs only with `rev` of the form `dirty-<hash12>`.
- `pinned.verify` accepts exactly `'passed' | 'warned' | 'skipped'`. An inconclusive-but-
  proceeded gate records `'skipped'` (the gate did not effectively run); the JSON report (Task 5)
  still says `inconclusive`.
- **Losslessness invariant (D5):** a flip updates `mode` and its own side's record; it never
  nulls the other side. `pinned` is only replaced by a newer promote; `dev` only by a newer
  adoption/`--source`.
- `updatedAt`, `recordedAt`, `snapshotAt`: `new Date().toISOString()` (injectable clock — see
  `now` below).

### Types (append to `place/types.ts`, exact)

```ts
export interface DevRecord {
  sourcePath: string;
  resolvedPath: string;
  repoRoot: string | null;
  sourceRelPath: string | null;
  remote: string | null;
  recordedAt: string;
}
export interface PinnedRecord {
  storePath: string;
  rev: string;
  gitSha: string | null;
  dirty: boolean;
  contentHash: string;   // 'sha256:<64hex>'
  snapshotAt: string;
  verify: 'passed' | 'warned' | 'skipped';
}
export interface PairRecord {
  placementPath: string;
  mode: 'dev' | 'pinned';
  dev: DevRecord | null;
  pinned: PinnedRecord | null;
  journal: Journal | null;   // Journal type lands in Task 4; declare it here now (below)
}
export type JournalPhase = 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed';
export interface Journal {
  op: FlipOp;
  txId: string;              // 8 lowercase hex chars
  phase: JournalPhase;
  startedAt: string;
  completedAt: string | null;
  before:
    | { mode: 'dev'; symlinkTarget: string }
    | { mode: 'pinned'; storePath: string | null; contentHash: string | null };
  stagingPath: string;
  backupPath: string;
}
export interface LedgerFile {
  schemaVersion: 1;
  kind: 'skillsmith.placements';
  updatedAt: string;
  skills: Record<string, { tools: Partial<Record<FlipTool, PairRecord>> }>;
}
export interface Provenance {
  kind: 'git-clean' | 'git-dirty' | 'non-git';
  repoRoot: string | null;
  sourceRelPath: string | null;
  remote: string | null;      // 'owner/repo' or null
  gitSha: string | null;      // full 40-hex
  ns: string;                 // '<owner>' | 'local'
  name: string;               // '<repo>' | '<dirname>'
  dirtySummary: string | null; // trimmed `git status --porcelain` output when dirty
}
```

### `place/ledger.ts` (exact contract)

```ts
export const emptyLedger = (now: string): LedgerFile;
export const readLedger = (env: ScanEnv, ledgerPath: string):
  Promise<Result<LedgerFile, SkillSmithError>>;
export const writeLedger = (env: ScanEnv, ledgerPath: string, ledger: LedgerFile):
  Promise<Result<void, SkillSmithError>>;
export const withLedgerLock = <T>(env: ScanEnv, ledgerPath: string, fn: () => Promise<T>):
  Promise<Result<T, SkillSmithError>>;
export const getPair = (l: LedgerFile, skill: string, tool: FlipTool): PairRecord | null;
export const setPair = (l: LedgerFile, skill: string, tool: FlipTool, rec: PairRecord): void;
```

- `readLedger`: file absent (`pathKind === 'absent'`) or empty/whitespace-only → `ok(emptyLedger)`
  (first run; the lock pre-create writes `''`). Any other content: `JSON.parse` + zod
  `LedgerSchema.parse`; either failing → `err(ledgerError(...))` — **never regenerate**.
- `writeLedger` (atomic, write-ahead capable): serialize with `JSON.stringify(ledger, null, 2)` →
  `writeTextFile(<ledgerPath>.tmp-<random8hex>)` → `fsyncFile(tmp)` → `rename(tmp, ledgerPath)` →
  `fsyncDir(dirname(ledgerPath))`. Set `updatedAt` before serializing. `EACCES`/`EPERM` anywhere
  → `permissionDeniedError`.
- `withLedgerLock`: `makeDir(dirname)`; create the ledger file with `writeFile(p, '', { flag: 'ax' })`
  semantics if absent (ignore EEXIST — proper-lockfile needs the target to exist; precedent
  `config/save.ts`); then `env.withFileLock(ledgerPath, fn)`. Lock acquisition failure after
  retries → `err(flipFailedError('another skillsmith operation is running: <detail>'))`.

### The store (`place/store.ts`, exact contract)

```ts
export const contentHashOf = (env: ScanEnv, dir: string):
  Promise<Result<string, SkillSmithError>>;          // 'sha256:<64hex>'
export const resolveProvenance = (env: ScanEnv, sourceDir: string):
  Promise<Result<Provenance, SkillSmithError>>;
export interface SnapshotResult { storePath: string; rev: string; contentHash: string; reused: boolean; }
export const snapshotToStore = (env: ScanEnv, opts: {
  sourceDir: string;         // the DEV SOURCE directory (never the placement)
  skill: string;             // leaf name under the store entry
  storeRoot: string;
  provenance: Provenance;
  txId: string;
}): Promise<Result<SnapshotResult, SkillSmithError>>;
export const sweepStaging = (env: ScanEnv, storeRoot: string): Promise<void>; // best-effort
```

**Canonical content hash (frozen algorithm — spec §6.2):** `sha256` over a canonical manifest of
the skill directory: walk recursively; for each entry in **sorted relative-path order**
(byte-wise sort of `/`-joined relpaths), one record, records joined by `\n`:
- regular file: `<relpath>\0F<exec:0|1>\0<sha256-hex-of-bytes>` (exec = owner-exec bit via
  `isExecutable`; bytes via `readBytes`)
- symlink: `<relpath>\0L\0<literal link target via readLink>`

Directories are implied by paths (no records of their own). The digest of the manifest string
(UTF-8) is the hash; render `sha256:<64hex>`. Path segments in store revs truncate to the first
12 hex. Use `node:crypto` `createHash('sha256')` (pure, allowed in core). This same function
verifies snapshot fidelity and guards the demote-time deletion (Task 4).

**Provenance resolution (all via `env.exec`, cwd-independent `-C` form):**
1. `git -C <sourceDir> rev-parse --show-toplevel` — non-zero exit → `kind: 'non-git'`,
   `ns: 'local'`, `name: basename(sourceDir)`, everything git-ish null.
2. `git -C <repoRoot> status --porcelain` — non-empty stdout → dirty (`dirtySummary` = trimmed
   stdout, first 10 lines).
3. `git -C <repoRoot> rev-parse HEAD` → full `gitSha` (validate `/^[0-9a-f]{40}$/`).
4. `git -C <repoRoot> remote get-url origin` → parse `owner/repo` from
   `git@<host>:owner/repo(.git)` or `http(s)://<host>/owner/repo(.git)`; unparseable/absent
   remote → `remote: null`, `ns: 'local'`, `name: basename(repoRoot)`; parseable →
   `ns: owner`, `name: repo`.
5. `sourceRelPath` = `relative(repoRoot, sourceDir)` (null for non-git).

Rev selection: `git-clean` → `gitSha.slice(0, 12)`; `git-dirty` → `` `dirty-${hash12}` ``;
`non-git` → `` `content-${hash12}` `` where `hash12` = first 12 hex of the content hash of the
**source dir**. Store entry path: `join(storeRoot, ns, `${name}@${rev}`, skill)`.

**Snapshot protocol (spec §6.3 — write-once, atomic; implement exactly):**
1. Compute the target store path. If it exists (`pathKind !== 'absent'`): compute its content
   hash — match with the source's → **reuse** (`reused: true`, done); mismatch → hard error
   `flipFailedError('store integrity violation: <path> exists with different content')` (a
   `@<sha12>` entry must be reproducible), maps to exit 1.
2. Stage under `join(storeRoot, '.staging', txId, skill)` (same filesystem as the store by
   construction): `makeDir` parents → `copyTree(sourceDir, staging)` → `fsyncFile` every regular
   file in the staged tree (walk it) → compute the staged tree's content hash and compare with a
   fresh hash of the source (guards concurrent edits mid-copy); mismatch → remove staging, retry
   once, then `flipFailedError` (exit 1).
3. `makeDir` the final path's parent; `rename(stagingSkillDir, finalPath)`; `fsyncDir(parent)`;
   `removeTree(join(storeRoot, '.staging', txId))`.
4. `sweepStaging`: remove every `store/.staging/<txId>` directory (crash orphans). Callers run it
   at the start of any flip batch while the ledger lock is held. Best-effort: swallow errors.

Store entries are immutable; **nothing in this module (or anywhere in P12) deletes a store
entry** (Global Constraint 5).

- [ ] **Step 1: Failing content-hash tests** (`content-hash.test.ts`, temp dirs +
  `defaultScanEnv`): (a) hash is stable across two computations; (b) reordering directory-entry
  creation order does not change it (sorted canonicalization); (c) flipping a file's exec bit
  changes it; (d) changing a symlink's target changes it; (e) a symlink is hashed as an `L`
  record — NOT followed (hash unchanged when the link target's content changes but the target
  path string doesn't… assert by hashing a dir whose relative link points outside it); (f) byte
  change in any file changes it; (g) format matches `/^sha256:[0-9a-f]{64}$/`.
- [ ] **Step 2: Failing provenance + snapshot tests** (`store.test.ts`, Task-1 fleet):
  - Provenance matrix: `alphaSrc` (clean) → `{ kind: 'git-clean', remote: 'smorinlabs/fixture-harness', ns: 'smorinlabs', name: 'fixture-harness', gitSha: f.headSha, sourceRelPath: 'plugins/fh/skills/alpha' }`;
    after `makeCheckoutDirty()` → `kind: 'git-dirty'`, `dirtySummary` contains `SKILL.md`;
    `gammaSrc` → `{ kind: 'non-git', ns: 'local', name: 'gamma', gitSha: null, repoRoot: null }`;
    remove the origin remote in a copy of the checkout (`git remote remove origin`) →
    `ns: 'local'`, `name: <checkout basename>`, `remote: null`.
  - Rev/path shapes: clean → `store/smorinlabs/fixture-harness@<sha12>/alpha`; dirty →
    `…@dirty-<hash12>/…`; non-git → `store/local/gamma@content-<hash12>/gamma` (regex-assert all
    three; `<sha12>` === `f.headSha.slice(0,12)`).
  - Snapshot: first call → `reused: false`, final path exists, `.staging` empty, staged content
    hash equals source hash, exec bit and relative symlink preserved in the store entry.
  - Idempotence: second call with unchanged source → `reused: true`, no `.staging` residue.
  - Integrity: tamper with a file inside the existing store entry, call again → `err` with code
    `flip-failed`, message contains `integrity`.
  - `sweepStaging` removes a planted orphan `store/.staging/deadbeef`.
- [ ] **Step 3: Failing ledger tests** (`ledger.test.ts` + golden):
  - `readLedger` on absent path → `emptyLedger`; on `''` → `emptyLedger`; on `{"schemaVersion":1`
    (truncated) → `err` code `ledger-error`; on valid-JSON-wrong-shape
    (`{"schemaVersion":2,...}`) → `err` code `ledger-error`.
  - Golden: commit `ledger.golden.json` as the jsonc example above **minus comments** with
    concrete values (skill `factor-scan`, tool `claude-code`, the exact field set shown).
    `readLedger` on it → `ok`; re-`writeLedger` → parse-equal round trip (compare
    `JSON.parse`, not strings).
  - `writeLedger` is atomic: after a write, no `*.tmp-*` sibling remains; content parses.
  - `withLedgerLock` creates parent dir + empty file on first use; nested read→mutate→write
    inside the lock works against the fleet's `f.data`.
  - Losslessness (D5) at the record level: `setPair` with `mode: 'pinned'` + new `pinned` on a
    pair holding a `dev` record retains `dev` untouched; the symmetric demote update retains
    `pinned`. (Write the two helpers-in-test that Task 5's run layer will mirror.)
  - Zod schema rejects `pinned.verify: 'failed'` and `mode: 'installed'` (enum locks).
- [ ] **Step 4: Implement** `store.ts`, `ledger.ts`, types. Zod schemas mirror the types
  field-for-field (`z.literal(1)`, `z.literal('skillsmith.placements')`, `z.enum` for every enum,
  `.nullable()` for nullable fields).
- [ ] **Step 5: Verify and commit.**

```bash
git add packages/core/src/place packages/core/tests/place packages/core/tests/fixtures/place/ledger.golden.json
git commit -m "feat(core): add content-addressed store and placements ledger" \
  -m "Canonical sha256 content hash (sorted manifest, exec bit, symlink records); provenance" \
  -m "resolution via git with owner-repo parse; write-once snapshot with staging + integrity" \
  -m "check; zod-validated ledger with atomic fsync'd writes and proper-lockfile locking."
```

**Automated verification:** `bun test packages/core/tests/place` · `bunx tsc --noEmit` ·
`bun run lint:boundaries`

---

## Task 4 [P12-T03] — Atomic swap state machine, `--rollback`, crash recovery (model: opus)

**Consumes:** Tasks 2–3 (`env` primitives, `ledger.ts`, `store.ts`, `place/types.ts`), Task 1's
fleet.

**Files:**
- Create: `packages/core/src/place/swap.ts`
- Modify: `packages/core/src/place/types.ts` (append swap plan/outcome types)
- Create: `packages/core/tests/place/crash-env.ts` (fault-injection wrapper — helper, not a test)
- Create: `packages/core/tests/place/swap.test.ts`,
  `packages/core/tests/place/crash-sweep.test.ts`

### Protocol facts (the whole reason this task exists — implement exactly)

- `rename(2)` is atomic only within one filesystem ⇒ staging entries are created **inside the
  skills root** (sibling of the live placement).
- POSIX `rename` cannot replace a symlink with a directory (`ENOTDIR`) nor a directory with a
  symlink (`EISDIR`/`ENOTEMPTY`) ⇒ two-rename swap with a backup name; the backup doubles as
  physical rollback material.
- Reserved names inside a skills root: staging `.skillsmith-staging-<skill>-<txId>`, backup
  `.skillsmith-backup-<skill>-<txId>`. Dot-prefixed names are invisible to placement detection
  (proven in Task 2) and to the tools' own skill discovery.

### Phases (spec §8.2 — verbatim)

Promote (symlink → pinned copy). `before` = `{ mode: "dev", symlinkTarget: <literal> }`:

```
P1 prepared    journal written (op, txId, before, stagingPath, backupPath); no fs changes yet
P2 staged      staging dir fully materialized: copyTree(store entry → .skillsmith-staging-…),
               files fsynced, content hash verified against the store entry
P3 backed-up   rename(live symlink → .skillsmith-backup-…)          ← live path now ABSENT
P4 live        rename(.skillsmith-staging-… → live path)            ← live path now the pinned copy
P5 committed   backup symlink unlinked; skills root fsyncDir'd; ledger updated
               (mode, pinned record, journal.phase=committed, completedAt)
```

Dev (pinned copy → symlink). `before` = `{ mode: "pinned", storePath, contentHash }`:

```
P1 prepared    journal written; dev source resolved
P2 staged      staging symlink created: makeSymlink(dev.sourcePath, .skillsmith-staging-…)
P3 backed-up   rename(live dir → .skillsmith-backup-…)              ← live path now ABSENT
P4 live        rename(.skillsmith-staging-… → live path)            ← live path now the symlink
P5 committed   backup dir removed iff contentHash(backup) == pinned.contentHash,
               else kept + warning; fsyncDir; ledger updated
```

**Write-ahead rule:** each journal phase transition is persisted (via `writeLedger`'s atomic
protocol) **before** the filesystem action that phase authorizes: persist `phase: "backed-up"`,
then run the P3 rename; persist `phase: "live"`, then run the P4 rename; then commit. When the
pair has `mode: 'pinned'` but `pinned` is `null` (an adopted hand-copy being demoted), P5 must
keep the backup and report a warning — the backup is the only copy of that content.

### Journal record (spec §8.3 — verbatim; lives on the pair inside placements.json)

```jsonc
"journal": {
  "op": "promote",                    // 'promote' | 'dev' | 'rollback'
  "txId": "9f4c2a17",                 // random 8-hex; suffixes staging/backup names
  "phase": "backed-up",               // 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed'
  "startedAt": "2026-07-07T18:20:10Z",
  "completedAt": null,                // set at committed
  "before": { "mode": "dev", "symlinkTarget": "/Users/alice/c/…/factor-scan" },
  "stagingPath": "/Users/alice/.claude/skills/.skillsmith-staging-factor-scan-9f4c2a17",
  "backupPath":  "/Users/alice/.claude/skills/.skillsmith-backup-factor-scan-9f4c2a17"
}
```

### Crash points and recovery (spec §8.4 — verbatim; this table IS the test oracle)

The journaled phase is a *lower bound* on progress: a crash can land after the journal write but
before (or during) the phase's filesystem action, so recovery probes the filesystem to
disambiguate — every probe is a single `pathKind` check, and every cell below is deterministic.

| Crash window | Journal says | Live path | Recovery: `--rollback` | Recovery: same-op re-run |
|---|---|---|---|---|
| C0 before P1 journal | none | old, intact | nothing to do | fresh run |
| C1 after `prepared`, during staging | `prepared` | old, intact | remove staging remnant, clear journal | rebuild staging, continue |
| C2 after `staged`, before P3 rename | `staged` | old, intact | remove staging, clear journal | continue at P3 |
| C3 after `backed-up` journal, around P3 rename | `backed-up` | **old or ABSENT** (probe) | if live still old: remove staging, clear journal; if absent: `rename(backup → live)`, remove staging, clear journal | if live still old: run P3; if absent: continue at P4 |
| C4 after `live` journal, around P4 rename | `live` | **ABSENT or new** (probe) | if absent: `rename(backup → live)`, remove staging; if new: `rename(live → staging-name)`, `rename(backup → live)`, remove staging'; clear journal | if absent: run P4; if new: continue at P5 |
| C5 after P4, before commit write | `live` | new | as C4 "new" row | complete P5 (cleanup + commit) |
| C6 committed | `committed` | new | inverse flip via retained records (a normal, fully journaled flip in the opposite direction) | no-op (already converged) |

Invariants provable from the table (assert these after EVERY injected crash):

1. **The live path is never a partial artifact.** It is always exactly one of: the old placement,
   the complete new placement, or absent — never a half-copied directory (staging is built under
   a dot-name and only ever *renamed* to live).
2. **Absence is always recoverable**: whenever the live path is absent, the backup entry exists
   (the P3 rename is atomic), so `--rollback` restores the before-state with one rename.
3. **Nothing is deleted before commit** except the staging remnant; the backup — the only copy of
   the old state's physical form — is removed only in P5, after the new live entry exists.

"Clear journal" = set the pair's `journal` to `null` and persist. Recovery runs under the ledger
lock. `fsyncDir` on the skills root follows the P3–P5 rename sequence. On macOS, plain `fsync`
(not `F_FULLFSYNC`) is deliberate — Global Constraint 12.

### Interfaces produced (exact)

Append to `place/types.ts`:

```ts
export interface SwapCtx {
  env: ScanEnv;
  ledgerPath: string;
  ledger: LedgerFile;                 // mutated in place by the engine
  persist: () => Promise<Result<void, SkillSmithError>>; // writeLedger(env, ledgerPath, ledger)
  now: () => string;                  // injectable clock (ISO string)
  newTxId: () => string;              // injectable 8-hex generator
  pauseAt?: JournalPhase | undefined; // test seam, see below
  signal?: AbortSignal | undefined;
}
export interface SwapPlan {
  op: 'promote' | 'dev';
  rollbackOf?: FlipOp;                // set when this swap implements a committed-state rollback
  skill: string;
  tool: FlipTool;
  skillsRoot: string;
  placementPath: string;              // join(skillsRoot, skill)
  // promote: the store entry to materialize; dev: the literal symlink target to restore
  promote?: { storePath: string; contentHash: string; pinned: PinnedRecord; devRecord: DevRecord };
  dev?: { sourcePath: string; devRecord: DevRecord };
}
export interface SwapOutcome {
  committed: boolean;
  backupKept: string | null;          // path of a preserved backup (hash mismatch / no pinned record)
  warning: string | null;
}
```

`packages/core/src/place/swap.ts`:

```ts
export const runSwap = (ctx: SwapCtx, plan: SwapPlan):
  Promise<Result<SwapOutcome, SkillSmithError>>;
/** Same-op re-run continuation per the table's right column. */
export const resumeSwap = (ctx: SwapCtx, skill: string, tool: FlipTool):
  Promise<Result<SwapOutcome, SkillSmithError>>;
/** Uncommitted-journal recovery per the table's --rollback column. Committed journals are NOT
 *  handled here (run layer performs the inverse flip). */
export const rollbackSwap = (ctx: SwapCtx, skill: string, tool: FlipTool):
  Promise<Result<SwapOutcome, SkillSmithError>>;
```

Engine rules:
- Refuse to start (`flipRefusedError`) when the pair already has a non-null journal with
  `phase !== 'committed'` **unless** called via `resumeSwap` with a matching `op` — Global
  Constraint 6. The error message must name both remediations (mirror
  `research/commands/promote.md`): `Run 'skillsmith <op> --rollback <skill>' to restore the
  previous state, or re-run 'skillsmith <op> <skill>' to complete the swap.`
- Ledger updates at P5 (promote): `mode: 'pinned'`, `pinned` = `plan.promote.pinned`, `dev` =
  `plan.promote.devRecord` (adoption refresh), journal committed. At P5 (dev): `mode: 'dev'`,
  `dev` = `plan.dev.devRecord`, `pinned` retained as-is, journal committed.
- SIGINT: check `ctx.signal?.aborted` immediately **before each filesystem phase action** (P2
  build, P3 rename, P4 rename, P5 cleanup); when aborted, return
  `err(flipFailedError('interrupted'))` **after** the already-persisted journal write — the pair
  is then recoverable per the table. Never abort mid-journal-write.
- Test pause seam: when `ctx.pauseAt` is set and equals the phase just persisted, `await` a 30 s
  timer **after the journal write, before the phase's filesystem action** (the C2/C3/C4 crash
  windows). The CLI (Task 5) only ever sets `pauseAt` from `SKILLSMITH_TEST_PAUSE_AT` when
  `SKILLSMITH_E2E=1`.
- Permission errors (`EACCES`/`EPERM` from any primitive) → `permissionDeniedError` (exit 6);
  other I/O errors mid-flight → `flipFailedError` (exit 1). Both leave the journal at its last
  persisted phase — recoverable.

### Interrupted-swap test design (the acceptance core — spec §15)

`packages/core/tests/place/crash-env.ts` (helper):

```ts
export class SimulatedCrash extends Error {}
/** Wraps a real ScanEnv; throws SimulatedCrash at the START of the Nth mutating call.
 *  Mutating primitives (counted, in call order): makeSymlink, rename, copyTree, removeTree,
 *  makeDir, writeTextFile. Read-only + fsync primitives pass through uncounted. */
export const crashingEnv = (inner: ScanEnv, crashAtCall: number):
  { env: ScanEnv; calls: () => number };
```

This wrapper IS the "hook/step-callback seam": every mutating filesystem step of the engine flows
through an injected primitive, so throwing at call N deterministically visits every crash window
without hand-picking phases — the ledger's own `writeTextFile` calls are counted too, so crashes
land both before and after each journal persist (C1–C5), and beyond the final write the flip
completes (C6/no-crash).

`crash-sweep.test.ts` procedure (run for **both** ops):

1. Build a fresh fleet; seed it: for the promote sweep use `alpha` (claude-code, dev placement;
   snapshot pre-created via Task 3 so the store entry exists); for the dev sweep first do one
   clean promote of `alpha`, then sweep the demote.
2. Dry-run once with a plain env to learn `totalMutations` (the `calls()` count of a successful
   run).
3. For `n = 1 .. totalMutations`: restore a pristine copy of the fleet state (cheapest: rebuild
   the placement + ledger from a saved tar-like snapshot of `<base>` via `cp -R` of a template
   dir — build once, copy per iteration), run the op with `crashingEnv(real, n)`, catch
   `SimulatedCrash`, then assert with a **plain** env:
   - **Invariant 1:** `pathKind(placementPath)` ∈ {`'symlink'` (old), `'dir'` (new for promote) /
     `'symlink'` (new for dev), `'absent'`} and when it is the new dir its content hash equals
     the store entry's (never partial — staging dirs are ignored via dot-prefix).
   - **Invariant 2:** if live is `'absent'`, `pathKind(backupPath) !== 'absent'`.
   - **Invariant 3:** the store entry still exists, byte-identical (hash check) — nothing
     deleted before commit except staging.
   - **Rollback branch:** clone the crashed state, run `rollbackSwap` — live path restored
     **byte-identically** (promote sweep: symlink again with `readLink` === original literal
     target; dev sweep: dir again with content hash === `pinned.contentHash`); journal is null;
     no `.skillsmith-*` residue remains in the skills root.
   - **Re-run branch:** on the original crashed state, run `resumeSwap` — converges to the
     committed after-state (placement correct, journal `phase: 'committed'`,
     `completedAt !== null`, no residue).
4. Assert the sweep actually exercised every journal phase at least once (collect the journaled
   `phase` seen at each n; the set must equal {none-or-prepared, staged, backed-up, live,
   committed} minus C0).

`swap.test.ts` (happy paths + edges, plain env on the fleet):
- Promote `alpha`: after `runSwap`, placement is a real dir whose content hash equals the store
  entry, backup gone, journal committed, `dev` record retained.
- Demote it back: placement is a symlink whose `readLink` equals the original literal target
  **verbatim**; old copy deleted (hash matched); `pinned` record retained.
- Demote when the pinned copy was **edited in place** (touch a file first): `backupKept` is the
  backup path, the backup dir exists, `warning` non-null — and the placement still flipped.
- Demote of an adopted hand-copy (pair with `pinned: null`): backup always kept + warning.
- `runSwap` on a pair with an uncommitted journal → `err` code `flip-refused`, message contains
  both `--rollback` and `re-run`.
- `rollbackSwap` on a pair with **no** journal → `err` code `flip-refused` (`nothing to roll back`).
- Abort: pre-aborted `signal` → `err` code `flip-failed`, journal left at its last phase,
  `resumeSwap` completes it.

- [ ] **Step 1:** Write `swap.test.ts` failing cases (engine API stubs may return
  `err(flipFailedError('todo'))` to compile).
- [ ] **Step 2:** Implement `swap.ts` (phases, write-ahead journal, recovery probes per table).
- [ ] **Step 3:** Write `crash-env.ts` + `crash-sweep.test.ts`; run the sweep; fix every
  violation the sweep finds (this is where the table earns its keep).
- [ ] **Step 4: Verify and commit.**

```bash
git add packages/core/src/place packages/core/tests/place
git commit -m "feat(core): add journaled atomic swap engine with rollback and crash recovery" \
  -m "Two-rename swap with write-ahead journal in the ledger; deterministic recovery per the" \
  -m "crash-point table (probe-based); rollback + same-op resume; exhaustive fault-injection" \
  -m "sweep over every mutating fs call proves the never-partial/always-recoverable invariants."
```

**Automated verification:** `bun test packages/core/tests/place` · `bunx tsc --noEmit` ·
`bun run lint:boundaries`

---

## Task 5 [P12-T04] — Planning, run layer, verify gate, CLI commands (model: sonnet)

**Consumes:** everything from Tasks 2–4; `verifyPlugin`, `VerifyReport` from `verify/`
(core-internal import `../verify/run.ts`); CLI patterns from `commands/verify.ts`.

**Files:**
- Create: `packages/core/src/place/plan.ts`, `packages/core/src/place/run.ts`
- Modify: `packages/core/src/place/types.ts` (append report/option types),
  `packages/core/src/index.ts`, `packages/core/src/public-types.ts`,
  `packages/core/tests/public-api.test.ts`
- Create: `packages/cli/src/commands/promote.ts`, `packages/cli/src/commands/dev.ts`,
  `packages/cli/src/output/flip-human.ts`, `packages/cli/src/output/flip-json.ts`,
  `packages/cli/src/util/flip-exit.ts`
- Modify: `packages/cli/src/program.ts` (register both), `packages/cli/src/help/topics.ts`
  (exit-codes topic gains 3/5/6)
- Create: `packages/core/tests/place/plan.test.ts`, `packages/core/tests/place/run.test.ts`,
  `packages/cli/tests/commands/promote.test.ts`, `packages/cli/tests/commands/dev.test.ts`,
  `packages/cli/tests/output/flip-json.test.ts`, `packages/cli/tests/output/flip-human.test.ts`,
  `packages/cli/tests/util/flip-exit.test.ts`,
  `packages/cli/tests/fixtures/flip-report.golden.json`

### CLI surface (frozen — from `research/commands/promote.md` / `dev.md`)

```
skillsmith promote [<skill>...] [--all] [--tool claude-code|codex]...
                   [--strict] [--no-verify] [--allow-dirty]
                   [--rollback] [--dry-run] [--json]

skillsmith dev     [<skill>...] [--all] [--tool claude-code|codex]...
                   [--source <path>] [--rollback] [--dry-run] [--json]
skillsmith demote  …            # built-in alias of dev (commander .alias('demote'))
```

Usage rules (all exit 2, enforced in the CLI action before touching core):
- at least one positional unless `--all`; `--all` + positionals → error;
- `--tool` values restricted to `claude-code|codex` via `.choices()` + a `collectTool` argParser
  (copy the pattern and the local `exitOverride` mapping from `commands/verify.ts` — commands
  attached via `addCommand` do not inherit the program's exitOverride);
- `--rollback` combines with nothing operational: with `--source`, `--no-verify`,
  `--allow-dirty`, or `--strict` → error;
- `--source` only on `dev`, only with exactly one positional target;
- `--no-prompt` / `--yes` are accepted no-ops (neither command ever prompts).
- The completion declaration-gate test requires `.choices()` on any option whose description
  contains a pipe-separated enum — keep it on `--tool`.

### Core types (append to `place/types.ts`, exact — the JSON contract mirrors these)

```ts
export type FlipAction =
  | 'flipped' | 'updated' | 'noop' | 'skipped' | 'refused' | 'failed' | 'rolled-back';
export interface FlipResult {
  skill: string;
  tool: FlipTool | null;             // null only for a target that matched no tool at all
  placementPath: string | null;
  action: FlipAction;
  reason: string | null;             // human cause for skipped/refused/failed
  before: { mode: 'dev' | 'pinned'; symlinkTarget?: string; storePath?: string | null } | null;
  after:  { mode: 'dev' | 'pinned'; symlinkTarget?: string; storePath?: string | null } | null;
  store: { path: string; rev: string; gitSha: string | null; dirty: boolean; reused: boolean } | null;
  verify: {
    gate: 'passed' | 'warned' | 'failed' | 'skipped' | 'inconclusive';
    verdict: 'pass' | 'warn' | 'fail' | 'inconclusive' | null;
  } | null;                          // null for dev/rollback pairs
  error?: SkillSmithError;           // CORE-ONLY: drives the CLI exit code; NOT rendered in JSON
}
export interface FlipReport {
  op: FlipOp;
  dryRun: boolean;
  requested: { targets: string[]; all: boolean; tools: FlipTool[]; explicitTools: boolean };
  results: FlipResult[];
  summary: { flipped: number; updated: number; noop: number; skipped: number;
             refused: number; failed: number; rolledBack: number };
}
export interface FlipOptions {
  targets: readonly string[];
  all?: boolean;
  tools?: readonly FlipTool[];       // explicit --tool list; undefined = auto
  source?: string;                   // dev only
  strict?: boolean;                  // promote only
  noVerify?: boolean;                // promote only
  allowDirty?: boolean;              // promote only
  rollback?: boolean;
  dryRun?: boolean;
  cwd: string;
  envVars: Record<string, string | undefined>;
  testPauseAt?: JournalPhase;        // wired only by the CLI under SKILLSMITH_E2E=1
  signal?: AbortSignal;
}
export interface FlipDeps {
  verify: typeof import('../verify/run.ts').verifyPlugin;  // injectable for tests
  now: () => string;
  newTxId: () => string;
}
```

### `place/plan.ts` — target & tool resolution (spec §5/D2/D3; exact rules)

```ts
export interface PairPlan {
  skill: string; tool: FlipTool; placement: Placement;
  notices: string[];                 // e.g. legacy-root info
}
export interface FlipPlanOutcome {
  pairs: PairPlan[];                 // eligible, in (target-order × tool-order) sequence
  preResults: FlipResult[];          // already-decided results (refusals, skips, not-found)
}
export const planFlips = (env: ScanEnv, opts: FlipOptions, storeRoot: string):
  Promise<Result<FlipPlanOutcome, SkillSmithError>>;
```

- A target containing a path separator, or starting `./` or `../`, or absolute, is a **path**
  target: `lstat` it; the owning tool = the tool whose user-scope skills root contains it
  (claude-code root, codex current, codex legacy); outside every root →
  `err(flipRefusedError(...))` (exit 2). Otherwise it is a **name** matched against the leaf
  entries of every selected tool's root(s) and against ledger keys.
- Tool set per target: default = every tool where the target's placement class is flippable
  (`dev` for promote — dangling included; `pinned` for dev). `--tool` restricts AND requires: an
  explicitly named tool with nothing flippable there → preResult
  `{ action: 'refused', error: placementNotFoundError(...) }` (exit 4) whose reason names what
  WAS found (`absent`, `store-linked`, …). A name matching nothing flippable anywhere → same,
  with the searched roots listed.
- `--all`: promote → every `dev` placement in the selected tools; dev → every `pinned` placement
  **with a recorded dev source** (ledger `dev.sourcePath`); pinned-without-source under `--all` →
  preResult `{ action: 'skipped', reason: 'no recorded dev source' }` (exit 0).
- Codex dual root (policy data from `agents/codex/placement.ts`): a skill present in **both**
  roots → the codex pair becomes preResult
  `{ action: 'refused', reason: 'found in both <current> and <legacy>; resolve the duplicate first', error: flipRefusedError(...) }`
  (exit 2); other tools' pairs for the same skill proceed. Found only in the legacy root → flip
  in place there, with notice
  `codex placement is in the legacy ~/.codex/skills; the current convention is ~/.agents/skills — a future 'skillsmith install' can migrate it`.
  Never migrate between roots.
- `store-linked` placements are never flippable (managed by `install`; cannot occur before P09).

### `place/run.ts` — the verbs (exact contract)

```ts
export const defaultFlipDeps: FlipDeps; // { verify: verifyPlugin, now: () => new Date().toISOString(), newTxId: <random 8-hex> }
export const runPromote = (env: ScanEnv, opts: FlipOptions, deps?: FlipDeps):
  Promise<Result<FlipReport, SkillSmithError>>;
export const runDev = (env: ScanEnv, opts: FlipOptions, deps?: FlipDeps):
  Promise<Result<FlipReport, SkillSmithError>>;
export const runRollback = (env: ScanEnv, opts: FlipOptions & { op: 'promote' | 'dev' }, deps?: FlipDeps):
  Promise<Result<FlipReport, SkillSmithError>>;   // both CLIs' --rollback lands here
```

Flow (promote, per (skill, tool) pair — spec §4.1; all pairs run **sequentially**, each pair is
its own transaction, a failure never stops the batch; batch is wrapped in ONE
`withLedgerLock(...)` unless `dryRun` — dry-run takes **no lock** and writes nothing):

1. `sweepStaging` once per batch (under the lock).
2. Pair has an uncommitted journal → if `opts` is a same-op re-run: `resumeSwap`; else result
   `refused` + `flipRefusedError` naming `--rollback` / re-run (exit 2).
3. Placement `dev` + dangling → result `refused` + `sourceUnresolvableError` printing the dead
   target (exit 5).
4. Already `pinned`: with a recorded `dev` source, resolve provenance — store rev unchanged →
   `noop`; moved → **re-pin** (full steps 5–8, action `updated`). Pinned with NO dev record →
   `noop` with reason `already pinned; no dev source recorded` (convergent — it already IS
   production).
5. Symlink target must contain `SKILL.md` (else `refused`/`flipRefusedError`, exit 2 — "target
   of the dev symlink is not a skill directory"). Build the `DevRecord` from the **live literal
   symlink target** (adoption: works with zero prior SkillSmith state).
6. **Verify gate** (skip when `noVerify`; then `verify.gate = 'skipped'`, ledger
   `verify: 'skipped'`): call `deps.verify(env, { path: <resolved dev source>, tools: [tool], deep: tool === 'codex', strict: opts.strict })`.
   - claude-code → static only (Claude static covers manifest + skills — the whole gate);
   - codex → `deep: true` (codex static is manifest-only; deep is the only skill-validating
     surface, auth-free/model-free).
   Blocking rule per tool verdict: `fail` → result **`failed`** + `flipFailedError` (exit 1 —
   Global Constraint 8), findings summarized in `reason`; `warn` → proceed recording
   `verify: 'warned'` unless `--strict` (then `failed`, exit 1); `inconclusive` → proceed with a
   warning notice + ledger `'skipped'` + JSON gate `'inconclusive'`, or block under `--strict`
   (action `failed`, exit 1). The gate runs before any journal write — a blocked flip touches
   nothing.
7. Provenance (Task 3): dirty tree without `--allow-dirty` → result `refused` +
   `flipRefusedError` with the porcelain summary (exit 2). With `--allow-dirty` → proceed under
   `dirty-<hash12>` + warning. Non-git → proceed under `content-<hash12>` + notice.
8. `snapshotToStore` → `runSwap` (promote plan) → result `flipped`/`updated` with `before`/
   `after`/`store`/`verify` filled per the JSON contract below.

Flow (dev, per pair — spec §4.2): placement must be `pinned` (already `dev` → `noop`, even when
dangling). Resolve source: ledger `dev.sourcePath` → else `opts.source` → else result `refused` +
`flipRefusedError('no recorded dev source; pass --source <path>')` (exit 2). `--source` must
exist and contain `SKILL.md` (else exit 2); when both exist and disagree, `--source` wins and the
dev record is updated. Recorded `dev.sourcePath` that no longer resolves on disk → `refused` +
`sourceUnresolvableError` (exit 5). Then `runSwap` (dev plan); `backupKept` from the outcome
becomes a warning in `reason`. Ledger: `mode: 'dev'`, `dev` updated, `pinned` + store entry
retained.

Flow (rollback, per pair — D10, direction-agnostic): uncommitted journal → `rollbackSwap`
(action `rolled-back`). Committed (or null) journal → the **inverse flip from retained records**,
with `rollbackOf` set and NO verify gate and NO new snapshot: last op promote → restore the dev
symlink from the retained `dev.sourcePath`; last op dev → re-materialize the pinned copy from the
retained `pinned.storePath` (store entry must still exist — it always does, P12 never deletes).
No journal AND no opposite record → `refused` + `flipRefusedError('nothing to roll back')`
(exit 2).

Dry-run: run `planFlips` + read-only resolution (placement classes, source checks, provenance
incl. dirty detection); predict each pair's action; no verify, no lock, no journal, no store
writes; `dryRun: true` in the report.

SIGINT: between pairs check `opts.signal?.aborted` and stop (remaining pairs get action
`skipped`, reason `interrupted`); within a pair the swap engine handles it (Task 4). Ledger-read
failure aborts the whole run: `err(ledgerError(...))` (exit 3).

### JSON contract (`--json` — spec §11 verbatim; one schema for both commands and `--rollback`)

```jsonc
{
  "schemaVersion": 1,
  "kind": "skillsmith.flip",
  "op": "promote",                       // 'promote' | 'dev' | 'rollback'
  "dryRun": false,
  "requested": { "targets": ["factor-scan"], "all": false, "tools": ["claude-code", "codex"], "explicitTools": false },
  "results": [
    {
      "skill": "factor-scan",
      "tool": "claude-code",
      "placementPath": "/Users/alice/.claude/skills/factor-scan",
      "action": "flipped",               // 'flipped' | 'updated' | 'noop' | 'skipped' | 'refused' | 'failed' | 'rolled-back'
      "reason": null,
      "before": { "mode": "dev", "symlinkTarget": "/Users/alice/c/…/factor-scan" },
      "after":  { "mode": "pinned", "storePath": "…/store/smorinlabs/smorinlabs-harness@3f2a1b9c0d4e/factor-scan" },
      "store":  { "path": "…", "rev": "3f2a1b9c0d4e", "gitSha": "…40hex", "dirty": false, "reused": false },
      "verify": { "gate": "passed", "verdict": "pass" }
    },
    {
      "skill": "factor-scan",
      "tool": "codex",
      "placementPath": "/Users/alice/.codex/skills/factor-scan",
      "action": "refused",
      "reason": "found in both ~/.agents/skills and ~/.codex/skills; resolve the duplicate first",
      "before": null, "after": null, "store": null, "verify": null
    }
  ],
  "summary": { "flipped": 1, "updated": 0, "noop": 0, "skipped": 0, "refused": 1, "failed": 0, "rolledBack": 0 }
}
```

Renderer (`flip-json.ts`, pattern of `verify-json.ts`): zod `FlipJsonSchema` mirroring the fields
above (`z.literal(1)`, `z.literal('skillsmith.flip')`, enums locked, `tool`/`placementPath`/
`reason`/`before`/`after`/`store`/`verify` nullable); `renderFlipJson(report)` builds the payload
by adding `schemaVersion: 1` and `kind: 'skillsmith.flip'` and dropping the core-only `error`
field, `parse`s it, then `JSON.stringify(payload, null, 2)`.

### Exit codes (`util/flip-exit.ts`)

```ts
export const flipExitCode = (report: FlipReport): number =>
  report.results.reduce((mx, r) => Math.max(mx, r.error ? exitCodeForError(r.error) : 0), 0);
```

Batch = highest per-pair code (Global Constraint 8). A core-level `err` from
`runPromote`/`runDev`/`runRollback` maps through `exitCodeForError` directly (ledger-error → 3,
etc.). Usage errors exit 2 in the CLI before core runs. Exit 130: the command follows the
`verify.ts` pattern — `process.exit(signal?.aborted ? 130 : code)`.

### Human output (`flip-human.ts` — match the mockups in `research/commands/{promote,dev}.md`)

`renderFlipHuman(report, exitCode)`: header
`Promoting <skill>  (tools: <t1, t2>)` / `Flipping <skill> to dev mode  (tools: …)` per skill;
per pair an indented block: `<tool>  <placementPath>` then lines for `note`/`verify`/`snapshot`
(`<ns>/<name>@<rev>  (new store entry)` or `(reused)`)/`source`/`swap` ending in the action
word right-aligned; summary line `` `${n} flipped.  Exit code: ${exitCode}` `` (count each action
bucket that is non-zero, e.g. `1 flipped, 1 warning.`). Refusal/error detail blocks go to
**stderr** in the command (not the renderer), mirroring the mockups' `error:`/`warning:` blocks.

### CLI actions

Both commands: parse flags → validate combinations (exit 2) → `env = await defaultScanEnv()` →
build `FlipOptions` with `cwd: process.cwd()`, `envVars: process.env`,
`testPauseAt: process.env.SKILLSMITH_E2E === '1' && isJournalPhase(process.env.SKILLSMITH_TEST_PAUSE_AT) ? … : undefined`
→ call `runRollback` when `--rollback` else `runPromote`/`runDev` → on `err`: stderr message +
`process.exit(signal?.aborted ? 130 : exitCodeForError(e))` → on `ok`: write stderr blocks for
refused/failed pairs, stdout `renderFlipJson`/`renderFlipHuman`, exit
`signal?.aborted ? 130 : flipExitCode(report)`. Register in `program.ts` after
`verifyCommand(signal)`: `program.addCommand(promoteCommand(signal)); program.addCommand(devCommand(signal));`.
`devCommand` carries `.alias('demote')` and help text noting the alias. Add `--help` EXAMPLES/
EXIT CODES sections with `.addHelpText('after', …)` copying the help mockups from the research
pages. Update the `exit-codes` help topic to:
`0 success · 1 failure (verify gate / flip failed) · 2 usage or refusal · 3 config/ledger unreadable · 4 no placement/tool · 5 dev source unresolvable · 6 permission · 130 SIGINT`.

### Public API (core `index.ts` / `public-types.ts` / `public-api.test.ts`)

Runtime exports: `runPromote`, `runDev`, `runRollback`, `defaultFlipDeps`, `FLIP_TOOLS`. Type
exports: `FlipTool`, `FlipOp`, `FlipAction`, `FlipResult`, `FlipReport`, `FlipOptions`,
`FlipDeps`, `Placement`, `PlacementClass`, `JournalPhase`, `PathKind`. Add the runtime names to
the public-api test's expected set. Detection/store/swap/ledger internals stay unexported (core
tests import them relatively).

- [ ] **Step 1 (tests first): plan tests** (`plan.test.ts`, fleet): name vs path targets; owning-
  tool inference for a path target; path outside every root → err `flip-refused`; default tool
  set (promote `alpha` → claude-code only; a skill dev in two tools → both); explicit `--tool`
  absent → preResult refused + `placement-not-found`; `--all` promote set; `--all` dev
  skip-without-source; codex duplicate → refused preResult with both paths in reason; legacy-only
  → notice string present; store-linked not flippable.
- [ ] **Step 2 (tests first): run tests** (`run.test.ts`, fleet, injected deps): canned verify
  checker matrix {pass, warn, fail, inconclusive} × {default, `--strict`, `--no-verify`} →
  block/proceed per the gate table; asserts codex gate called with `deep: true` and claude with
  no `deep` (capture `deps.verify` args); promote happy path (action `flipped`, ledger
  `mode: 'pinned'`, dev retained, `verify: 'passed'`); re-pin after source moves (new commit in
  the fixture repo → action `updated`, new rev); noop when unchanged; dirty refusal + `--allow-dirty`
  path (`rev` matches `/^dirty-[0-9a-f]{12}$/`, `gitSha` still recorded, `dirty: true`); non-git
  gamma promote (`local/gamma@content-…`); dev happy path (literal symlink restored, pinned
  retained); dev `--source` adoption of the hand-copied `copied` dir; `--source` disagree →
  record updated; missing recorded source → exit-5-class error on the pair; rollback of a
  committed promote → placement is the dev symlink again (action `rolled-back`); rollback with
  nothing to roll back → refused; dry-run writes nothing (ledger absent afterwards) and takes no
  lock.
- [ ] **Step 3 (tests first): CLI tests** — `flip-exit.test.ts` (report literals → 0/1/2/3/4/5/6
  max rule); `flip-json.test.ts` (golden `flip-report.golden.json` = the contract example above
  with concrete values; parse-compare; schema locks: `action: 'installed'` rejected,
  `kind !== 'skillsmith.flip'` rejected; core-only `error` field never appears in output);
  `flip-human.test.ts` (substring asserts per the mockups: `snapshot smorinlabs/…@… (reused)`,
  `swap`, `pin retained:`, summary `N flipped.  Exit code: 0`); `promote.test.ts`/`dev.test.ts`
  (flag validation exits: `--all`+positional, `--rollback --no-verify`, `--source` with 2
  targets, bad `--tool`; `demote` alias resolves to the dev command).
- [ ] **Step 4: Implement** `plan.ts`, `run.ts`, both commands, renderers, `flip-exit.ts`,
  exports, help topic.
- [ ] **Step 5: Smoke** the built surface:
  `bun run dev promote --help` and `bun run dev dev --help` match the research help mockups;
  `bun run dev promote x --all` → exit 2; `bun run dev promote no-such-skill` → exit 4 message
  listing searched roots; `bun run dev dev --rollback --source /tmp x` → exit 2.
- [ ] **Step 6: Verify and commit.**

```bash
git add -A packages/core packages/cli
git commit -m "feat(cli): add skillsmith promote and dev commands" \
  -m "Target/tool planning with codex dual-root policy, per-pair transactions, verify gate" \
  -m "(claude static / codex deep) with strict and no-verify modes, convergent idempotence," \
  -m "direction-agnostic rollback, versioned skillsmith.flip JSON, exit codes 0-6/130."
```

**Automated verification:** `bun test packages/core packages/cli` · `bunx tsc --noEmit` ·
`bun run lint:boundaries` · `bun run check`

---

## Task 6 [P12-TS02] — Round-trip e2e + exit-code table + interrupted-swap process e2e (model: sonnet)

**Consumes:** everything shipped in Tasks 1–5. **No external tool CLIs are required**: every
verify gate in this task is an injected canned checker (`deps.verify`), and the process-level
case runs SkillSmith's own CLI with `--no-verify`.

**Files:**
- Create: `packages/core/tests/place/roundtrip.test.ts`
- Create: `packages/cli/tests/commands/flip-exit-codes.test.ts`
- Create: `packages/cli/tests/commands/flip-live.test.ts` (env-gated)

**Canned checkers** (inline in the test, the P11 fake-checker pattern): `gatePass`, `gateWarn`,
`gateFail`, `gateInconclusive` — each a `FlipDeps['verify']` returning a minimal `VerifyReport`
literal with the corresponding `summary.verdict`; a capturing wrapper records `(path, tools, deep)`
per call.

- [ ] **Step 1: Round-trip suite** (`roundtrip.test.ts`, fresh fleet per test, injected
  `gatePass` unless stated):
  - **Losslessness (the acceptance):** `alpha` starts in dev mode. Capture the original
    `readlink` of `home/.claude/skills/alpha`; run `runPromote` → assert the placement is a
    pinned real dir; run `runDev` → assert: the final `readLink` equals the original literal
    target **byte-identically**;
    ledger has BOTH `dev` and `pinned` records; the store entry still exists on disk with a
    matching content hash. Then `promote alpha` again → `store.reused === true` and action
    `flipped` with the same rev (HEAD unchanged).
  - **Adoption of an unmanaged symlink:** the first promote ran with **zero prior ledger** — the
    dev record's `sourcePath` was derived from the live link; assert
    `dev.sourcePath === f.alphaSrc` and `remote === 'smorinlabs/fixture-harness'`.
  - **Adoption of a hand-copied dir:** `runDev` on `copied` with no `--source` → refused (reason
    names `--source`); with `source: <new checkout dir containing SKILL.md>` → flipped, symlink
    to it verbatim; the replaced copy is **preserved** under a `.skillsmith-backup-*` name (no
    pinned record existed) and the result carries the warning.
  - **Dirty-git refusal:** `makeCheckoutDirty()` → promote `alpha` → action `refused`, reason
    contains the porcelain line; with `allowDirty: true` → `flipped`, rev `dirty-<hash12>`,
    ledger `dirty: true` + full `gitSha`; round-trip back to dev still byte-identical.
  - **Non-git content-hash path:** promote `gamma` (codex legacy root; gate = canned, captures
    `deep: true`) → store path matches `store/local/gamma@content-[0-9a-f]{12}/gamma`; demote
    restores the literal link.
  - **Duplicate-skill refusal:** promote `dup` → the codex pair is `refused` (reason names both
    roots), exit contribution 2; no journal was written for it (ledger pair absent or
    journal-null); other targets in the same batch still flip.
  - **Gate matrix at e2e level:** promote `alpha` with `gateFail` → action `failed`, placement
    untouched (still the symlink), ledger unchanged; `gateWarn` + `strict` → `failed`;
    `gateWarn` default → `flipped` with ledger `verify: 'warned'`; `gateInconclusive` default →
    `flipped` with ledger `verify: 'skipped'` and JSON `gate: 'inconclusive'`; `noVerify` →
    checker never called, ledger `verify: 'skipped'`.
  - Codex legacy-only flip (`legacy-only`): flips **in place** in the legacy root, notice
    present; nothing created under `~/.agents/skills`.
- [ ] **Step 2: Exit-code table test** (`flip-exit-codes.test.ts`, driving `runPromote`/`runDev`
  on a fleet + `flipExitCode`; one row per §12 case):

  | Case (setup → op) | Expected exit |
  |---|---|
  | already-dev `dev alpha` (noop) | 0 |
  | clean `promote alpha` (flipped) | 0 |
  | dirty tree, no `--allow-dirty` (refused) | 2 |
  | `gateFail` promote (failed) | 1 |
  | `promote alpha --tool codex` (named tool, nothing flippable) | 4 |
  | `promote dangler` (dangling source) | 5 |
  | pair with planted uncommitted journal, `promote` without rollback | 2 |
  | ledger file containing `{"schemaVersion":` (corrupt) → any op | 3 |
  | mixed batch: one flipped + one refused-dirty | 2 (max rule) |

  Plant the uncommitted journal by writing a valid ledger whose pair has
  `journal.phase: "backed-up"` (build via Task 3's types). The corrupt-ledger case asserts the
  core `err` maps through `exitCodeForError` to 3.
- [ ] **Step 3: Env-gated interrupted-swap process e2e** (`flip-live.test.ts`) — the one case
  worth running against a real process, because it proves the journal survives **real process
  death**, not simulated throws. Gate: `describe.skipIf(process.env.SKILLSMITH_E2E !== '1')`
  (CI never sets it; suite reports skipped and `bun run check` stays green). Per-test timeout
  120 000 ms:
  1. Build a fleet on disk. Spawn
     `Bun.spawn(['bun', 'packages/cli/src/index.ts', 'promote', 'alpha', '--no-verify'], { cwd: <repo root>, env: { ...process.env, HOME: f.home, SKILLSMITH_HOME: f.data, SKILLSMITH_E2E: '1', SKILLSMITH_TEST_PAUSE_AT: 'backed-up' } })`.
     (`--no-verify` keeps the run free of any claude/codex dependency. `HOME` override steers
     `defaultScanEnv().homeDir` — verify via `os.homedir()` honoring `$HOME` on POSIX.)
  2. Poll `f.data/placements.json` (100 ms interval) until the pair's `journal.phase` is
     `backed-up`, then `proc.kill('SIGKILL')` (always `kill` + await exit in `finally`).
  3. Assert the crashed on-disk state: live path absent or old; backup present when absent;
     store entry intact.
  4. Run `… promote --rollback alpha` the same way (no pause var) → exit 0; `readLink` of the
     placement equals the original literal target; journal null; no `.skillsmith-*` residue.
  5. Second case: same crash, then a **same-op re-run** (`promote alpha --no-verify`) → exit 0,
     placement is the pinned copy, journal committed.
  6. Confirm CI-mode skip: run the file without `SKILLSMITH_E2E` → suite skipped, exit 0.
- [ ] **Step 4: Run everything locally** — `bun run check` green;
  `SKILLSMITH_E2E=1 bun test packages/cli/tests/commands/flip-live.test.ts` green (paste output
  as the task's acceptance evidence).
- [ ] **Step 5: Commit.**

```bash
git add packages/core/tests/place/roundtrip.test.ts packages/cli/tests/commands/flip-exit-codes.test.ts packages/cli/tests/commands/flip-live.test.ts
git commit -m "test: add P12 round-trip e2e, exit-code table, and SIGKILL swap recovery e2e" \
  -m "dev->promote->dev byte-identical on the fixture fleet with mocked verify gates; adoption," \
  -m "dirty/non-git, codex dual-root refusal; exit codes 0-5 table; env-gated real-process" \
  -m "SIGKILL at a journal phase barrier proving rollback and re-run recovery."
```

**Automated verification:** `bun run check` (live suite skips) · locally
`SKILLSMITH_E2E=1 bun test packages/cli/tests/commands/flip-live.test.ts`

---

## Integration verification (whole-branch, before P12-RV)

1. `bun run check` — biome, eslint boundaries (incl. the four new `place/` zones), tsc,
   actionlint, full `bun test` green with the live suite skipped.
2. `SKILLSMITH_E2E=1 bun test packages/cli/tests/commands/flip-live.test.ts` — green on a
   workstation; no auth, no external CLIs.
3. Manual smoke against a **scratch** `$HOME`-shaped tree (never the real one): create a temp
   home + checkout mirroring the fleet, then
   `HOME=<tmp> SKILLSMITH_HOME=<tmp>/data bun run dev promote alpha --no-verify` → human output
   matches the promote mockup shape, exit 0; `… dev alpha` → symlink restored, `pin retained:`
   line present; `… promote alpha --dry-run --json | bun -e '...'` parses with
   `kind === 'skillsmith.flip'`, `dryRun: true`.
4. With real `claude` installed (optional, worth one run): promote a scratch skill **without**
   `--no-verify` and see `verify   static: pass` in the human output — the only live-CLI touch
   point in P12, and it is not required for any committed test.
5. `bun run dev promote --help` / `bun run dev dev --help` match
   `research/commands/promote.md` / `dev.md`; `skillsmith demote --help` shows the alias.
6. Confirm nothing in the diff edits release-please-managed files, and `git log` shows every
   commit scope ∈ {core, cli, none}.
7. PR: squash-merge with title `feat(cli): add skillsmith promote and dev placement flip commands`
   (the commit release-please parses → v0.5.0).

## Out of scope (do not build these)

- **No remote fetch of any kind**: no cloning, no `owner/repo` shorthand for `dev --source`
  (adjudicated: local path only), no install write-path — all P09.
- **No P09 source resolver** and no speculative journal-reuse hooks for P09 `install`
  (adjudicated: deferred; the journal stays self-contained).
- **No marketplace/registry/publishing** — promotion is local placement state.
- No store garbage collection or reference counting (→ P09).
- No new placements: `promote`/`dev` flip what exists; they never install.
- No project- or system-scope flips; no `--scope` flag (user scope only).
- No codex root migration between `~/.codex/skills` and `~/.agents/skills` (placement creation
  policy → P09).
- No kilo-code / opencode support (no verify gate exists; their agent slots keep stubs).
- No cross-tool transactional flips (per-tool by design).
- No `--timeout` flag; verify-gate timeouts follow P11's constants.
- No `SKILLSMITH_TOOL` env-var wiring for `--tool` (listed in the research flag tables; sibling
  commands don't wire it either — same deferral as P11).
- No `F_FULLFSYNC`/power-loss hardening beyond the specified fsync points (Global Constraint 12).
