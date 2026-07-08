# SkillSmith P09 Implementation Plan — `skillsmith install` / `skillsmith uninstall`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Each task below is self-contained and dispatchable to a
> fresh implementer subagent that has **not** read the design spec — every schema, grammar, phase
> order, and recovery rule an implementer needs is copied inline.

**Goal:** Ship `skillsmith install <source>[@<ref>]…` (alias `i`) and
`skillsmith uninstall <skill>…` (aliases `rm`, `remove`) — v0.6.0. Install fetches a skill from a
git host via a blobless partial clone, resolves it (by name, explicit `//path`, or whole-repo
scan), runs the verify gate (static default; opt-in `--deep` = codex static+deep) on the fetched
skill, pins it into the existing content-addressed store at `<owner>/<repo>@<sha12>`, places it
per (tool, scope) as a store symlink (default) or plain copy (`--direct`), and records acquisition
provenance in the placements ledger. Uninstall removes placements + ledger pairs; store entries
are immortal (no GC in v1). Both verbs reuse P12's journaled atomic swap for crash safety.

**Architecture:** A new top-level core orchestrator `packages/core/src/acquire/` sits **above**
`place/` (the topmost zone: it may import `env/`, `detect/`, `agents/`, `verify/`, `place/`;
nothing imports it back). The source grammar (`acquire/source.ts`) is a pure function; the fetch
pipeline (`acquire/fetch.ts`) runs git only via `env.exec`; `acquire/run.ts` owns the batch loop,
the single invocation-wide ledger lock, the verify gate, snapshots, and the swaps. `place/` is
amended additively: the ledger gains optional `origin` / `pinned.placement` / `projects` fields,
the journal gains ops `'install' | 'uninstall'`, a `{ mode: 'absent' }` before-variant, and
optional `before.liveKind`; the swap engine gains acquisition ops while staying
behavior-preserving for P12's promote/dev/rollback. The CLI
(`packages/cli/src/commands/{install,uninstall}.ts`) owns flags, the `@clack/prompts` ambiguity
picker, exit codes, and rendering (`output/install-human.ts`, `output/install-json.ts`). No new
per-agent files: install hints come from `agents/<tool>/install-hint.ts`, roots from
`agents/<tool>/skill-roots.ts`, classes from `agents/<tool>/placement.ts`.

**Tech stack:** Bun ≥ 1.3.14 workspace; TypeScript; `bun:test`; `zod` (both packages);
`proper-lockfile` (core, existing). One dependency wiring step: `@clack/prompts` is added to
`packages/cli` in Task 9 — it is on the approved v1 stack (`research/skillsmith-v1-stack-summary.md`
lists it in the 9-package runtime set) and already CLI-permitted / core-forbidden in
`eslint.config.js`; it simply was never needed before the picker. No other dependency changes.

**Spec:** `docs/superpowers/specs/2026-07-07-p09-install-design.md` (design-gate adjudicated,
incl. the `--deep` amendment). **PRD:** `docs/superpowers/specs/2026-07-07-p09-install-prd.md`.
**Command surface (normative for renderers/help):** `research/commands/install.md`,
`research/commands/uninstall.md` (already reconciled to the spec).
**Prerequisite:** v0.5.0 (P12) shipped — store/ledger/swap in `packages/core/src/place/`, verify
(P11) in `packages/core/src/verify/`.
**Branch:** `p09-install`, squash-merge PR at the end.
**Suggested PR title (becomes the release commit):**
`feat(cli): add skillsmith install and uninstall acquisition commands`

**Plan shape:** 10 tasks (top of the 7–10 band). Deviation rationale: the D9 store-linked flip
amendment (Task 6) and the uninstall orchestrator (Task 8) each change different subsystems with
different risk profiles and deserve independent dispatch + review; folding either into a
neighboring opus task would create >400-line diffs that are hard to review honestly.

**In-plan spec resolutions** (P12-PL precedent — one line each; the plan text below already
reflects them):

1. Spec §15 lists "clamp/sanitize helpers (shared w/ store.ts)" under `acquire/source.ts` while
   §7.2 places `clampStoreNs` in `place/store.ts` — resolved: `clampStoreNs` lives in
   `place/store.ts` (the lower layer; `acquire` imports it; `place` may never import `acquire`).
2. Spec §15 says "New runtime dependencies: none" yet D4 wires `@clack/prompts`, which is absent
   from `packages/cli/package.json` — resolved: it is added there (Task 9); it is a
   stack-approved package (see Tech stack above), not a new dependency decision.
3. Spec §4.2 step 1 ("any grammar rejection is exit 2 before any I/O") vs D13 per-source
   fail-fast — resolved with the stricter reading: **all** sources are parsed up front (pure); if
   any source fails to parse, the whole invocation refuses before any I/O (offending sources
   `refused`, the rest `skipped`, exit 2).
4. §12.1's result sample shows `skill` always set while `tool` is null for source-level failures —
   resolved: `skill` is `string | null`, null for source-level failures where no unique skill was
   resolved (parse errors, fetch failures, whole-repo ambiguity). Additive, zod-nullable.
5. The spec rejects "short SHAs" without defining them — resolved: a ref of 7–39 hex chars
   (`/^[0-9a-f]{7,39}$/`) is treated as a short SHA and rejected; only 40-hex is a SHA ref.
6. §8.1's "rollback of an uncommitted fresh install … restores 'nothing there'" needs a pair-record
   rule — resolved: rollback of a `before: { mode: 'absent' }` journal **deletes the pair record**;
   as an engine precondition, the run layer never starts a fresh-install swap on a pair holding
   prior dev/pinned records (those route through the repaired/replace paths instead).
7. §5.2's URL scheme list (`https|http|ssh|git`) gains `file` — the spec's own §16 test strategy
   drives install against `file://` bare-repo fixtures, and that must flow through the public
   grammar (`runInstall` parses every source). R6 still rejects bare filesystem paths.
8. Spec §15 homes the journal-hygiene sweep in `acquire/run.ts`, but §8.5 requires the
   promote/dev/rollback batches (`place/run.ts`) to run it too, and `place` may never import
   `acquire` — resolved: `sweepCommittedAcquireJournals` lives in `place/swap.ts`, called by
   both run layers (Task 5).
9. §2.2/D9 is silent on store-linked in the flip verbs' `--all` sets — resolved: named/path
   targets accept store-linked; the `--all` sets are unchanged (the spec amends only the
   targeted-flip paths — Task 6).

---

## Global Constraints (binding — copy verbatim into every implementer and reviewer prompt)

1. **Core purity.** `@skillsmith/core` (`packages/core/src/**`) must not import `commander`,
   `chalk`, `consola`, `@clack/prompts`, or `node:console`, and must not call `process.exit(...)`
   or `console.{log,info,warn,error,debug}(...)`. Fallible core functions return
   `Result<T, SkillSmithError>`. The CLI alone decides exit codes and output. Enforced by
   `bun run lint:boundaries`.
2. **Import direction.** `acquire/` is the **topmost** core orchestrator: it may import `env/`,
   `detect/`, `agents/`, `verify/`, `place/`, `errors.ts`, `result.ts`. Nothing imports it back:
   `skills/`, `plugins/`, `commands/`, `verify/`, and `place/` must NOT import `acquire/`
   (ESLint zones added in Task 1; ADR-0003 amended there). CLI `output/`, `help/`, `util/` are
   leaves (no imports of `commands/` or `index.ts`); CLI imports core only via the
   `@skillsmith/core` package entry.
3. **Per-agent boundary.** No new per-agent files and no merging across agent dirs. Install hints
   come from the existing `agents/<tool>/install-hint.ts`, skills roots from
   `agents/<tool>/skill-roots.ts` (never hardcode paths elsewhere), placement classes from
   `agents/<tool>/placement.ts` / `agents/placement-shared.ts` (`classifyPlacement` is unchanged).
   Do not touch kilo-code / opencode.
4. **Ledger contract stability.** `$SKILLSMITH_DATA/placements.json` stays
   `{"schemaVersion": 1, "kind": "skillsmith.placements", ...}`. Every P09 field is **additive
   optional** (`origin`, `pinned.placement`, `projects`, `before.liveKind`). The two deliberate
   enum widenings — `Journal.op` gains `'install' | 'uninstall'`, `Journal.before` gains
   `{ mode: 'absent' }` — are confined to crash windows: acquisition ops null the journal (install)
   or delete the pair (uninstall) in the same ledger write that commits the terminal state, and
   every locked v0.6.0 batch (install, uninstall, promote, dev, rollback) runs the journal-hygiene
   sweep that finishes any lingering committed acquisition journal. An unparseable ledger is a
   hard error (exit 3), **never** regenerated.
5. **Never delete from the store.** Store entries are write-once and immortal — no deletion path
   anywhere in P09 (no GC in v1). The only deletions: `store/.staging/<txId>`,
   `<dataDir>/.fetch/<entry>` (age > 60 min or own-source cleanup), placement
   `.skillsmith-staging-*`, and backups **only when reproducible** (symlink backups always —
   targets are recorded; dir backups only when their content hash matches a store entry recorded
   on the pair; otherwise KEPT + warning).
6. **An unresolved journal blocks everything.** A pair whose `journal` is non-null with
   `phase !== 'committed'` refuses every operation except a same-op re-run and the flip verbs'
   `--rollback` — exit 2, message naming both exact commands. There is deliberately **no
   `install --rollback` flag**: recovery = re-run the same install (converges, D14) or
   `promote --rollback <skill>` / `dev --rollback <skill>` (the engine's rollback is op-agnostic).
7. **Store path / rev grammar (frozen).** Install only ever mints
   `store/<ns>/<name>@<sha12>/<skill>/` with `ns`/`name` from `clampStoreNs` (2 segments, always)
   and `<sha12>` = first 12 hex of the resolved full SHA. Full, unclamped provenance (host,
   multi-segment repo path) lives in the pair's `origin` record — the store path is an address,
   the ledger is the record.
8. **Exit codes (CI contract; batch exit = highest per-result code in BOTH fail-fast and
   `--continue-on-error` modes):**

   | Code | `install` | `uninstall` |
   |---|---|---|
   | 0 | all `installed`/`updated`/`repaired`/`noop` (+ warnings) | all `removed`/`noop` (absence included) |
   | 1 | verify-gate `fail`; snapshot integrity error; mid-swap I/O failure (recoverable); lock unobtainable | mid-removal I/O failure (recoverable); lock unobtainable |
   | 2 | grammar rejections; R2/R3 ambiguity in non-TTY/`--json`/`--no-prompt`; shadowing w/o `--force`; codex legacy-root conflict; different-origin placement w/o `--force`; `--ref` misuse; contradictory scope flags; `--deep` + `--no-verify`; unresolved journal | U2 cross-scope ambiguity; U3 dev-mode refusal; unmanaged placement w/o `--force`; unresolved journal |
   | 3 | ledger unreadable/unparseable (never regenerated) | same |
   | 4 | explicitly `--tool`-named tool not detected (install hint printed); no tool detected at all | — (uninstall needs no detection) |
   | 5 | source unresolvable: network/clone failure, repo/ref not found, name matches zero skills, short-SHA ref | — |
   | 6 | skills root, store, `.fetch`, or ledger path not writable | skills root or ledger not writable |
   | 130 | SIGINT — current journal write finishes, batch aborts, state recoverable | same |

   Error-code map: new core code `tool-unavailable` → 4; existing `source-unresolvable` → 5,
   `flip-refused` → 2, `flip-failed` → 1, `ledger-error` → 3, `permission-denied` → 6,
   `placement-not-found` → 4 reused as-is. Exit codes are computed by the CLI from per-result
   `error` fields (batch max), never inside core.
9. **JSON contract stability.** Two kinds — `skillsmith.install` and `skillsmith.uninstall` —
   both `schemaVersion: 1`, zod-validated by the CLI before writing, additive-only evolution.
   Copy field names exactly as given in Tasks 7–9.
10. **Security floor (F9).** Install executes NOTHING from the fetched repo by default — no hooks,
    no scripts, no feeding fetched bytes to an agent binary. All git runs via `env.exec` with
    `GIT_TERMINAL_PROMPT=0` in a skillsmith-`init`ed dir (no repo-supplied config is ever
    honored). `--deep` is the one documented opt-in exception (codex verify runs the codex binary
    against the fetched, unplaced skill, pre-placement); `--deep` + `--no-verify` is a usage
    refusal (exit 2) before any I/O. No new token/auth plumbing: git's own credential machinery.
11. **ONE ledger lock per invocation** (P12-T02 carry-forward, codified by F8): acquired before
    the first mutation and held across the entire batch — fetch and verify included. `--dry-run`
    takes **no lock** and writes nothing (its fetch dirs are read-only and self-cleaned; the
    orphan sweep's 60-minute age guard exists exactly because dry-run fetches are unlocked).
12. **resumeSwap committed-journal carry-forward:** `resumeSwap` on an already-`committed`
    journal returns `ok({ committed: true })` meaning "residue reclaimed / start fresh" — NEVER
    "my attempt just succeeded". A re-run install over such a pair reports the convergent
    `noop`/`repaired` action, never a fresh `installed`.
13. **Path bases (state them, test them):** `projects` keys = **realpath** of the git toplevel
    (matches `git rev-parse --show-toplevel` output); `placementPath` = literal
    `join(root, skill)` (P12 rule); `origin.repo` = **unclamped** repo path (subgroups keep their
    `/`); `origin.skillPath` = repo-relative git tree path (`''` for a root skill — never a
    filesystem path); `dev.sourcePath` = literal symlink target, restored verbatim.
14. **swap.ts stays behavior-preserving for P12 ops.** Every existing P12 test passes unmodified
    (the only allowed edit to existing tests is the Task-4 mechanical `ScanEnv` stub extension).
    New journal fields written for promote/dev ops must be optional and ignorable by the P12
    logic paths.
15. **No new runtime deps** beyond the Task-9 `@clack/prompts` wiring (stack-approved, CLI-only).
    Git only via `env.exec`. Node built-ins (`node:crypto`, `node:path`) allowed in core as today.
16. **Commits.** Conventional Commits; scope ∈ `{cli, core, main}` or no scope; body lines
    ≤ 100 chars. `main` is reserved for release-please. No hand-edits to release-please-managed
    files (root/packages `package.json` versions, `CHANGELOG.md`, `.release-please-manifest.json`).
    The bump to 0.6.0 happens via the squash-merged `feat:` PR title.
17. **Tests first.** Write the failing test, watch it fail, then implement. Every task's
    verification ends with `bunx tsc --noEmit`, `bun run lint:boundaries`, targeted `bun test`,
    and `bunx @biomejs/biome check --write <changed paths>`; the branch must keep `bun run check`
    green (live e2e suites are env-gated and skip in CI).

---

## Conventions

- Paths are repo-relative from the workspace root.
- `bun test` auto-discovers `*.test.ts`; helper files without that suffix are not collected.
- Model per task: TS01 = haiku; T01, T02, T05, T07, T08, TS02 = sonnet; T03, T04, T06 = opus.
  **Highest-risk task: Task 5 [P09-T04] (ledger + swap widening) — it gets a fable task-review;
  every other task gets a sonnet review.** The final whole-branch review (P09-RV, fable) is
  outside this plan's task list.
- The orchestrator (not the implementer) flips the matching PROJECTS.md checkbox after each task
  is reviewed.
- `$SKILLSMITH_DATA` / `<dataDir>` = `resolveDataDir(env, envVars)` from
  `packages/core/src/place/paths.ts` (`$SKILLSMITH_HOME`, else `$XDG_DATA_HOME/skillsmith`);
  `storeRootOf(dataDir)` = `<dataDir>/store`; `ledgerPathOf(dataDir)` = `<dataDir>/placements.json`.
  Reuse, never reinvent.
- Skills roots come from `agents/<tool>/skill-roots.ts` (`getSkillRoots(env, scope, ctx)` with
  `ctx = { cwd, envVars }`):

  | Tool | user scope | project scope (`ctx.cwd` = project root) | legacy (read-only for install) |
  |---|---|---|---|
  | claude-code | `~/.claude/skills` (honors `CLAUDE_CONFIG_DIR`) | `<projectRoot>/.claude/skills` | — |
  | codex | `~/.agents/skills` (first) | `<projectRoot>/.agents/skills` | `~/.codex/skills` (honors `CODEX_HOME`) |

  Install writes only current-convention roots; the codex legacy root is read for conflicts and
  is a first-class *removal* location for uninstall.
- Existing test harnesses to reuse: `packages/core/tests/fixtures/place/fleet.ts`
  (`buildFixtureFleet` — fake `$HOME`, real git checkout, dev/pinned/dangling/dup placements) and
  `packages/core/tests/place/crash-env.ts` (`crashingEnv` — throws `SimulatedCrash` at the Nth
  mutating env call: `makeSymlink`, `rename`, `copyTree`, `removeTree`, `makeDir`,
  `writeTextFile`).
- Reserved dot-names inside a skills root (invisible to placement detection and tool discovery):
  `.skillsmith-staging-<skill>-<txId>`, `.skillsmith-backup-<skill>-<txId>` — same as P12.

---

## Task 1 [P09-T01] — Source grammar parser (model: sonnet)

The pure, deterministic source parser: every rule decidable without network or filesystem probes.
Creates the `acquire/` zone (types + parser) and its ESLint boundary.

**Files:**
- Create: `packages/core/src/acquire/types.ts` (source types; later tasks append)
- Create: `packages/core/src/acquire/source.ts`
- Create: `packages/core/tests/acquire/source.test.ts`
- Modify: `eslint.config.js` (acquire zones), `docs/adr/0003-eslint-import-boundaries.md` (zone note)

**Interfaces produced (exact — every later task consumes this):**

`packages/core/src/acquire/types.ts`:

```ts
import type { SkillSmithError } from '../errors.ts';
import type { Result } from '../result.ts';

export interface SourceSpec {
  raw: string;       // the literal user argument, ref suffix included
  host: string;      // 'github.com' for sugar; the host segment (may carry ':port') or URL/scp authority host
  repoPath: string;  // UNCLAMPED '/'-joined repo path ('acme/platform/tools'); trailing '.git' stripped
  cloneUrl: string;  // sugar/host-explicit: `https://<host>/<repoPath>.git`; URL/scp forms: verbatim minus `//path` and `@ref`
  selector:
    | { kind: 'whole-repo' }
    | { kind: 'name'; name: string }
    | { kind: 'path'; path: string }; // normalized: no leading/trailing '/', no empty/'.'/'..' segments
  ref: string | null; // the `@ref` as given; null = HEAD (remote default branch)
}
```

`packages/core/src/acquire/source.ts`:

```ts
export const parseSource = (raw: string): Result<SourceSpec, SkillSmithError>;
```

Grammar rejections return `err(flipRefusedError(<message>))` (exit 2 via the existing map),
with ONE exception: the short-SHA rejection returns `err(sourceUnresolvableError(<message>))`
(exit 5 — the §13 table lists "short-SHA ref" under source-unresolvable; the source is
well-formed but cannot be resolved remotely). Messages below are load-bearing — copy them.

**Parse algorithm (ordered; implement exactly):**

1. **Ref split:** the ref separator is the **last `@` in the source iff it occurs after the last
   `/`**. Split there → `(body, ref)`. This never fires inside scp `user@host` (that `@` precedes
   the `host:owner/…` slashes) or URL userinfo. An `@` that is not part of a URL/scp authority
   and sits in the body *before* the last `/` → reject:
   `` `place '@<ref>' after the skill path: '<body-with-@-moved-to-end>'` `` (e.g.
   `owner/repo@v2//path` → suggest `owner/repo//path@v2`).
2. **Ref validation (parse-adjacent):** a ref matching `/^[0-9a-f]{7,39}$/` is a short SHA →
   reject with `sourceUnresolvableError` (exit 5, see above):
   `short SHAs cannot be resolved remotely; use a full 40-hex SHA, a tag, or a branch`.
   A 40-hex ref is accepted as a SHA.
3. **URL detection:** body contains `://` → URL form (scheme must be one of `https`, `http`,
   `ssh`, `git`, `file` — resolution 7; anything else rejects with the scheme named). Or body
   matches scp form
   `^[^/\s]+@[^/:\s]+:` → scp form. For both: split an optional `//path` at the **first `//`
   after the authority** (for URLs, search the path portion only — never match the `://`);
   repo path = URL/scp path segments with trailing `.git` stripped; host = authority host
   (+`:port` if present); cloneUrl = the original URL/scp string minus `//path` and `@ref`.
4. **Local-path rejection (R6):** body starts with `/`, `./`, `../`, `~`, or is `.`/`..` →
   reject: `install acquires remote sources only — '<raw>' is a local path. For a local checkout
   use 'skillsmith dev <skill> --source <path>' then 'skillsmith promote <skill>'`.
5. **Sugar / host-explicit:** split an optional `//skillpath` at the first `//`; a *trailing*
   bare `//` means whole-repo (subgroup repos need it). Split the base on `/`:
   - first segment contains `.` or `:` → **host-explicit**: `host / seg…`. After the host:
     2 segments = repo, whole-repo; 3 segments = repo + `<name>` selector; ≥4 segments without
     `//` → reject: `ambiguous subgroup path — use '<host>/group/sub/repo//path/to/skill' or a
     trailing '//' for a whole-repo scan`. With `//`, ALL segments after the host are the repo
     path (any depth).
   - else **GitHub sugar** (`github.com` implied, hardcoded): 1 segment → reject:
     `one-part names are reserved for a future registry; use 'owner/repo[/<name>]'`; 2 segments =
     repo, whole-repo; 3 segments = repo + `<name>`; ≥4 without `//` → reject as above.
6. **Selector normalization:** `//path` segments must be non-empty and must not contain `.`/`..`
   segments (reject: `invalid skill path segment '<seg>'`); the final path segment — and any
   `<name>` selector — must not start with `.` (reject:
   `dot-prefixed skills are invisible to placement detection`).
7. **Clone URL:** sugar/host-explicit → `https://<host>/<repoPath>.git`; URL/scp → verbatim
   (minus `//path` and `@ref`).

Skill *name* = final segment of the resolved skill path; for a root-`SKILL.md` repo the skill dir
is the repo root and the name = the repo's final path segment (resolution-time rule — Task 4).

**Parse table (every row is a test):**

| # | Source | Host | Repo path | Selector | Ref | Outcome |
|---|---|---|---|---|---|---|
| 1 | `smorinlabs/smorinlabs-harness` | github.com | `smorinlabs/smorinlabs-harness` | whole-repo | null | ok |
| 2 | `smorinlabs/smorinlabs-harness/factor-scan` | github.com | same | name `factor-scan` | null | ok |
| 3 | `smorinlabs/smorinlabs-harness/factor-scan@v1.2.0` | github.com | same | name `factor-scan` | `v1.2.0` | ok |
| 4 | `owner/repo@main` | github.com | `owner/repo` | whole-repo | `main` | ok |
| 5 | `owner/repo//plugins/fh/skills/factor-scan` | github.com | `owner/repo` | path `plugins/fh/skills/factor-scan` | null | ok |
| 6 | `owner/repo//plugins/fh/skills/factor-scan@<40-hex>` | github.com | `owner/repo` | path … | full SHA | ok |
| 7 | `gitlab.com/acme/tools` | gitlab.com | `acme/tools` | whole-repo | null | ok |
| 8 | `gitlab.com/acme/tools/review` | gitlab.com | `acme/tools` | name `review` | null | ok |
| 9 | `git.corp.example:8443/team/kit/lint@release-2` | git.corp.example:8443 | `team/kit` | name `lint` | `release-2` | ok |
| 10 | `gitlab.com/acme/platform/tools//skills/review` | gitlab.com | `acme/platform/tools` | path `skills/review` | null | ok |
| 11 | `gitlab.com/acme/platform/tools//` | gitlab.com | `acme/platform/tools` | whole-repo | null | ok (trailing `//`) |
| 12 | `https://gitlab.com/acme/platform/tools.git//skills/review@main` | gitlab.com | `acme/platform/tools` | path `skills/review` | `main` | ok; cloneUrl `https://gitlab.com/acme/platform/tools.git` |
| 13 | `git@github.com:smorinlabs/skillsmith.git//plugins/x/skills/y@main` | github.com | `smorinlabs/skillsmith` | path `plugins/x/skills/y` | `main` | ok — scp `git@` is not a ref separator |
| 14 | `ssh://git@git.corp/team/kit//skills/lint` | git.corp | `team/kit` | path `skills/lint` | null | ok |
| 15 | `factor-scan` | — | — | — | — | reject (R5 one-part message) |
| 16 | `repo@main` | — | — | — | — | reject (R5) after ref-strip leaves one part |
| 17 | `./skills/factor-scan`, `/Users/a/c/x`, `~/c/x` | — | — | — | — | reject (R6 local-path message) |
| 18 | `gitlab.com/acme/platform/tools/review` | — | — | — | — | reject (≥4 segments after host without `//`) |
| 19 | `owner/repo@v2//path` | — | — | — | — | reject (R4: `@` before the end of the path portion) |
| 20 | `owner/repo/a/b/c` | — | — | — | — | reject (>3 sugar segments without `//`) |

Plus fuzz edges: `owner/repo@8c1d2e3` (short SHA → reject, code `source-unresolvable`);
`https://user@gitlab.com/a/b` (userinfo `@` not a ref); trailing single `/` tolerated
(`owner/repo/` = whole-repo); `.git` stripped from sugar (`owner/repo.git` → repoPath
`owner/repo`); `owner/repo//a//b` (second `//` → reject invalid segment — empty segment);
`owner/repo/.hidden` (dot-name reject); `ftp://x/y` (scheme reject);
`file:///tmp/fixtures/multi.git//plugins/x` (ok: URL form, host `''`, cloneUrl
`file:///tmp/fixtures/multi.git`, path selector `plugins/x` — resolution 7).

- [ ] **Step 1: Failing tests** — `packages/core/tests/acquire/source.test.ts`: one assertion
  block per table row (assert every `SourceSpec` field on ok rows; assert the documented
  `error.code` — `flip-refused`, or `source-unresolvable` for the short-SHA edge — and a
  distinctive message substring on reject rows) plus the fuzz edges.
  Run: `bun test packages/core/tests/acquire/source.test.ts` — expect FAIL (module missing).
- [ ] **Step 2: Implement** `types.ts` + `source.ts` (pure string work; `node:path` allowed but
  not needed; NO env, NO I/O).
- [ ] **Step 3: ESLint zones + ADR.** In `eslint.config.js`, after the four `place/` zone entries
  add:

  ```js
  // acquire is the topmost core orchestrator (install/uninstall); nothing may import it back.
  { target: './packages/core/src/skills', from: './packages/core/src/acquire' },
  { target: './packages/core/src/plugins', from: './packages/core/src/acquire' },
  { target: './packages/core/src/commands', from: './packages/core/src/acquire' },
  { target: './packages/core/src/verify', from: './packages/core/src/acquire' },
  { target: './packages/core/src/place', from: './packages/core/src/acquire' },
  ```

  Append to the zone list in `docs/adr/0003-eslint-import-boundaries.md` (Decision §1):
  `- packages/core/src/{skills,plugins,commands,verify,place} ↛ acquire (acquire is the topmost orchestrator: it imports env, detect, agents, verify, and place).`
- [ ] **Step 4: Verify and commit.**

```bash
git add packages/core/src/acquire packages/core/tests/acquire eslint.config.js docs/adr/0003-eslint-import-boundaries.md
git commit -m "feat(core): add install source grammar parser" \
  -m "Pure deterministic parseSource: GitHub sugar, host-explicit (subgroups via //), https/ssh/scp" \
  -m "URLs, last-@-after-last-/ ref split, R5/R6 rejections, short-SHA rejection, dot-name guard;" \
  -m "acquire/ eslint zone (topmost orchestrator) + ADR-0003 note."
```

**Automated verification:** `bun test packages/core/tests/acquire/source.test.ts` ·
`bunx tsc --noEmit` · `bun run lint:boundaries`

---

## Task 2 [P09-T02] — Namespace clamp + `parseRemote` regression (model: sonnet)

Closes PR #5 follow-up #4 (mandated by R7): the store grammar is frozen at two segments, but
today `parseRemote` in `place/store.ts` returns `repo: 'platform/tools'` for a GitLab subgroup
origin URL, which would let `promote` mint a 3-segment store path. One shared clamp fixes both
the promote-provenance path and (later) install-resolution.

**Files:**
- Modify: `packages/core/src/place/store.ts`
- Create: `packages/core/tests/place/store-clamp.test.ts`

**Interface produced (exact):** add to `place/store.ts` (exported; Task 7 imports it from
`../place/store.ts` inside `acquire/`):

```ts
/** Clamp a '/'-joined repo path to the frozen 2-segment store namespace (spec §7.2 / R7).
 *  ns = sanitize(first segment); name = sanitize(remaining segments joined with '-').
 *  sanitize: strip a trailing '.git' first, then replace every char outside [A-Za-z0-9._-]
 *  with '-'. 'acme/platform/tools' → { ns: 'acme', name: 'platform-tools' }. */
export const clampStoreNs = (repoPath: string): { ns: string; name: string };
```

Rules: split on `/`, drop empty segments; strip a trailing `.git` from the final segment before
sanitizing; a defensive single-segment input clamps to `{ ns: seg, name: seg }` (unreachable via
shipped callers — `parseRemote` and `parseSource` both require ≥2 segments).

**`resolveProvenance` change (behavior-preserving except for multi-segment repos):** where it
currently sets `ns: parsed.owner, name: parsed.repo`, route through
`clampStoreNs(`${parsed.owner}/${parsed.repo}`)` and use `clamped.ns` / `clamped.name`. The
`remote` field **stays unclamped** (`'acme/platform/tools'`) — DevRecord.remote is a provenance
record, the clamp only addresses the store path. For plain `owner/repo` remotes the clamp is an
identity — every existing P12 store/provenance test must pass unchanged.

Collision note (document in a code comment): a clamped subgroup (`acme/platform-tools`) and a
real repo of that name can only meet at an identical `@<sha12>`, where the store's existing
content-hash integrity check either reuses (identical content) or fails loudly — no extra
handling here.

- [ ] **Step 1: Failing clamp unit tests** (`store-clamp.test.ts`): matrix —
  `owner/repo` → `{owner, repo}`; `acme/platform/tools` → `{acme, 'platform-tools'}`;
  `a/b/c/d` → `{a, 'b-c-d'}`; `owner/repo.git` → `{owner, repo}`; segment with illegal chars
  (`ac me/to ols` → `{'ac-me', 'to-ols'}`); dots preserved (`acme.io/kit` → `{'acme.io', 'kit'}`).
- [ ] **Step 2: Failing `parseRemote`/provenance regression** (same file, uses
  `buildFixtureFleet`): copy the fleet checkout (or re-point it) via
  `git remote set-url origin git@gitlab.com:acme/platform/tools.git`, then:
  - `resolveProvenance(env, alphaSrc)` → `ns: 'acme'`, `name: 'platform-tools'`,
    `remote: 'acme/platform/tools'` (unclamped).
  - `snapshotToStore` with that provenance → `storePath` matches
    `store/acme/platform-tools@<headSha12>/alpha` — exactly 2 path segments between `store/` and
    `@`.
  - the https variant `https://gitlab.com/acme/platform/tools.git` produces the identical clamp.
  - cross-check with install-side resolution: `clampStoreNs('acme/platform/tools')` equals the
    ns/name pair the provenance produced (this is the "both paths mint the same namespace"
    assertion the spec mandates).
- [ ] **Step 3: Implement** — add `clampStoreNs`, thread it through `resolveProvenance`.
- [ ] **Step 4: Verify** — new tests pass AND the full existing suite stays green:
  `bun test packages/core/tests/place`.
- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/place/store.ts packages/core/tests/place/store-clamp.test.ts
git commit -m "fix(core): clamp multi-segment repo paths to two-segment store namespaces" \
  -m "clampStoreNs shared by promote provenance and install resolution; parseRemote subgroup" \
  -m "repos no longer mint 3-segment store paths (PR #5 follow-up #4); remote stays unclamped."
```

**Automated verification:** `bun test packages/core/tests/place` · `bunx tsc --noEmit` ·
`bun run lint:boundaries`

---

## Task 3 [P09-TS01] — Hermetic remote fixtures + project-scope fleet root (model: haiku)

Local **bare** git repos addressed via `file://` so the whole fetch pipeline is testable offline,
plus an additive fleet extension providing a real project root for project-scope tests. No test
in this repo may fetch the network outside the env-gated live suites.

**Files:**
- Create: `packages/core/tests/fixtures/acquire/remote.ts` (builder helper — not a test file)
- Create: `packages/core/tests/acquire/remote-fixture.test.ts`
- Modify: `packages/core/tests/fixtures/place/fleet.ts` (**additive fields only** — do not touch
  any existing field, path, or recipe step; every P12 test must pass unchanged)

**Interface produced (exact):**

```ts
export interface RemoteFixture {
  base: string;        // mkdtemp root
  multiUrl: string;    // file://<base>/multi.git   — several skills incl. a duplicate basename
  singleUrl: string;   // file://<base>/single.git  — exactly one skill, nested deep
  rootUrl: string;     // file://<base>/root.git    — SKILL.md at the repo root
  multiWork: string;   // <base>/multi-work — the working clone multi.git was made from
  multiHead: string;   // full 40-hex HEAD SHA of multi (main)
  multiTagSha: string; // full 40-hex SHA of tag v1.0.0 (the FIRST commit — differs from HEAD)
  singleHead: string;
  rootHead: string;
}
export const buildRemoteFixture = (): Promise<RemoteFixture>;
export const destroyRemoteFixture = (f: RemoteFixture): Promise<void>; // rm -rf <base>
```

**Repo contents (exact):**

`multi-work` — commit 1 (tagged `v1.0.0`):
| Path | Content |
|---|---|
| `plugins/web/skills/review/SKILL.md` | frontmatter `name: review`, `description: Web review fixture.` |
| `plugins/fh/skills/factor-scan/SKILL.md` | frontmatter `name: factor-scan`, `description: Fixture skill.`, body `# factor-scan` |

commit 2 (HEAD, `main`) adds:
| Path | Content |
|---|---|
| `plugins/api/skills/review/SKILL.md` | frontmatter `name: review`, `description: API review fixture.` (duplicate basename → R2 ambiguity) |
| `plugins/fh/skills/factor-scan/bin/run.sh` | `#!/bin/sh\necho fs\n`, **chmod 0o755** |
| `plugins/fh/skills/factor-scan/link.md` | **relative symlink**, target `SKILL.md` |
| `docs/notes.md` | any text (non-skill blob) |
| `.internal/skills/hidden/SKILL.md` | frontmatter `name: hidden` — dot-segment dir that candidate scans must exclude |

`single-work` — one commit: `tools/deep/skills/lint/SKILL.md` (frontmatter `name: lint`).
`root-work` — one commit: `SKILL.md` at the repo root (frontmatter `name: rootskill`) + `README.md`.

**Recipe (deterministic, hermetic — same env pattern as `fleet.ts`):** run git via
`Bun.spawnSync` with `env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null',
GIT_CONFIG_SYSTEM: '/dev/null' }` and per-command
`-c user.email=fixture@skillsmith.test -c user.name=fixture -c commit.gpgsign=false`:

1. Build each work dir, `git init -q -b main`, add + commit (multi: commit 1, `git tag v1.0.0`,
   then commit 2).
2. `git clone -q --bare <work> <base>/<name>.git` for each.
3. In each bare repo: `git -C <bare> config uploadpack.allowFilter true` and
   `git -C <bare> config uploadpack.allowReachableSHA1InWant true` (blobless `--filter` fetches
   and full-SHA fetches both need server-side opt-in; GitHub/GitLab enable these — the fixture
   mirrors them).
4. URLs: `` `file://${join(base, '<name>.git')}` ``. SHAs via `git rev-parse HEAD` /
   `git rev-parse v1.0.0^{commit}` in the work dirs (validate `/^[0-9a-f]{40}$/`).
5. Throw a plain `Error` on any non-zero git exit.

**Fleet extension (`fleet.ts` — append to `FixtureFleet` and the builder):**

```ts
project: string;      // <base>/project — a REAL git repo (init + one commit); the project-scope root
projectReal: string;  // realpath of <base>/project (macOS /var → /private/var)
```

Recipe: `mkdir <base>/project`, write `README.md` (`# project fixture`), same hermetic
`git init -q -b main` + add + commit as the checkout (no remote). `projectReal` via
`node:fs/promises` `realpath`.

- [ ] **Step 1: Failing shape test** (`remote-fixture.test.ts`):
  - `buildRemoteFixture()` resolves; all three `*.git` dirs exist and are bare
    (`git -C <bare> rev-parse --is-bare-repository` → `true`).
  - `git -C <multi bare> config --get uploadpack.allowFilter` → `true`; same for
    `allowReachableSHA1InWant`.
  - `git ls-remote <multiUrl> HEAD` (spawnSync) contains `multiHead`; `multiTagSha !== multiHead`;
    all SHAs match `/^[0-9a-f]{40}$/`.
  - `multiWork` contains both `plugins/web/skills/review/SKILL.md` and
    `plugins/api/skills/review/SKILL.md`; `run.sh` has the owner-exec bit; `link.md` is a symlink
    with literal target `SKILL.md`.
  - fleet: `buildFixtureFleet()` → `project` is a git repo (`.git` exists), `projectReal` equals
    `realpath(project)`; every pre-existing fleet assertion in
    `packages/core/tests/place/fleet.test.ts` still passes.
  - `destroyRemoteFixture` removes `<base>`.
- [ ] **Step 2: Implement** `remote.ts` + the fleet extension (use `node:fs/promises` +
  `Bun.spawnSync`, mirroring `fleet.ts`'s `runGit` helper).
- [ ] **Step 3: Verify** — `bun test packages/core/tests/acquire/remote-fixture.test.ts
  packages/core/tests/place/fleet.test.ts`; `bunx tsc --noEmit`;
  `bunx @biomejs/biome check --write packages/core/tests`.
- [ ] **Step 4: Commit.**

```bash
git add packages/core/tests/fixtures/acquire/remote.ts packages/core/tests/acquire/remote-fixture.test.ts packages/core/tests/fixtures/place/fleet.ts
git commit -m "test(core): add hermetic file:// remote fixtures and project-scope fleet root" \
  -m "Three bare repos (multi/single/root skill layouts, tag + HEAD, allowFilter +" \
  -m "allowReachableSHA1InWant) for offline fetch tests; fleet gains a real project-root git repo."
```

**Automated verification:** `bun test packages/core/tests/acquire/remote-fixture.test.ts packages/core/tests/place/fleet.test.ts` · `bunx tsc --noEmit`

---

## Task 4 [P09-T03] — Fetch pipeline + skill resolver (model: opus)

**Consumes:** Task 1's `parseSource`/`SourceSpec`, Task 3's `RemoteFixture`.

The network-facing half of install: blobless partial clone, tree-listing skill scan, sparse
checkout of exactly one skill subtree, ref→SHA resolution, ls-remote elision probe, and the
`.fetch` orphan sweep. All git via `env.exec`; nothing fetched is ever executed (F9): the fetch
dir's git config is skillsmith-created (`git init` + `git -C`), so no repo-supplied config or
hook is ever honored.

**Files:**
- Create: `packages/core/src/acquire/fetch.ts`, `packages/core/src/acquire/resolve.ts`
- Modify: `packages/core/src/acquire/types.ts` (append `CandidateSkill`, `Selection`)
- Modify: `packages/core/src/env/types.ts`, `packages/core/src/env/default.ts` (one new
  primitive: `modifiedAt`)
- Modify (mechanical): every existing test file with a `ScanEnv` object-literal stub — add
  `modifiedAt: async () => null,`. Find them with
  `grep -rln "withFileLock: (_p, fn) => fn()" packages/core/tests packages/cli/tests` (plus any
  literal the compile flags). `bunx tsc --noEmit` proves coverage. Also add the pass-through to
  `packages/core/tests/place/crash-env.ts`? **No** — `crashingEnv` spreads `...inner`, so
  read-only primitives pass through automatically; do not count `modifiedAt` as mutating.
- Create: `packages/core/tests/acquire/fetch.test.ts`,
  `packages/core/tests/acquire/resolve.test.ts`

**Env primitive (exact):** append to `ScanEnv`:

```ts
modifiedAt(p: string): Promise<number | null>; // lstat mtimeMs; null when absent (ENOENT)
```

`defaultScanEnv` implementation: `lstat(p)` → `st.mtimeMs`; `ENOENT` → `null`; other errors
propagate.

**Interfaces produced (exact):**

`acquire/types.ts` additions:

```ts
export interface CandidateSkill {
  path: string; // repo-relative git tree path of the skill dir; '' = repo root
  name: string; // basename(path); for path '' the caller substitutes the repo's final segment
}
export type Selection =
  | { kind: 'chosen'; skill: CandidateSkill }
  | { kind: 'ambiguous'; candidates: CandidateSkill[] } // caller: exit-2 refusal + JSON candidates
  | { kind: 'none'; searched: number };                 // caller: exit-5 source-unresolvable
```

`acquire/fetch.ts`:

```ts
export const fetchRepo = (env: ScanEnv, opts: {
  cloneUrl: string;
  ref: string | null;          // null = 'HEAD' (remote default branch); may be a full 40-hex SHA
  fetchDir: string;            // <dataDir>/.fetch/<txId> — caller-chosen, one dir per source
  signal?: AbortSignal;
}): Promise<Result<{ sha: string }, SkillSmithError>>;  // sha = full 40-hex of FETCH_HEAD

export const lsTreeSkills = (env: ScanEnv, fetchDir: string, signal?: AbortSignal):
  Promise<Result<{ candidates: CandidateSkill[]; scanned: number }, SkillSmithError>>;

export const sparseCheckoutSkill = (env: ScanEnv, fetchDir: string, skillPath: string,
  signal?: AbortSignal): Promise<Result<string, SkillSmithError>>; // abs path of the skill dir

export const resolveRefViaLsRemote = (env: ScanEnv, cloneUrl: string, ref: string | null,
  signal?: AbortSignal): Promise<Result<string | null, SkillSmithError>>;

export const sweepFetchOrphans = (env: ScanEnv, dataDir: string): Promise<void>; // best-effort
```

**`fetchRepo` git sequence (exact — F9-clean):** every call
`env.exec('git', [...], { timeoutMs, env: { GIT_TERMINAL_PROMPT: '0' }, ...(signal ? { signal } : {}) })`;
plumbing timeout 10_000 ms, fetch/checkout 120_000 ms:

```
git init -q <fetchDir>                                          (10 s)
git -C <fetchDir> remote add origin <cloneUrl>                  (10 s)
git -C <fetchDir> fetch -q --filter=blob:none --depth 1 origin <ref ?? 'HEAD'>   (120 s)
git -C <fetchDir> rev-parse FETCH_HEAD                          (10 s) → sha (validate 40-hex)
```

Any non-zero exit → `err(sourceUnresolvableError(`cannot fetch <cloneUrl>: <stderr tail>`))`
where the stderr tail = last 5 non-empty stderr lines. By construction nothing has been written
outside `<fetchDir>` — never a half-install. Offline is deterministic: the same URL fails the
same way every time.

**`lsTreeSkills`:** `git -C <fetchDir> ls-tree -r --name-only FETCH_HEAD` (10 s; tree listing
needs NO blobs — the clone stays blobless through resolution). A candidate is every directory
containing a `SKILL.md` entry at any depth, root included (path `''` when `SKILL.md` is a
top-level entry). Exclude any candidate whose path contains a dot-prefixed segment (`.internal/…`
— dot entries are invisible to placement detection). `scanned` = total candidate count before
exclusion is NOT needed — set `scanned` = number of `SKILL.md`-bearing directories found
(post-exclusion), used in the zero-match message.

**`sparseCheckoutSkill`:** for `skillPath === ''` (root skill): no sparse-checkout —
`git -C <fetchDir> checkout -q --detach FETCH_HEAD` (120 s), return `fetchDir`. Otherwise:
`git -C <fetchDir> sparse-checkout set --cone <skillPath>` (10 s) then the same detached checkout
(120 s) — blobs are fetched lazily for the selected subtree only — return
`join(fetchDir, skillPath)`. Non-zero exit → `sourceUnresolvableError` with the stderr tail.

**`resolveRefViaLsRemote`:** `ref` matching `/^[0-9a-f]{40}$/` → `ok(ref)` with **zero** exec
calls (the fully-offline elision path). Else `git ls-remote <cloneUrl> <ref ?? 'HEAD'>` (10 s):
choose the exact `refs/tags/<ref>` line, else `refs/heads/<ref>`, else the first line (HEAD);
return its 40-hex SHA. No match or non-zero exit → `ok(null)` (callers fall back to the full
fetch; ls-remote failure is not itself an error).

**`sweepFetchOrphans`:** list `<dataDir>/.fetch` (absent → return); for each entry with
`modifiedAt` older than **60 minutes**, `removeTree`; swallow all errors (best-effort). The age
guard is deliberate (deviation from sweep-all `.staging`): `.fetch` dirs are also created by
**unlocked `--dry-run`** fetches, and a sweep-all would delete a concurrent dry-run's working dir
mid-scan. Callers run this at the start of every locked install/uninstall batch.

`acquire/resolve.ts`:

```ts
export const matchCandidates = (all: readonly CandidateSkill[],
  selector: SourceSpec['selector']): CandidateSkill[];
// whole-repo → all; name → candidates whose `name` equals it (case-sensitive);
// path → the candidate whose `path` equals it exactly ([] when absent)

export const selectSkill = (matches: readonly CandidateSkill[], scanned: number,
  pick?: (cands: readonly CandidateSkill[]) => Promise<CandidateSkill | null>,
): Promise<Selection>;
// 0 → { kind: 'none', searched: scanned }
// 1 → { kind: 'chosen' }
// >1 with pick: pick(matches) → non-null = chosen; null (user cancelled) = ambiguous
// >1 without pick → ambiguous (non-TTY / --json / --no-prompt never guesses — R2)
```

- [ ] **Step 1: Failing fetch tests** (`fetch.test.ts`, `defaultScanEnv()` + `RemoteFixture` +
  mkdtemp fetch dirs):
  - HEAD fetch of `multiUrl` → `sha === multiHead`; the fetch is blobless: before any checkout,
    `plugins/fh/skills/factor-scan/SKILL.md` does NOT exist under the fetch dir.
  - tag ref `v1.0.0` → `sha === multiTagSha`; full-SHA ref `multiTagSha` fetches directly →
    same sha.
  - bad ref (`v9.9.9`) → `err` code `source-unresolvable`, message contains a git stderr
    fragment; nothing exists outside the fetch dir.
  - unreachable URL (`file:///nonexistent/<random>.git`) → `source-unresolvable`, and a second
    identical call fails identically (deterministic offline).
  - `lsTreeSkills` on the multi fetch → candidates exactly
    `{plugins/web/skills/review, plugins/api/skills/review, plugins/fh/skills/factor-scan}`
    (no `docs`, no `.internal/skills/hidden`); on the root fetch → one candidate with
    `path === ''`.
  - `sparseCheckoutSkill(…, 'plugins/fh/skills/factor-scan')` → returned dir contains `SKILL.md`,
    `bin/run.sh` (exec bit preserved), `link.md` (still a symlink, literal target `SKILL.md`);
    `plugins/api/skills/review/SKILL.md` is NOT materialized. Root-skill checkout returns the
    fetch dir containing `SKILL.md`.
  - `resolveRefViaLsRemote`: 40-hex → returns it with zero exec calls (assert via a counting
    `exec` wrapper); tag → `multiTagSha`; unknown ref → `ok(null)`; unreachable URL → `ok(null)`.
  - `sweepFetchOrphans`: plant `<data>/.fetch/old` (backdate via `node:fs/promises` `utimes` to
    2 h ago) and `<data>/.fetch/fresh` → only `old` removed.
- [ ] **Step 2: Failing resolver tests** (`resolve.test.ts`, pure — candidate literals):
  R1 name depth matching (name `review` → 2 matches); R2 multi-match → `ambiguous` without pick;
  scripted pick chooses → `chosen`; scripted pick returns null → `ambiguous`; R3 single candidate
  → `chosen`; zero → `{ kind: 'none', searched }`; path selector exact match and miss.
- [ ] **Step 3: Implement** `fetch.ts`, `resolve.ts`, the `modifiedAt` primitive + mechanical
  stub updates (compile-clean proves every literal found).
- [ ] **Step 4: Verify and commit.**

```bash
git add -A packages/core packages/cli/tests
git commit -m "feat(core): add blobless fetch pipeline and skill resolver for install" \
  -m "git init/fetch --filter=blob:none --depth 1/ls-tree/sparse-checkout via env.exec with" \
  -m "GIT_TERMINAL_PROMPT=0 and timeouts; ref->SHA via FETCH_HEAD or ls-remote; candidate scan" \
  -m "excludes dot segments; .fetch orphan sweep with 60-minute age guard; env gains modifiedAt."
```

**Automated verification:** `bun test packages/core/tests/acquire` · `bunx tsc --noEmit` ·
`bun run lint:boundaries`

---

## Task 5 [P09-T04] — Ledger additive schema, journal widening, acquisition swap ops, hygiene sweep (model: opus — **HIGHEST-RISK TASK: fable task-review**)

**Consumes:** Tasks 1–4 types; the P12 engine (`place/swap.ts`), ledger, store; the fleet +
`crashingEnv` harnesses.

This task makes the P12 swap engine speak `install`/`uninstall` while staying byte-for-byte
behavior-preserving for promote/dev/rollback, and widens the ledger additively. The §8.3/§9.1
phase protocols and the crash tables below ARE the test oracle.

**Files:**
- Modify: `packages/core/src/place/types.ts`, `packages/core/src/place/ledger.ts`,
  `packages/core/src/place/swap.ts`
- Modify: `packages/core/src/place/run.ts` (ONLY: call the hygiene sweep in the two locked-batch
  sites, directly after the existing `sweepStaging(env, storeRoot)` calls)
- Create: `packages/core/tests/place/ledger-additive.test.ts`,
  `packages/core/tests/place/swap-acquire.test.ts`,
  `packages/core/tests/place/crash-sweep-acquire.test.ts`
- Create: `packages/core/tests/fixtures/place/ledger-install.golden.json`

### Type additions (append to `place/types.ts` — exact)

```ts
export type AcquireOp = 'install' | 'uninstall';
export type JournalOp = FlipOp | AcquireOp;   // Journal.op becomes JournalOp; FlipOp is NOT widened

export interface OriginRecord {
  source: string;              // the literal user argument ('smorinlabs/smorinlabs-harness/factor-scan')
  host: string;                // 'github.com'
  repo: string;                // UNCLAMPED repo path (subgroups keep their '/')
  skillPath: string;           // repo-relative git tree path; '' for a root skill
  refRequested: string | null; // '@ref' / --ref as given; null = HEAD default
  refResolved: string;         // always the full 40-hex SHA
  pin: boolean;                // --pin policy marker
  installedAt: string;
}
```

Field changes (all additive/optional — old records parse unchanged):

```ts
// PinnedRecord gains:
placement?: 'symlink' | 'copy';   // absent = 'copy' (every P12-written record)
// PairRecord gains:
origin?: OriginRecord;            // written only by install
// Journal.op: JournalOp  (was FlipOp)
// Journal.before becomes:
before:
  | { mode: 'dev'; symlinkTarget: string; liveKind?: 'symlink' | 'dir' }
  | { mode: 'pinned'; storePath: string | null; contentHash: string | null;
      liveKind?: 'symlink' | 'dir' }
  | { mode: 'absent' };
// LedgerFile gains:
projects?: Record<string, {       // key = project root, REALPATH basis
  skills: Record<string, { tools: Partial<Record<FlipTool, PairRecord>> }>;
}>;
// SwapPlan: op widens to 'promote' | 'dev' | 'install' | 'uninstall'; gains:
scopeKey?: string | null;         // realpath project key; null/undefined = user-scope `skills` tree
install?: { build: 'symlink' | 'copy'; storePath: string; contentHash: string;
            pinned: PinnedRecord; origin: OriginRecord; adoptedDev: DevRecord | null };
// (op 'uninstall' needs no payload — the engine reads the pair record.)
```

The on-disk `store-linked` class is **not** a new ledger mode: the pair records `mode: 'pinned'`
and `pinned.placement: 'symlink'` — the run layers map (`pinned` + `placement: 'symlink'`) ⇔
on-disk store symlink. `classifyPlacement` is untouched.

### Ledger changes (`place/ledger.ts` — exact)

- Zod: `PinnedRecordSchema` + `placement: z.enum(['symlink','copy']).optional()`;
  `PairRecordSchema` + `origin: OriginRecordSchema.optional()`; `JournalSchema.op` →
  `z.enum(['promote','dev','rollback','install','uninstall'])`; the `before` union gains
  `liveKind: z.enum(['symlink','dir']).optional()` on both existing variants and a third
  `z.object({ mode: z.literal('absent') })`; `LedgerSchema` +
  `projects: z.record(z.string(), z.object({ skills: <same shape as top-level skills> })).optional()`.
- Scoped accessors (exact; `getPair`/`setPair` stay as user-scope wrappers so every P12 call site
  is untouched):

```ts
export const getPairAt = (l: LedgerFile, scopeKey: string | null, skill: string,
  tool: FlipTool): PairRecord | null;
export const setPairAt = (l: LedgerFile, scopeKey: string | null, skill: string,
  tool: FlipTool, rec: PairRecord): void;   // creates the projects subtree on demand
export const deletePairAt = (l: LedgerFile, scopeKey: string | null, skill: string,
  tool: FlipTool): void;                    // prunes empty tools/skills/projects containers
```

### Swap engine changes (`place/swap.ts` — behavior-preserving for P12 ops)

All ledger pair access inside the engine routes through `getPairAt`/`setPairAt`/`deletePairAt`
with `plan.scopeKey ?? null`; `resumeSwap`/`rollbackSwap` gain a trailing optional
`scopeKey?: string | null` parameter (default null — every P12 call site compiles unchanged).

1. **`before` computation in `runSwap`:** probe `pathKind(placementPath)` once.
   - op `'install'`: `'absent'` → `before = { mode: 'absent' }` (fresh install; **engine
     precondition:** the run layer never starts a fresh-install swap on a pair holding prior
     dev/pinned records — assert with `genericError` if violated); `'symlink'` pointing outside
     the store → `{ mode: 'dev', symlinkTarget: <readLink>, liveKind: 'symlink' }` (the run layer
     has already adopted the target into `plan.install.adoptedDev`); otherwise
     `{ mode: 'pinned', storePath: existing?.pinned?.storePath ?? null,
        contentHash: existing?.pinned?.contentHash ?? null,
        liveKind: <'symlink' | 'dir' per probe> }`.
   - op `'uninstall'`: same dev/pinned shapes with `liveKind`; a live-absent uninstall never
     reaches the engine (the run layer handles stale records / no-ops itself).
   - ops `'promote'`/`'dev'`: unchanged logic, but also record `liveKind` from the probe
     (additive; old readers ignore it; `rollbackSwap` prefers it).
2. **`buildStaging` dispatch:** op `'install'` with `build: 'symlink'` →
   `makeSymlink(storePath, stagingPath)`; with `build: 'copy'` → `copyTree(storePath → staging)`
   + `fsyncTree` + content-hash check against `plan.install.contentHash` (identical to the
   promote build). Op `'uninstall'` builds **nothing** (no staging phase).
3. **Phases — fresh install (`before: { mode: 'absent' }`):**

   ```
   P1 prepared    journal persisted (op:'install', txId, before:{mode:'absent'}, stagingPath,
                  backupPath); the pair is created carrying the staged terminal records
                  (pinned/origin/adoptedDev) behind the uncommitted journal, mode:'pinned'
                  (PairRecord.mode cannot represent absence; journal.before records the pre-state)
   P2 staged      staging built per the build shape
   P3 backed-up   persisted; the rename is a NO-OP (live absent — the existing probe skips it)
   P4 live        rename(staging → live)                    ← the ONLY visible mutation
   P5 committed   fsyncDir(skillsRoot); ONE terminal ledger write: pair terminal state
                  (mode 'pinned', pinned incl. placement, origin, dev = adoptedDev ?? retained)
                  + journal: null. No committed journal is left at rest.
   ```

   Replace install (`--force`/new rev over dev or pinned): the full P12 two-rename protocol
   (P3 renames live → backup). **P5 for acquisition ops is TWO writes:** first persist
   `phase: 'committed'` (write-ahead authorization), then reclaim the backup (symlink backups
   always unlinked — targets recorded; dir backups removed iff `contentHashOf(backup)` matches a
   store entry recorded on the pair — old pinned or new — else KEPT + warning), then the terminal
   write (pair terminal state + `journal: null`). A crash between the committed write and the
   terminal write leaves a committed `'install'` journal that the hygiene sweep finishes.
4. **Phases — uninstall (no staging, no P4):**

   ```
   P1 prepared    journal persisted (op:'uninstall', before:{mode, liveKind, …})
   P3 backed-up   persisted, then rename(live → backup)     ← live path now ABSENT
   P5 committed   persisted (backup still on disk) → reclaim backup:
                    symlink backup → removeTree (target already recorded in before/dev record);
                    dir backup → removed iff contentHashOf(backup) === pair.pinned?.contentHash,
                    else KEPT + warning (never silently destroy unmanaged/edited copies)
                  → terminal ledger write: deletePairAt (the journal disappears with the pair)
   ```

5. **`rollbackSwap`:** old physical kind = `j.before.liveKind ?? (before.mode === 'dev' ?
   'symlink' : 'dir')` (needed now that `mode: 'pinned'` can be a symlink on disk). New
   `{ mode: 'absent' }` case: remove the live entry if present (it can only be the new artifact),
   remove staging, **delete the pair record** (restoring "nothing there" — resolution 6), persist.
6. **`resumeSwap`/`reconstructPlan`:** op `'install'` reconstructs
   `{ build: pinned.placement === 'symlink' ? 'symlink' : 'copy', storePath: pinned.storePath,
   contentHash: pinned.contentHash, pinned, origin, adoptedDev: pair.dev }` from the staged pair;
   op `'uninstall'` needs no payload. On a **committed** acquisition journal, resume finishes the
   terminal transition (install → null the journal; uninstall → delete the pair) and reclaims
   residue, returning `ok({ committed: true })` — meaning residue reclaimed, NEVER a fresh
   success (Global Constraint 12).
7. **Refusal message** for an uncommitted acquisition journal (extends `refusedMessage`):
   op `'install'` → `` `a previous install of <skill> was interrupted. Run 'skillsmith promote
   --rollback <skill>' (or 'skillsmith dev --rollback <skill>') to restore the previous state, or
   re-run 'skillsmith install <origin.source ?? skill>' to complete it.` `` — analogous wording
   for `'uninstall'` with `skillsmith uninstall <skill>`.
8. **Journal hygiene sweep (new export):**

```ts
/** §8.5: finish any committed acquisition journal left by a crash between the committed write
 *  and the terminal write. Walks the user `skills` tree AND every `projects` subtree. Runs at
 *  the start of every locked batch (install, uninstall, promote, dev, rollback). Idempotent. */
export const sweepCommittedAcquireJournals = (ctx: SwapCtx):
  Promise<Result<string[], SkillSmithError>>;  // human notes for surfaced completions
```

   For each pair with `journal.phase === 'committed'` and op `'install' | 'uninstall'`: reclaim
   any staging/backup residue (same rules as P5), then install → `journal = null`, uninstall →
   `deletePairAt`; one `persist()` when anything changed. Wire into `place/run.ts`: in
   `runFlipBatch` and `runRollback`, after `sweepStaging(env, storeRoot)` and after the ledger is
   read, build a `SwapCtx` and call it (ignore the notes there; flips do not render them).

### Crash windows (test oracle — assert after EVERY injected crash)

Fresh install rows (replace rows follow P12 §8.4 verbatim):

| Crash window | Journal | Live path | rollback (`rollbackSwap`) | same-op re-run (`resumeSwap`) |
|---|---|---|---|---|
| C1–C2 (before P4) | `prepared`/`staged`/`backed-up`, before `absent` | absent | remove staging, delete pair → still absent | rebuild staging, publish, commit |
| C4 (around P4) | `live` | absent **or** new (probe) | remove new live if present, remove staging, delete pair → absent | complete publish + commit |
| C5 (before terminal write) | `live`/`committed` | new | as C4 if uncommitted; committed → refused (sweep/resume finishes) | converges; **never** reported as a fresh success |

Uninstall rows:

| Window | Journal | Live | rollback | re-run uninstall |
|---|---|---|---|---|
| after P1, before P3 rename | `prepared`/`backed-up` | present | clear journal (nothing moved) | proceed from P3 |
| after P3 rename | `backed-up`/`committed`(pre-reclaim) | absent (backup exists) | rename(backup → live), clear journal — restored | reclaim + delete pair |
| after reclaim, before terminal write | `committed` | absent | nothing to restore (backup was verified reproducible) | sweep/re-run deletes the pair |

Invariants (unchanged from P12): live is never partial; whenever live is absent before commit,
the backup exists; nothing unreproducible is deleted before the committed journal is durable;
store entries are NEVER deleted.

- [ ] **Step 1: Failing ledger tests** (`ledger-additive.test.ts` + golden):
  - Old P12 golden (`ledger.golden.json`) still parses (additive proof).
  - New golden `ledger-install.golden.json`: a pair with `mode: 'pinned'`,
    `pinned.placement: 'symlink'`, a full `origin` record (use the §12-style concrete values:
    source `smorinlabs/smorinlabs-harness/factor-scan`, host `github.com`, unclamped repo,
    skillPath `plugins/factor-harness/skills/factor-scan`, refRequested null, 40-hex refResolved,
    pin false), plus a `projects` subtree keyed by `/Users/alice/c/team-repo` holding one pair.
    `readLedger` → ok; write → parse-equal round trip.
  - Schema locks: `pinned.placement: 'link'` rejected; `journal.op: 'update'` rejected;
    `before: { mode: 'absent' }` accepted; `projects` with an unknown tool key rejected
    (the `z.enum(FLIP_TOOLS)` record constraint holds in both trees — F4 adds NO tool keys).
  - `getPairAt`/`setPairAt`/`deletePairAt`: user (null key) and project key round-trips;
    delete prunes empty containers; `getPair`/`setPair` still behave identically (P12 wrappers).
- [ ] **Step 2: Failing engine tests** (`swap-acquire.test.ts`, fleet + a store entry pre-seeded
  via `snapshotToStore` from `alphaSrc`):
  - Fresh install, build `'symlink'`: after `runSwap`, live is a symlink whose `readLink` equals
    the store path; ledger pair: mode `pinned`, `pinned.placement: 'symlink'`, `origin` present,
    `journal: null` (no committed journal at rest — assert!).
  - Fresh install, build `'copy'`: live is a real dir, content hash equals the store entry's;
    `placement: 'copy'`.
  - Fresh install into a **project** scopeKey: the pair lands under
    `ledger.projects[<key>].skills…`; the user `skills` tree is untouched.
  - Replace install over a dev symlink (plan carries `adoptedDev`): backup symlink unlinked at
    P5; terminal pair retains `dev = adoptedDev`.
  - Replace install over an edited pinned copy: backup dir KEPT (hash mismatch) + warning.
  - Uninstall of a store-symlink placement: live gone, pair deleted, store entry untouched.
  - Uninstall of a managed pinned copy: backup reclaimed on hash match; edited copy → backup
    kept + warning; pair deleted either way.
  - `runSwap` on a pair with an uncommitted `'install'` journal → `flip-refused`, message names
    `promote --rollback`, `dev --rollback`, and `skillsmith install`.
  - `resumeSwap` on a committed `'install'` journal → `ok({ committed: true })` and the journal
    is nulled (carry-forward semantics).
  - `sweepCommittedAcquireJournals`: plant a committed `'install'` journal (with backup residue)
    and a committed `'uninstall'` journal (user + project trees) → both finished, residue gone,
    notes returned. Promote/dev journals untouched.
  - P12 regression: the full existing `packages/core/tests/place` suite passes unmodified.
- [ ] **Step 3: Failing crash sweeps** (`crash-sweep-acquire.test.ts`, `crashingEnv` over every
  mutating call — the P12 `crash-sweep.test.ts` procedure verbatim, template-copy per iteration):
  run for (a) fresh symlink install, (b) fresh copy install, (c) replace install over a pinned
  copy, (d) replace install over a dev symlink, (e) uninstall of a symlink placement,
  (f) uninstall of a managed copy. After every crash: the invariants above; the rollback branch
  restores the before-state byte-identically (fresh install rollback → placement absent AND pair
  record absent); the re-run branch converges to the committed after-state; collect journaled
  phases and assert every phase window was exercised. Then the **ledger-compat probe**: freeze
  one mid-crash ledger JSON (uncommitted op `'install'`, before `absent`); assert the v0.6.0
  `readLedger` parses it, and assert an inline frozen copy of the P12-era `JournalSchema`
  (op enum `['promote','dev','rollback']`, before union without `absent`/`liveKind`) REJECTS it —
  this documents D6's adjudication: a v0.5.0 binary reading a crash-window ledger exits 3.
- [ ] **Step 4: Implement** (types → ledger → engine → sweep → run.ts wiring), driving each test
  group green in that order.
- [ ] **Step 5: Verify and commit.**

```bash
git add packages/core/src/place packages/core/tests/place packages/core/tests/fixtures/place
git commit -m "feat(core): widen swap engine and ledger for install and uninstall transactions" \
  -m "Additive ledger fields (origin, pinned.placement, projects, before.liveKind); journal ops" \
  -m "install/uninstall confined to crash windows via terminal-write nulling + hygiene sweep;" \
  -m "absent-before fresh installs, symlink/copy build dispatch, uninstall removal phases;" \
  -m "fault-injection sweeps and the v0.5.0-schema compat probe prove the crash story."
```

**Automated verification:** `bun test packages/core/tests/place` · `bunx tsc --noEmit` ·
`bun run lint:boundaries`

---

## Task 6 [P09-T05] — Store-linked flip amendment (D9) (model: sonnet)

**Consumes:** Task 5's engine + ledger fields.

P12 refused every flip on a `store-linked` placement ("managed by install; cannot occur before
P09"). P09 ships — installed placements must interop with `promote`/`dev` (PRD scenario 4)
without converting a symlink fleet into copies. P12's shipped refusal tests asserted store-linked
pairs *without records* — exactly the state that still refuses; do not weaken those.

**Files:**
- Modify: `packages/core/src/place/plan.ts`, `packages/core/src/place/run.ts`
- Create: `packages/core/tests/place/store-linked-flip.test.ts`

**Behavior table (implement exactly; "pair" = the user-scope ledger record — flips stay
user-scope-only in v0.6.0, project-scope placements are install/uninstall-only):**

| On-disk class | `promote` | `dev` |
|---|---|---|
| `store-linked`, pair has `dev` record | converge like `pinned`: source rev unchanged → `noop` ("already pinned; source unchanged"); moved → re-pin (action `updated`) that **honors `pinned.placement`** — see re-pin rule below | flip to the recorded dev source (normal dev swap; the live symlink backup is unlinked at P5 via `before.liveKind: 'symlink'`); `pinned` + `origin` retained (D5) |
| `store-linked`, pair exists, no `dev` record, no `--source` | `noop` route does NOT apply — refuse only when convergence needs a source: with a pinned record and no dev source it is already production → `noop` ("already pinned; no dev source recorded") | `refused`: `no recorded dev source; pass --source <path>` (existing message) |
| `store-linked`, NO pair record (hand-made symlink into the store) | `refused` (exit 2): `managed state missing; reinstall with 'skillsmith install --force'` | `--source <path>` adopts it (records everything it needs); without `--source` → the same managed-state-missing refusal |

**Re-pin rule (the heart of D9):** wherever promote re-materializes production — the
store-linked convergence above AND the plain promote of a dev symlink whose pair carries
`pinned.placement: 'symlink'` (the install → `dev --source` → `promote` loop) — the final swap
must re-create a store **symlink**, not a copy: build the new `PinnedRecord` with
`placement: 'symlink'`, then run the swap with `op: 'install'`,
`install: { build: 'symlink', storePath: <new snapshot path>, contentHash, pinned, origin:
existing.origin, adoptedDev: devRecord }` instead of the `promote` op. `origin` is retained
**verbatim** (it records acquisition; `pinned.rev` moving is expected). When the pair has no
`origin` or `pinned.placement !== 'symlink'`, the existing copy-based `promote` op runs unchanged.

**`place/plan.ts` changes:** store-linked placements surface into the plan for named/path targets
(they are no longer filtered by `isFlippableClass`) — the run layer decides per the table.
`--all` sets are **unchanged** (promote `--all` = dev-class placements; dev `--all` =
pinned-class with a recorded source; extending `--all` to store-linked is out of scope — a
deliberate reading of the spec, which amends only the targeted-flip paths). Explicit `--tool`
with only a recordless store-linked placement keeps the `placement-not-found` preResult but the
reason must now name the reinstall remediation.

**`place/run.ts` changes:** `runPromotePair` treats `placement.class === 'store-linked'` like the
`pinned` branch (requires `existing?.dev` for a re-pin; convergence rev compare unchanged) with
the re-pin rule above; `runDevPair` treats it like the `pinned` branch (recorded source or
`--source`; adoption of a recordless store-linked placement via `--source` builds the DevRecord
and proceeds). `predictPair` (dry-run) mirrors both. The dev-swap `before` for a store-linked
placement is `{ mode: 'pinned', storePath, contentHash, liveKind: 'symlink' }` — Task 5's engine
already unlinks the symlink backup instead of hash-guarding a dir.

- [ ] **Step 1: Failing tests** (`store-linked-flip.test.ts`, fleet + seeded store entry +
  install-shaped pair records built directly with `setPair` — no dependency on Task 7):
  - Seed: snapshot `alphaSrc` to the store; place `home/.claude/skills/alpha-inst` as a symlink
    to the store entry; write a pair record (mode `pinned`, `placement: 'symlink'`, `origin`,
    `dev` = a record pointing at `alphaSrc`).
  - `runDev` on it → live becomes a symlink to `alphaSrc`; `pinned` + `origin` retained; the old
    store symlink backup is gone (unlinked, no hash warning).
  - Commit a change in the fixture checkout, then `runPromote` → action `updated`; live is a
    **store symlink again** (readLink targets the NEW store entry); `pinned.placement` still
    `'symlink'`; `origin` retained verbatim (deep-equal to the seeded record); rev changed.
  - `runPromote` with the source unchanged → `noop`.
  - Recordless store-linked (`slink` hand-made, no pair): `runPromote` → `refused` with
    `managed state missing; reinstall with 'skillsmith install --force'` (exit contribution 2);
    `runDev` without `--source` → same refusal; `runDev --source <alphaSrc>` → flipped, records
    adopted.
  - Copy-placement pairs (`placement` absent) still promote via the copy path (P12 behavior —
    assert one existing-style promote is unchanged).
  - Dry-run predictions mirror the real actions for the store-linked cases.
- [ ] **Step 2: Implement** `plan.ts` + `run.ts` changes.
- [ ] **Step 3: Verify** — new file green AND the full flip suites stay green:
  `bun test packages/core/tests/place packages/cli/tests`.
- [ ] **Step 4: Commit.**

```bash
git add packages/core/src/place packages/core/tests/place/store-linked-flip.test.ts
git commit -m "feat(core): let promote and dev flip store-linked placements per their records" \
  -m "D9: dev accepts store-linked with a recorded source or --source; promote converges and" \
  -m "re-pins honoring pinned.placement (store symlink stays a symlink, origin retained);" \
  -m "recordless store-linked stays refused with reinstall guidance."
```

**Automated verification:** `bun test packages/core/tests/place` · `bunx tsc --noEmit` ·
`bun run lint:boundaries`

---

## Task 7 [P09-T06] — Install orchestrator (`runInstall`) (model: opus)

**Consumes:** everything from Tasks 1–6.

**Files:**
- Create: `packages/core/src/acquire/run.ts`
- Modify: `packages/core/src/acquire/types.ts` (append options/report/deps types)
- Modify: `packages/core/src/errors.ts` (one new variant), `packages/cli/src/util/exit-codes.ts`
  (map it — keeps the exhaustive switch compiling)
- Create: `packages/core/tests/acquire/install-run.test.ts`,
  `packages/core/tests/acquire/install-gate.test.ts`

**Error addition (exact):** append to the `SkillSmithError` union
`| { code: 'tool-unavailable'; message: string }` with constructor
`toolUnavailableError(message)`; extend the CLI switch: `tool-unavailable` → 4.

### Types (append to `acquire/types.ts` — exact; the JSON contract in Task 9 mirrors these)

```ts
import type { InstallRecord } from '../agents/types.ts';
import type { FlipTool, JournalPhase } from '../place/types.ts';

export type InstallScope = 'user' | 'project';
export type InstallAction =
  | 'installed' | 'updated' | 'repaired' | 'noop' | 'skipped' | 'refused' | 'failed';

export interface InstallOptions {
  sources: readonly string[];
  tools?: readonly FlipTool[];       // explicit --tool list; undefined = all DETECTED tools
  scope?: InstallScope;              // undefined = project inside a git work tree, else user
  ref?: string;                      // --ref; only valid with exactly one source
  pin?: boolean;
  direct?: boolean;
  force?: boolean;
  strict?: boolean;
  noVerify?: boolean;
  deep?: boolean;                    // CLI guarantees deep && noVerify never reach core
  continueOnError?: boolean;
  dryRun?: boolean;
  cwd: string;
  envVars: Record<string, string | undefined>;
  testPauseAt?: JournalPhase;        // wired only by the CLI under SKILLSMITH_E2E=1
  signal?: AbortSignal;
}

export interface InstallResult {
  source: string;                    // the literal argument this result belongs to
  skill: string | null;              // null for source-level failures (resolution 4)
  tool: FlipTool | null;             // null for source-level failures
  scope: InstallScope;
  placementPath: string | null;
  action: InstallAction;
  reason: string | null;             // human cause for skipped/refused/failed; notices otherwise
  placement: 'symlink' | 'copy' | null;
  store: { path: string; rev: string; gitSha: string; reused: boolean } | null;
  origin: { host: string; repo: string; skillPath: string; refRequested: string | null;
            refResolved: string; pin: boolean } | null;
  verify: { gate: 'passed' | 'warned' | 'failed' | 'skipped' | 'inconclusive';
            verdict: 'pass' | 'warn' | 'fail' | 'inconclusive' | null;
            mode: 'static' | 'static+deep' | null } | null;  // mode actually run for THIS tool
  candidates: string[] | null;       // `<repoPath>//<path>` re-run lines on R2/R3 ambiguity
  error?: SkillSmithError;           // CORE-ONLY: drives the CLI exit code; NOT rendered in JSON
}

export interface InstallReport {
  dryRun: boolean;
  requested: { sources: string[]; tools: FlipTool[]; explicitTools: boolean;
               scope: InstallScope; explicitScope: boolean; ref: string | null; pin: boolean;
               direct: boolean; force: boolean; verify: 'static' | 'skipped'; deep: boolean };
  results: InstallResult[];
  summary: { installed: number; updated: number; repaired: number; noop: number;
             skipped: number; refused: number; failed: number };
}

export interface InstallDeps {
  verify: typeof import('../verify/run.ts').verifyPlugin;
  detect: (env: ScanEnv, tool: FlipTool, signal?: AbortSignal)
    => Promise<Result<InstallRecord[], SkillSmithError>>;   // injectable: tests fake detection
  now: () => string;
  newTxId: () => string;                                     // 8-hex
  pick?: (candidates: readonly CandidateSkill[]) => Promise<CandidateSkill | null>;
}
```

`acquire/run.ts` exports:

```ts
export const defaultInstallDeps: Omit<InstallDeps, 'pick'>;
  // { verify: verifyPlugin, detect: (env, tool, signal) => detectTool(env, tool, signal),
  //   now: ISO clock, newTxId: randomBytes(4).toString('hex') }
export const runInstall = (env: ScanEnv, opts: InstallOptions, deps?: InstallDeps):
  Promise<Result<InstallReport, SkillSmithError>>;
```

Install hints (exit 4 messages) come from the per-agent files, referenced one line each (keeps
the per-agent boundary):

```ts
import { installHint as claudeCodeInstallHint } from '../agents/claude-code/install-hint.ts';
import { installHint as codexInstallHint } from '../agents/codex/install-hint.ts';
const INSTALL_HINTS: Record<FlipTool, string> =
  { 'claude-code': claudeCodeInstallHint, codex: codexInstallHint };
```

### Pipeline (implement exactly; per source, then per (tool, scope))

**Phase 0 — pure pre-flight (no I/O):**
1. Parse EVERY source with `parseSource`. Any failure → the whole invocation refuses before any
   I/O (resolution 3): failed sources get `refused` results carrying the parse error; all other
   sources get `skipped` (`reason: 'fail-fast'` — or their own parse error); return the report.
2. `--ref` rules: `opts.ref` with `sources.length > 1` → single `refused` result per source,
   reason `--ref is only valid with exactly one <source>`; `opts.ref` conflicting with that
   source's own `@ref` suffix → `refused` (`flip-refused`, exit 2). Otherwise `opts.ref`
   substitutes for a null `spec.ref`.

**Phase 1 — target planning (local I/O only):**
3. Project root: `git -C <cwd> rev-parse --show-toplevel` via `env.exec` (10 s) → realpath
   string, or null outside a work tree. Scope = `opts.scope ?? (projectRoot ? 'project' : 'user')`;
   `scopeKey` = scope `'project'` ? (projectRoot ?? `await env.realpath(cwd)`) : null.
   `explicitScope` = `opts.scope !== undefined`.
4. Tools: explicit `opts.tools` → `deps.detect` each; an explicitly named tool with zero
   `InstallRecord`s → per-source `refused` results with
   `toolUnavailableError(`<tool> is not detected; install it first: <INSTALL_HINTS[tool]>`)`
   (exit 4). No explicit list → detect all of `FLIP_TOOLS`, keep the detected ones (skip
   undetected silently); none detected → every source `refused` with
   `toolUnavailableError('no supported tool detected (claude-code, codex)')` (exit 4).

**Phase 2 — the locked batch** (skip the lock entirely under `dryRun`): ONE
`withLedgerLock(env, ledgerPath, …)` wrapping ALL of the following (fetch and verify included —
D13). Inside, first: `sweepStaging(env, storeRoot)` → `sweepFetchOrphans(env, dataDir)` →
`readLedger` → `sweepCommittedAcquireJournals(ctx)`.

Per source, in argument order (a **source-level** failure — fetch, ambiguity, verify block,
snapshot — marks that source's results and, without `continueOnError`, all later sources
`skipped` with `reason: 'fail-fast'`; completed placements are never rolled back):

5. **Resolve + fetch (once per source):** try elision first — `resolveRefViaLsRemote` (zero exec
   for a literal 40-hex ref); if it yields a SHA **and** the skill path is already known without
   a tree scan (an explicit `//path` selector, or a ledger `origin` matching
   (repo, refResolved=SHA) that pins `skillPath` + skill name), **and** the store already holds
   `<clampStoreNs(spec.repoPath)>/…@<sha12>/<skill>` → skip the clone; the verify gate and
   placement run against the store entry (content-hash-guaranteed identical). Otherwise:
   `fetchDir = join(dataDir, '.fetch', deps.newTxId())`; `fetchRepo` → sha; `lsTreeSkills` →
   candidates (name for path `''` = final segment of `spec.repoPath`); `matchCandidates` +
   `selectSkill(matches, scanned, deps.pick)`:
   - `none` → source-level `failed` with `sourceUnresolvableError(`'<selector>' matched no
     skills in <repoPath> @ <sha12>: searched <scanned> SKILL.md directories`)` (exit 5).
   - `ambiguous` → source-level `refused` (`flip-refused`, exit 2) with
     `candidates = matches.map(m => `<repoPath>//<m.path>`)` and reason
     `'<selector>' matches <n> skills — re-run with one of the exact paths above` (R2/R3;
     the picker only ever runs when the CLI injected `deps.pick`).
   - `chosen` → `sparseCheckoutSkill` → the fetched skill dir.
6. **Verify gate (once per (source, tool); skip when `noVerify` → gate `skipped`,
   `pinned.verify: 'skipped'`, JSON `verify: null`):**
   `deps.verify(env, { path: <fetched skill dir | store entry>, tools: [tool],
   deep: tool === 'codex' && opts.deep === true, strict: opts.strict ?? false, signal })`.
   claude-code is ALWAYS `deep: false` (`--deep` has no effect there); the JSON `verify.mode` is
   `'static+deep'` only for codex under `--deep`, else `'static'`. Blocking (identical under
   `--deep` and default; mirror P12's `runVerifyGate` mapping): `fail` → that source's placements
   for that tool are `failed` (`flipFailedError`, exit 1); `warn` → proceed (`verify: 'warned'`)
   unless `strict` (then `failed`); `inconclusive` → proceed with a notice unless `strict`.
   A blocked gate touches nothing — it runs before any journal or store write for that source.
7. **Snapshot (once per source, after the first non-blocked tool):** `snapshotToStore` with the
   fetched skill dir (or elided store entry — then `reused: true` without a copy) and a
   **pre-built provenance** (never `git remote` interrogation):
   `{ kind: 'git-clean', gitSha: sha, ns, name: clampStoreNs(spec.repoPath), repoRoot: null,
   sourceRelPath: null, remote: spec.repoPath, dirtySummary: null }`. Content mismatch at an
   existing `@<sha12>` → integrity error, exit 1 (P12 §6.3 unchanged).
8. **Place + record (per (tool, scope), each an independent journaled swap — one tool's failure
   does not skip the other):**
   a. `makeDir` the skills root (`getSkillRoots(env, scope, ctx)` — for project scope,
      `ctx.cwd = scopeKey`); classify the live path.
   b. **Codex legacy conflict (D15):** for codex, classify the skill in the legacy root
      (`~/.codex/skills` / `$CODEX_HOME/skills`); non-absent → `refused` (exit 2):
      `'<skill>' already exists in the legacy codex root <legacyRoot>. Remove it first:
      skillsmith uninstall <skill> --tool codex`. `--force` does NOT override.
   c. **Shadowing (F5):** classify the same (skill, tool) at the OTHER scope (on-disk +
      `getPairAt` on the other tree). Hit → `refused` (exit 2) printing both paths and
      `project-scope skills shadow user-scope skills of the same name for this repo`; with
      `--force` proceed and downgrade to a warning in `reason`.
   d. **Uncommitted journal on the pair** (any op) → `refused` (exit 2) with the engine's
      dual-remediation message.
   e. **Idempotence (F7/D14):** pair exists, `origin.refResolved === sha`, placement intact
      (class matches `pinned.placement` — store symlink's resolved `readLink` equals the recorded
      `pinned.storePath`, or the copy dir is present) → `noop`, reason
      `already installed at <rev>` (exit 0) — unless `--force` → re-execute as `updated`.
      Placement intact + matching the resolved store entry but the record is missing/stale →
      `repaired`: re-write the pair record only, no filesystem change. Placement exists with a
      different origin / unknown provenance and no `--force` → `refused` (exit 2) printing the
      recorded origin (or "unmanaged").
   f. **Swap:** fresh (absent, no prior records) → `runSwap` with op `'install'`,
      `before` resolves to `{ mode: 'absent' }`,
      `install: { build: opts.direct ? 'copy' : 'symlink', storePath, contentHash, pinned,
      origin, adoptedDev: null }`, `scopeKey`. Replace (`--force` / new rev): if the live entry
      is a dev symlink, first build `adoptedDev` from the live literal target (the P12 adoption
      shape: sourcePath = literal, resolvedPath = absolute resolution, git fields null,
      `recordedAt: deps.now()`) so nothing is lost. `PinnedRecord` =
      `{ storePath, rev: sha.slice(0,12), gitSha: sha, dirty: false, contentHash,
      snapshotAt: deps.now(), verify: <gate outcome>, placement: opts.direct ? 'copy' :
      'symlink' }`. `OriginRecord` = `{ source: raw, host, repo: spec.repoPath, skillPath,
      refRequested: <the '@ref'/--ref as given, null for HEAD>, refResolved: sha,
      pin: opts.pin ?? false, installedAt: deps.now() }`. Action: fresh → `installed`;
      replace/`--force` → `updated`.
9. **Cleanup:** remove the source's fetch dir on success AND failure (`removeTree`, best-effort)
   before moving to the next source.

**Dry-run (F10):** no lock, no store/ledger writes, no journal. Parse + plan targets, fetch
read-only (elision honored; fetch dir removed afterward), resolve names + SHAs, then per
(tool, scope) predict the action (shadowing/legacy/idempotence verdicts) without verifying.
`dryRun: true` in the report.

**SIGINT:** check `opts.signal?.aborted` between placements and between sources — remaining
results get `skipped` / `reason: 'interrupted'`; within a swap the engine handles it (journal
write finishes). The CLI maps an aborted signal to exit 130.

**Report:** `requested.verify` = `opts.noVerify ? 'skipped' : 'static'`; `requested.deep` =
`Boolean(opts.deep)`; summary counts each action bucket. Exit codes ride exclusively on
per-result `error` fields (batch max in the CLI).

- [ ] **Step 1: Failing gate-matrix tests** (`install-gate.test.ts`, canned verify checkers —
  the P11/P12 fake-checker pattern returning minimal `VerifyReport` literals — plus a capturing
  wrapper recording `(path, tools, deep)`): {pass, warn, fail, inconclusive} × {default,
  `strict`, `noVerify`, `deep`} → block/proceed per the table; codex called with `deep: true`
  ONLY under `opts.deep`; claude-code NEVER with `deep: true`; `verify.mode` strings; a blocked
  gate leaves ledger + skills root untouched (fetch dir cleaned).
- [ ] **Step 2: Failing run tests** (`install-run.test.ts`, fleet + RemoteFixture, injected
  deps: gatePass, `detect` faking both tools detected, scripted `pick` where stated):
  - Fresh install (`<multiUrl>//plugins/fh/skills/factor-scan`, user scope, both tools):
    placements are store symlinks in `~/.claude/skills` + `~/.agents/skills`; ledger pairs carry
    `pinned.placement: 'symlink'` and a full `origin` (assert every field incl. unclamped repo
    and literal source); exec bit + relative symlink preserved in the store entry; store shared
    (`reused: true` on the second tool's result).
  - `--direct` → real dir placements, `placement: 'copy'`, content hash equals the store entry.
  - Idempotent re-run → both `noop`, exit-0-class; `--force` same rev → `updated`;
    `--ref v1.0.0 --force` → `updated` at the tag's rev (deliberate downgrade, scenario 5).
  - `repaired`: delete the ledger pair between runs, placement intact → action `repaired`, no fs
    mutation (capture mutating calls with a counting env).
  - Project scope: run with `cwd` inside `fleet.project` → placements under
    `<project>/.claude/skills`; pair recorded under `ledger.projects[<projectReal>]` (REALPATH
    key asserted); default scope is `project` there and `user` outside a work tree.
  - Shadowing: same skill at user scope, then project-scope install → `refused` listing both
    paths; `--force` → proceeds + warning.
  - Codex legacy conflict: plant `~/.codex/skills/<skill>` → codex placement `refused` with the
    uninstall-first message even under `--force`; claude-code placement proceeds.
  - Explicit `--tool codex` with `detect` returning `[]` → `refused` + `tool-unavailable`,
    message contains `npm install -g @openai/codex`; auto mode with one detected tool installs
    for that tool only, silently.
  - Ambiguity: `<multiUrl>` bare (3 skills) without pick → source `refused`,
    `candidates` lists all three `//path` lines; with scripted pick → chosen path installs.
    Name `review` (2 matches) → same refusal shape (R2).
  - Batch: `[bad-parse-source, <multiUrl>//…]` → whole invocation refused pre-I/O (resolution 3).
    `[<multiUrl>//…valid, file:///nonexistent.git//x]` → first installs, second `failed` exit-5
    class; reversed order without `continueOnError` → later source `skipped`/`fail-fast`; with
    `continueOnError` → both attempted.
  - Fetch elision: seed the store + a pair with `origin` at `multiTagSha`, uninstall-shaped
    removal of the placement dir, then re-install `<multiUrl>//plugins/fh/skills/factor-scan@<multiTagSha>`
    with a **fetch-forbidding env** (exec wrapper that fails on `fetch`) → succeeds offline
    (ls-remote skipped for the literal SHA).
  - Dry-run: no lock file activity, ledger absent afterward, fetch dir cleaned, actions
    predicted.
- [ ] **Step 3: Implement** (`errors.ts` + exit map first, then `run.ts` top-down), driving the
  suites green.
- [ ] **Step 4: Verify and commit.**

```bash
git add packages/core/src/acquire packages/core/src/errors.ts packages/cli/src/util/exit-codes.ts packages/core/tests/acquire
git commit -m "feat(core): add runInstall acquisition orchestrator" \
  -m "Batch install under one ledger lock: parse-all pre-flight, detection with install hints," \
  -m "fetch elision, static verify gate with opt-in --deep (codex static+deep), pre-built" \
  -m "provenance snapshots, shadowing/legacy refusals, convergent noop/updated/repaired," \
  -m "project-scope pairs keyed by realpath, per-source fetch-dir cleanup."
```

**Automated verification:** `bun test packages/core/tests/acquire packages/core/tests/place` ·
`bunx tsc --noEmit` · `bun run lint:boundaries`

---

## Task 8 [P09-T07] — Uninstall orchestrator + public API (model: sonnet)

**Consumes:** Tasks 5–7 (engine ops, scoped accessors, `acquire/run.ts`).

**Files:**
- Modify: `packages/core/src/acquire/run.ts` (append `runUninstall` + target resolution),
  `packages/core/src/acquire/types.ts` (append uninstall types)
- Modify: `packages/core/src/index.ts`, `packages/core/src/public-types.ts`,
  `packages/core/tests/public-api.test.ts`
- Create: `packages/core/tests/acquire/uninstall-run.test.ts`

### Types (append to `acquire/types.ts` — exact)

```ts
export type UninstallAction = 'removed' | 'noop' | 'refused' | 'failed';

export interface UninstallOptions {
  targets: readonly string[];        // skill names (leaf dir names) or placement paths
  tools?: readonly FlipTool[];       // restrict; undefined = every tool where the skill is found
  scope?: InstallScope;              // restrict to one scope
  allScopes?: boolean;               // user scope AND the current project's scope
  force?: boolean;
  dryRun?: boolean;
  cwd: string;
  envVars: Record<string, string | undefined>;
  testPauseAt?: JournalPhase;
  signal?: AbortSignal;
}

export interface UninstallResult {
  skill: string;
  tool: FlipTool | null;             // null only when a target matched nothing anywhere
  scope: InstallScope | null;
  placementPath: string | null;
  action: UninstallAction;
  reason: string | null;
  before: { mode: 'dev' | 'pinned'; placement: 'symlink' | 'copy' | null;
            storePath: string | null; symlinkTarget: string | null } | null;
  storeRetained: string | null;      // surviving store path — "where did my bytes go"
  backupKept: string | null;         // path of a preserved unreproducible copy
  error?: SkillSmithError;           // CORE-ONLY, as install
}

export interface UninstallReport {
  dryRun: boolean;
  requested: { targets: string[]; tools: FlipTool[]; explicitTools: boolean;
               scope: InstallScope | null; allScopes: boolean; force: boolean };
  results: UninstallResult[];
  summary: { removed: number; noop: number; refused: number; failed: number };
}

export interface UninstallDeps { now: () => string; newTxId: () => string; }
```

`acquire/run.ts` exports: `defaultUninstallDeps` and
`runUninstall(env, opts, deps?): Promise<Result<UninstallReport, SkillSmithError>>`.

### Semantics (implement exactly)

Uninstall needs **no binary detection** — it operates on directories and the ledger. One
`withLedgerLock` per invocation (dry-run lockless), with the same opening sweeps as install
(`sweepStaging`, `sweepFetchOrphans`, `sweepCommittedAcquireJournals`).

1. **Search set (U2):** with no scope flag — user scope + the current project's scope (project
   root per Task 7 phase-1 rule) + the codex legacy root. `--scope` restricts to one;
   `--all-scopes` = user + current project (other projects' records are reachable only via
   `-C <dir>`). Per target:
   - a **path** target (contains `/`, or `./`/`../`, or absolute): resolve against `cwd`;
     owning (tool, scope, root) = the root whose `dirname` matches — claude-code user/project,
     codex current user/project, codex legacy (with the P12 legacy notice). Outside every root →
     `refused` (`flip-refused`, exit 2).
   - a **name** target: classify it in every root of the search set AND look it up in the ledger
     (user tree + the current project's subtree). "Found" = a non-absent placement or a ledger
     pair.
2. **Ambiguity (U2):** found in more than one scope (and neither `--scope` nor `--all-scopes`
   given) → ONE `refused` result per target (exit 2) whose reason lists every
   `(scope, tool, path)` match and names the disambiguators (`--scope`, `--tool`,
   `--all-scopes`). Found in exactly one scope → remove there (all matched tools, unless
   `--tool` restricts). Found nowhere → `noop`, exit 0, reason
   `'<skill>' is not installed anywhere skillsmith manages` (convergent — D12).
3. **Refusals before any journal write (per (skill, tool, scope)):**
   - dev-mode placement without `--force` → `refused` (exit 2):
     `'<skill>' (<tool>) is in dev mode — a live symlink into a working checkout. Run
     'skillsmith promote <skill>' to pin it first, or 'skillsmith dev --rollback <skill>' to
     restore the pinned copy, or pass --force to remove the symlink — the checkout itself is
     never touched.` With `--force`: remove the symlink only; the report prints the target.
   - placement with no ledger pair (unmanaged) without `--force` → `refused` (exit 2):
     `'<skill>' (<tool>) has no skillsmith record; pass --force to remove it anyway`. With
     `--force`: dir backups not hash-matched to a store entry are KEPT + warning (engine rule).
   - pair with an uncommitted journal → `refused` (exit 2, the engine's dual-remediation
     message).
4. **Removal:** `runSwap` with op `'uninstall'` + `scopeKey` (Task 5's P1→P3→P5 protocol: backup
   rename, reclaim-or-keep, pair deleted in the terminal write). The result's `before` mirrors
   the pre-op state (`placement` from `pinned.placement ?? null`, `symlinkTarget` for dev/
   store-linked); `storeRetained` = `pinned.storePath` when the pair had one (store entries are
   NEVER deleted); `backupKept` from the swap outcome.
5. **Stale pair** (ledger pair exists, placement absent): delete the record directly
   (`deletePairAt` + persist), action `removed`, reason `placement was already gone`.
6. **Legacy root:** placements there are first-class removable; the result carries the P12
   legacy notice in `reason`. **Dry-run (U4):** no lock, no writes; predict every action.
   `--yes` is CLI-level (uninstall never prompts). Batch exit = max per-result code.

### Public API (core `index.ts` / `public-types.ts` / `public-api.test.ts`)

Runtime exports: `runInstall`, `runUninstall`, `defaultInstallDeps`, `defaultUninstallDeps`,
`parseSource`. Type exports: `SourceSpec`, `CandidateSkill`, `InstallScope`, `InstallAction`,
`InstallOptions`, `InstallResult`, `InstallReport`, `InstallDeps`, `UninstallAction`,
`UninstallOptions`, `UninstallResult`, `UninstallReport`, `UninstallDeps`, `OriginRecord`. Add
the runtime names to the public-api test's expected set. Fetch/resolve internals stay unexported
(core tests import them relatively).

- [ ] **Step 1: Failing tests** (`uninstall-run.test.ts`, fleet + seeded installs built by
  calling `runInstall` with injected deps — Task 7 is in place):
  - Managed store-symlink removal: placement gone, pair deleted, store entry still on disk,
    `storeRetained` set, `before.placement === 'symlink'`.
  - Managed `--direct` copy removal: backup reclaimed on hash match; edited copy → `backupKept`
    + warning, still removed.
  - U2 ambiguity: same skill installed at user AND project scope → `refused` listing both;
    `--scope user` removes only the user one; `--all-scopes` removes both.
  - U3 dev-mode: flip a placement to dev first (`runDev`) → uninstall `refused` with the
    promote/dev-rollback/--force guidance; `--force` removes the symlink, checkout untouched
    (source dir still exists), target printed.
  - Unmanaged: fleet's hand-copied `copied` dir → `refused`; `--force` → removed, backup KEPT
    (no store entry to match) + warning.
  - Absent everywhere → `noop`, exit-0 class, notice. Stale pair → `removed` +
    `placement was already gone`.
  - Legacy root: fleet's `~/.codex/skills/legacy-only` (dev symlink) with `--force` → removed
    from the legacy root, legacy notice in `reason`.
  - Path target: `~/.claude/skills/<skill>` resolves tool + scope; a path outside every root →
    `refused`.
  - Uncommitted journal on the pair → `refused` naming both remediations.
  - Dry-run writes nothing (ledger byte-identical afterward).
- [ ] **Step 2: Implement** `runUninstall` + exports; update `public-api.test.ts`.
- [ ] **Step 3: Verify and commit.**

```bash
git add packages/core/src/acquire packages/core/src/index.ts packages/core/src/public-types.ts packages/core/tests
git commit -m "feat(core): add runUninstall and export the acquisition public API" \
  -m "Scope-aware target resolution (user + project + codex legacy), U2 ambiguity listing," \
  -m "U3 dev-mode and unmanaged refusals gated by --force, journaled removal deleting the" \
  -m "pair while store entries survive; runInstall/runUninstall/parseSource exported."
```

**Automated verification:** `bun test packages/core/tests/acquire packages/core/tests/public-api.test.ts` · `bunx tsc --noEmit` · `bun run lint:boundaries`

---

## Task 9 [P09-T08] — CLI commands, picker, renderers, JSON contracts (model: sonnet)

**Consumes:** Tasks 7–8 core surface. CLI patterns: copy `commands/promote.ts` (local
`exitOverride` mapping, `collectTool`, `isJournalPhase`/`SKILLSMITH_TEST_PAUSE_AT` wiring,
stderr blocks for refused/failed, `process.exit(signal?.aborted ? 130 : code)`).

**Files:**
- Modify: `packages/cli/package.json` — `bun add @clack/prompts` (workspace `packages/cli`;
  stack-approved, see preamble resolution 2)
- Create: `packages/cli/src/commands/install.ts`, `packages/cli/src/commands/uninstall.ts`,
  `packages/cli/src/output/install-human.ts`, `packages/cli/src/output/install-json.ts`,
  `packages/cli/src/util/acquire-exit.ts`
- Modify: `packages/cli/src/program.ts` (register both after `devCommand`),
  `packages/cli/src/help/topics.ts` (exit-codes + sources topics)
- Create: `packages/cli/tests/commands/install.test.ts`,
  `packages/cli/tests/commands/uninstall.test.ts`,
  `packages/cli/tests/output/install-json.test.ts`,
  `packages/cli/tests/output/install-human.test.ts`,
  `packages/cli/tests/fixtures/install-report.golden.json`,
  `packages/cli/tests/fixtures/uninstall-report.golden.json`

### CLI surface (frozen — from `research/commands/install.md` / `uninstall.md`)

```
skillsmith install   <source>[@<ref>] [<source>...]
                     [-t|--tool claude-code|codex]... [-s|--scope user|project | --user | --project]
                     [--ref <ref>] [--pin] [--direct] [-f|--force]
                     [--strict] [--no-verify] [--deep]
                     [--continue-on-error] [--dry-run] [--json] [-y|--yes] [--no-prompt]
skillsmith i         …            # .alias('i')

skillsmith uninstall <skill>... [-t|--tool claude-code|codex]...
                     [-s|--scope user|project | --user | --project] [--all-scopes]
                     [-f|--force] [--dry-run] [--json] [-y|--yes]
skillsmith rm | remove …          # .aliases(['rm', 'remove'])
```

Usage rules (exit 2 in the CLI action before core runs):
- install: ≥1 source; `--user` + `--project` together, or either combined with a contradicting
  `--scope` → error; `--deep` with `--no-verify` → error naming both flags (the flags contradict:
  opt into a deeper gate vs. skip the gate); `--scope system` → `.choices()` rejection with the
  spec's "deferred" wording in the option description. (`--ref` count/conflict rules live in
  core — they need parsed sources.)
- uninstall: ≥1 target; the same scope-flag contradiction rule; `--all-scopes` with `--scope` →
  error.
- `--tool` keeps `.choices(['claude-code','codex'])` + `collectTool` (the completion
  declaration-gate test requires `.choices()` on pipe-separated enums; same for `--scope`).
- `--yes` / `--no-prompt` accepted; `--yes` is a no-op (the picker is a choice, not a
  confirmation — it must NEVER auto-pick under `--yes`).

**Picker wiring (D4):** `deps.pick` is injected ONLY when
`process.stderr.isTTY && process.stdin.isTTY && !opts.json && !noPrompt`. Implementation with
`@clack/prompts`: `select({ message: '<n> skills found in <repo> — which one?', options:
candidates.map(c => ({ value: c, label: c.name, hint: `//${c.path}` })) })`; `isCancel(result)`
→ return null (core turns it into the exit-2 ambiguity refusal). Otherwise `pick` is absent and
ambiguity is a refusal listing candidates.

### JSON contracts (exact — zod-validated before writing, pattern of `flip-json.ts`)

`renderInstallJson(report)` emits:

```jsonc
{
  "schemaVersion": 1,
  "kind": "skillsmith.install",
  "dryRun": false,
  "requested": { "sources": ["…"], "tools": ["claude-code", "codex"], "explicitTools": false,
                 "scope": "user", "explicitScope": false, "ref": null, "pin": false,
                 "direct": false, "force": false, "verify": "static", "deep": false },
  "results": [{
    "source": "smorinlabs/smorinlabs-harness/factor-scan",
    "skill": "factor-scan",                // null for source-level failures
    "tool": "claude-code",                 // null for source-level failures
    "scope": "user",
    "placementPath": "/Users/alice/.claude/skills/factor-scan",
    "action": "installed",                 // installed|updated|repaired|noop|skipped|refused|failed
    "reason": null,
    "placement": "symlink",                // 'symlink' | 'copy' | null
    "store": { "path": "…@8c1d2e3f4a5b/factor-scan", "rev": "8c1d2e3f4a5b",
               "gitSha": "<40hex>", "reused": false },
    "origin": { "host": "github.com", "repo": "smorinlabs/smorinlabs-harness",
                "skillPath": "plugins/factor-harness/skills/factor-scan",
                "refRequested": null, "refResolved": "<40hex>", "pin": false },
    "verify": { "gate": "passed", "verdict": "pass", "mode": "static" }, // null when gate skipped
    "candidates": null                     // string[] of //path re-run lines on ambiguity
  }],
  "summary": { "installed": 1, "updated": 0, "repaired": 0, "noop": 0,
               "skipped": 0, "refused": 0, "failed": 0 }
}
```

`renderUninstallJson(report)` emits:

```jsonc
{
  "schemaVersion": 1,
  "kind": "skillsmith.uninstall",
  "dryRun": false,
  "requested": { "targets": ["factor-scan"], "tools": ["claude-code", "codex"],
                 "explicitTools": false, "scope": null, "allScopes": false, "force": false },
  "results": [{
    "skill": "factor-scan", "tool": "claude-code", "scope": "user",
    "placementPath": "/Users/alice/.claude/skills/factor-scan",
    "action": "removed",                   // removed|noop|refused|failed
    "reason": null,
    "before": { "mode": "pinned", "placement": "symlink",
                "storePath": "…@8c1d2e3f4a5b/factor-scan", "symlinkTarget": null },
    "storeRetained": "…@8c1d2e3f4a5b/factor-scan",
    "backupKept": null
  }],
  "summary": { "removed": 1, "noop": 0, "refused": 0, "failed": 0 }
}
```

Both schemas: `z.literal(1)`, `z.literal(kind)`, enums locked, nullable exactly where shown; the
core-only `error` field is dropped before rendering. `--json` output is a single JSON value on
stdout (picker disabled).

### Exit codes (`util/acquire-exit.ts`)

```ts
import type { InstallReport, UninstallReport } from '@skillsmith/core';
import { exitCodeForError } from './exit-codes.ts';
export const acquireExitCode = (report: InstallReport | UninstallReport): number =>
  report.results.reduce((mx, r) => Math.max(mx, r.error ? exitCodeForError(r.error) : 0), 0);
```

### Human output (`install-human.ts` — match the mockups in `research/commands/install.md` /
`uninstall.md`; both verbs' renderers live in this file, JSON in `install-json.ts`)

`renderInstallHuman(report, exitCode)`: per source a header
`Installing <skill>  (<repo> @ <rev>, scope: <scope>)`; per (tool) an indented block —
`<tool>  <placementPath>` then `verify   static: pass` (codex default gate additionally prints
the note `codex static checks the manifest only — run 'skillsmith verify <skill> --deep' for a
full load check`; under `--deep` print `static+deep: pass` and no note), `store    <ns>/<name>@<rev>  (new entry|reused)`,
`place    store symlink|copy` with the action word right-aligned; noop sources render the
`already installed at <rev> … Use --force to reinstall, or --ref <ref> …` block; summary line
`` `${counts}.  Exit code: ${exitCode}` `` (buckets: installed, updated, repaired, up to date
(noop), skipped, refused, failed — print non-zero buckets). `renderUninstallHuman` mirrors it
(`removed` lines + `store entry retained: <path>` + `backup kept: <path>` warnings). Refusal/
error detail blocks go to **stderr** in the command actions (not the renderers), P12 pattern —
incl. the shadowing, legacy-root, ambiguity (candidate list), and local-path blocks from the
mockups.

Help: `.addHelpText('after', …)` EXAMPLES + EXIT CODES sections copied from the research pages'
help mockups. `help/topics.ts`: exit-codes topic line 4 → `4 no placement/tool (install: tool
not detected)`, line 5 → `5 source unresolvable (dev source or install source)`; `sources` topic
rewritten to the six-form grammar block from `research/commands/install.md` §Source forms.

- [ ] **Step 1 (tests first): flag validation + wiring tests** (`install.test.ts`,
  `uninstall.test.ts`): zero sources → exit 2; `--user --project` → 2; `--deep --no-verify` → 2
  (message names both flags); `--scope system` → 2 (commander choices); bad `--tool` → 2;
  `i` alias resolves to install, `rm`/`remove` to uninstall; `--json` + TTY never constructs a
  picker (spy on the deps builder); `--yes` never auto-picks.
- [ ] **Step 2 (tests first): JSON + human renderer tests**: goldens = the two contract examples
  above with concrete values; parse-compare; schema locks (`action: 'flipped'` rejected for
  install, `kind` cross-rejected between the two schemas; `error` never appears in output);
  human substring asserts per the mockups (`verify   static: pass`, `(reused)`,
  `already installed at`, `store entry retained:`, `Exit code: 0`); `acquire-exit` max-rule
  table (0/1/2/3/4/5/6 literals).
- [ ] **Step 3: Implement** commands, picker, renderers, exit util, program registration, help
  topics. `bun add @clack/prompts` in `packages/cli` first.
- [ ] **Step 4: Smoke** — `bun run dev install --help` / `bun run dev uninstall --help` match
  the research help mockups; `bun run dev install` (no args) → exit 2;
  `bun run dev install ./local/path` → exit 2 with the `dev --source` guidance;
  `bun run dev install owner` → exit 2 R5 message; `bun run dev uninstall nope --json` →
  exit 0 with a `noop` JSON result (scratch `$SKILLSMITH_HOME`).
- [ ] **Step 5: Verify and commit.**

```bash
git add -A packages/cli bun.lock
git commit -m "feat(cli): add skillsmith install and uninstall commands" \
  -m "install (alias i) with @clack ambiguity picker (TTY-only, never under --json/--no-prompt)," \
  -m "uninstall (aliases rm/remove); versioned skillsmith.install/.uninstall JSON reports," \
  -m "human renderers per the command-doc mockups, batch-max exit codes, help topics updated."
```

**Automated verification:** `bun test packages/cli` · `bunx tsc --noEmit` ·
`bun run lint:boundaries` · `bun run check`

---

## Task 10 [P09-TS02] — Acceptance: interop round-trip, exit-code table, SIGKILL + live e2e (model: sonnet)

**Consumes:** everything shipped in Tasks 1–9. Discharges PRD §10: the five §2 scenarios
runnable, grammar table covered (Task 1), env-gated live e2e against
`smorinlabs/smorinlabs-harness`, `bun run check` green.

**Files:**
- Create: `packages/core/tests/acquire/interop-roundtrip.test.ts`
- Create: `packages/cli/tests/commands/install-exit-codes.test.ts`
- Create: `packages/cli/tests/commands/install-live.test.ts` (SIGKILL process e2e, env-gated)
- Create: `packages/cli/tests/commands/install-remote-live.test.ts` (network e2e, env-gated)

- [ ] **Step 1: Interop round-trip suite** (`interop-roundtrip.test.ts`, fleet + RemoteFixture,
  injected gatePass/detect — PRD scenario 4 at USER scope, the O1 adjudication):
  1. `runInstall('<multiUrl>//plugins/fh/skills/factor-scan')` → store symlink placement.
  2. `runDev` with `--source <multiWork>/plugins/fh/skills/factor-scan` → live is a dev symlink;
     `pinned` + `origin` retained.
  3. Edit + commit in `multiWork`, then `runPromote` → live is a **store symlink again** (D9),
     NEW rev, `origin` retained verbatim, `pinned.placement: 'symlink'`.
  4. `runDev` → `runPromote` again → lossless (`noop` on the second promote — rev unchanged).
  5. `runRollback` (op promote) → dev symlink restored byte-identically (literal target).
  6. `runUninstall --force` (dev-mode) → placement gone, pair gone, BOTH store revs still on
     disk with matching content hashes.
  Plus scenario 5 (deliberate up/downgrade): `runInstall --force --ref v1.0.0` → `updated` at
  the tag rev; `--force --ref` back to HEAD → `updated` again; both store entries coexist.
- [ ] **Step 2: Exit-code table test** (`install-exit-codes.test.ts` — drive
  `runInstall`/`runUninstall` + `acquireExitCode`, one row per §13 case):

  | Case (setup → op) | Expected exit |
  |---|---|
  | fresh install, both tools detected | 0 |
  | idempotent re-run (`noop`) / `repaired` | 0 |
  | verify `gateFail` install | 1 |
  | store integrity tamper (pre-seed entry, corrupt a file, reinstall same SHA) | 1 |
  | grammar reject (`factor-scan` one-part) | 2 |
  | R2 ambiguity, no pick | 2 |
  | shadowing without `--force` | 2 |
  | codex legacy conflict | 2 |
  | `--ref` with two sources | 2 |
  | corrupt ledger (`{"schemaVersion":` truncated) → any op | 3 |
  | explicit `--tool codex`, detect → `[]` | 4 |
  | unreachable URL / bad ref / zero-match name | 5 |
  | uninstall: U2 ambiguity / U3 dev-mode / unmanaged | 2 |
  | uninstall: absent everywhere | 0 |
  | mixed batch: one installed + one refused | 2 (max rule, both with and without `--continue-on-error`) |

- [ ] **Step 3: SIGKILL process e2e** (`install-live.test.ts`,
  `describe.skipIf(process.env.SKILLSMITH_E2E !== '1')`, 120 000 ms timeouts — extends the P12
  `flip-live.test.ts` harness):
  1. Build fleet + RemoteFixture on disk. Spawn
     `Bun.spawn(['bun', 'packages/cli/src/index.ts', 'install',
     '<multiUrl>//plugins/fh/skills/factor-scan', '--tool', 'claude-code', '--no-verify'],
     { cwd: <repo root>, env: { ...process.env, HOME: f.home, SKILLSMITH_HOME: f.data,
     SKILLSMITH_E2E: '1', SKILLSMITH_TEST_PAUSE_AT: 'live' } })` (`--no-verify` keeps the run
     free of tool CLIs; `--tool claude-code` avoids codex detection variance — the CLI's install
     action must pass `testPauseAt` exactly as promote does).
  2. Poll `f.data/placements.json` (100 ms) until the pair's `journal.phase === 'live'`, then
     `proc.kill('SIGKILL')` (kill + await exit in `finally`).
  3. Assert crashed state: live path absent or complete (never partial); journal uncommitted;
     store entry intact.
  4. Recovery A — re-run the same install (no pause var): exit 0, placement is a store symlink,
     journal null, no `.skillsmith-*` residue; the action is the convergent one (never a fresh
     `installed` reported after a committed crash — carry-forward, Global Constraint 12).
  5. Recovery B — fresh crash, then `promote --rollback factor-scan`: exit 0, placement ABSENT
     again (fresh-install rollback restores "nothing there"), pair gone.
  6. Uninstall crash: seed a completed install, SIGKILL an uninstall at `backed-up`, re-run
     uninstall → exit 0, pair gone, store intact. Lock note: the post-SIGKILL orphan lock frees
     via proper-lockfile staleness in ≤ 30 s (D17 accepted latency) — the re-run may wait; do
     not shrink the `stale` setting.
  7. Without `SKILLSMITH_E2E` the file skips and `bun run check` stays green.
- [ ] **Step 4: Network live e2e** (`install-remote-live.test.ts`, same env gate; requires
  workstation network + the real `smorinlabs/smorinlabs-harness` repo; scratch
  `HOME`/`SKILLSMITH_HOME`; `--no-verify` throughout so no tool CLIs are needed):
  - install by bare form, by name (`smorinlabs/smorinlabs-harness/<skill>`), and by explicit
    `//path` — all three resolve to the same store entry; `--json` parses with
    `kind: 'skillsmith.install'`.
  - non-TTY ambiguity: spawn with stdin not a TTY on a multi-skill selector → exit 2, stderr
    lists exact `//path` re-run lines (R2).
  - scenario-4 round-trip against a real local clone: `git clone` the repo to a temp dir, then
    `dev --source <clone>/<skillpath>` → `promote` → `dev --rollback` → `uninstall` (the PRD §10
    live acceptance, user scope).
  - `--force --ref <tag>` up/downgrade round-trip (scenario 5).
- [ ] **Step 5: Run everything** — `bun run check` green (live suites skipped);
  `SKILLSMITH_E2E=1 bun test packages/cli/tests/commands/install-live.test.ts` green locally;
  `SKILLSMITH_E2E=1 bun test packages/cli/tests/commands/install-remote-live.test.ts` green on a
  networked workstation (paste both outputs as acceptance evidence).
- [ ] **Step 6: Commit.**

```bash
git add packages/core/tests/acquire/interop-roundtrip.test.ts packages/cli/tests/commands
git commit -m "test: add P09 interop round-trip, exit-code table, and SIGKILL/live install e2e" \
  -m "install->dev->promote->uninstall lossless with store symlinks re-pinned (D9); full exit" \
  -m "table incl. batch-max; env-gated real-process SIGKILL at journal barriers with re-run and" \
  -m "rollback recovery; env-gated live e2e against smorinlabs/smorinlabs-harness (PRD 10)."
```

**Automated verification:** `bun run check` (live suites skip) · locally
`SKILLSMITH_E2E=1 bun test packages/cli/tests/commands/install-live.test.ts` · networked
`SKILLSMITH_E2E=1 bun test packages/cli/tests/commands/install-remote-live.test.ts`

---

## Integration verification (whole-branch, before P09-RV)

1. `bun run check` — biome, eslint boundaries (incl. the five new `acquire/` zones), tsc,
   actionlint, full `bun test` green with live suites skipped.
2. `SKILLSMITH_E2E=1` runs of both live suites green (Task 10 Step 5 evidence).
3. PRD §10 discharge map — confirm each: scenario 1 (fleet rebuild) = Task 10 Step 4 name-form
   install; scenario 2 (README one-liner) = same, bare form; scenario 3 (team repo) = Task 7
   project-scope + `--pin` tests; scenario 4 = Task 10 Steps 1 & 4 round-trips; scenario 5 =
   `--force --ref` tests; grammar table = Task 1; ambiguity/rejection paths = Tasks 1, 7, 10.
4. Manual smoke against a **scratch** `$HOME` (never the real one):
   `HOME=<tmp> SKILLSMITH_HOME=<tmp>/data bun run dev install <file://fixture>//… --no-verify` →
   human output matches the install mockup shape; `… uninstall <skill>` prints
   `store entry retained:`; `… install --dry-run --json | bun -e '…'` parses with
   `kind === 'skillsmith.install'`, `dryRun: true`.
5. Confirm the diff touches no release-please-managed file and `git log` shows every commit
   scope ∈ {core, cli, none}.
6. PROJECTS.md P09 checkboxes all flipped by the orchestrator; the P12 §2.2 amendment is now
   real — spot-check `skillsmith promote --help` still matches its research page.
7. PR: squash-merge titled `feat(cli): add skillsmith install and uninstall acquisition commands`
   (the commit release-please parses → v0.6.0).

## Out of scope (do not build these)

- `sync`/`apply` manifests; registries and one-part names (reserved, rejected loudly); an
  `update` verb (upgrade = `install --force --ref`); marketplace addressing; lifecycle hooks.
- Cross-tool adaptation (the April `adapted/` overlay model is dead for v1 — the store copy is
  placed as authored); kilo-code / opencode targets (their agent slots keep stubs).
- Store GC / reference counting (PRD §7 overrides P12 §1.1's forward-reference — store entries
  are immortal); `system` scope; Windows.
- `install --rollback` as a flag (recovery = re-run + the flip verbs' `--rollback`).
- Project-scope `promote`/`dev` (O1 — deferred to a follow-up project; project-scope placements
  are install/uninstall-only in v0.6.0; the scenario-4 acceptance runs at user scope).
- Codex legacy-root migration (uninstall + install IS the migration — D15); auto-migration on
  `--force` is forbidden.
- Parallel multi-source fetching (sequential, one lock); dead-PID ledger-lock detection (D17 —
  proper-lockfile's 30 s staleness is the vetted path; do not "improve" it).
- Auth/token plumbing (`SKILLSMITH_TOKEN*` deferred; git's credential machinery +
  `GIT_TERMINAL_PROMPT=0` is the whole story); configurable default host (GitHub sugar is
  hardcoded); `SKILLSMITH_TOOL`/`SKILLSMITH_SCOPE` env-var flag defaults.
- Values layering, `--set`, `--path` overrides (April-draft features not carried into v1).
- `F_FULLFSYNC`/power-loss hardening beyond the specified fsync points (P12 Global Constraint 12
  stands).
