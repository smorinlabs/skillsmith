# SkillSmith P12 design — `promote` ⇄ `dev` — bidirectional placement flip

**Status:** Draft (2026-07-07). This is the P12-BR deliverable.
**Scope:** Two new commands that flip an installed skill between **dev mode** (the tool's skill
directory holds a symlink into a local source checkout) and **production** (it holds a pinned copy
materialized from a content-addressed store). `skillsmith promote <skill>` = dev → pinned (verify →
snapshot store@rev → atomic swap → ledger record). `skillsmith dev <skill>` (**alias: `demote`**) =
pinned → dev. Round-trip is lossless — the placements ledger retains both placements — and
`--rollback` restores the prior state, including from an interrupted swap.
**Release framing:** `v0.5.0` (minor `feat` — two new commands). Internal milestone; no public release.
**Prerequisite:** `v0.4.0` (P11) shipped — `promote` gates on `verify`, and reuses its `env.exec`
subprocess primitive for git interrogation.
**Store contract:** the store this feature creates is the **seed of P09's store** (same root, same
path grammar). P09 `install` inherits it as-is; nothing P12 writes ever needs migration.
**Empirical basis:** the real fleet this must serve, inspected 2026-07-07 on the author's machine:
`~/.claude/skills` holds 18 symlinks into local repo checkouts
(`~/c/smorinlabs-harness/plugins/<plugin>/skills/<skill>`, `~/c/smorin-harness/…`) — that *is* dev
mode today, created by hand, with no SkillSmith state anywhere. `~/.codex/skills` (legacy codex
location) holds a mix of symlinks and real directories; `~/.agents/skills` (current codex
convention, already ranked first by `agents/codex/skill-roots.ts`) exists but is empty. First-run
adoption of unmanaged placements is therefore a primary path, not an edge case.

---

## 1. Background and goal

Skill development happens in a repo checkout; the tool (Claude Code, Codex) reads the skill from its
own skills directory. Today the author bridges the two with hand-made symlinks — instant feedback
(edit in the repo, the tool sees it live), zero reproducibility (the "installed" skill changes under
the tool whenever the checkout moves, and nothing records what was actually running yesterday).

`promote` flips a placement to production: run the P11 verify gate against the source, snapshot the
skill into the content-addressed store pinned at the source's git SHA, and atomically replace the
symlink with a copy of that snapshot. The tool now runs a byte-stable artifact with recorded
provenance. `dev` flips it back: atomically replace the pinned copy with a symlink to the recorded
source checkout. Both directions record enough in the placements ledger that the flip is a pure
mode toggle — **no information is consumed by flipping**: the dev record survives promotion, the
pinned record (and the store entry) survives demotion.

The two hard problems, and the core of this spec:

- **Atomicity (§8).** A skills directory must never be left in a state the tool can misread. The
  swap is a rename-based protocol with a write-ahead journal; a process killed at *any* point leaves
  a state that `--rollback` provably restores and that a re-run provably completes.
- **Round-trip losslessness (§7).** `dev → promote → dev` must end byte-identical to where it
  started (same symlink, same target), with the store entry and both ledger records retained.

### 1.1 Non-goals (this feature)

- **No fetching.** Sources are local directories already on disk. Remote sources, cloning, and the
  install write-path are P09.
- **No new placements.** `promote`/`dev` flip placements that exist; they never install a skill into
  a tool that doesn't have it. Placement creation is P09 `install`.
- **No store GC.** P12 only ever adds store entries; garbage collection ships with P09's
  reference-counted uninstall.
- **No marketplace/publishing.** Promotion is local placement state, not distribution.
- **No cross-tool adaptation.** The snapshot is the skill as authored (store semantics per
  `skillsmith-cli-design.md §1.11`); adapters are out of scope.

---

## 2. The placement model (what detection sees)

For each (skill, tool) pair, the placement at the tool's user-scope skills root is classified by
`lstat` + `readlink`:

| Class | On disk | Meaning | Flippable? |
|---|---|---|---|
| `dev` | symlink whose target is **outside** the SkillSmith store | dev mode — live view of a checkout | `promote` |
| `pinned` | real directory | production — a pinned copy | `dev` |
| `store-linked` | symlink whose target is **inside** the SkillSmith store | a P09-style store-symlink install | neither (refused with notice: managed by `install`; cannot occur before P09 ships) |
| `absent` | nothing at the placement path | not installed for this tool | neither |

Dot-prefixed entries in a skills root (e.g. codex's `.system`, and our own `.skillsmith-*` staging
and backup names, §8.2) are never treated as placements.

A `dev` placement whose symlink **dangles** (target deleted/moved) is still classified `dev`; it is
reported with an error notice and `promote` on it exits 5 (source unresolvable).

**Adoption.** Detection needs no prior SkillSmith state. A hand-made symlink (the entire current
fleet) is a `dev` placement; its first `promote` *adopts* it — the dev record (§7.2) is derived from
the live symlink target. A hand-copied directory is a `pinned`-class placement with no ledger
record; `dev` on it requires `--source` (§4.2) since no dev source is recorded anywhere.

**Scope.** P12 operates on **user scope only** — that is the real fleet, and it keeps one
implementation plan. Project-scope flips are deferred (out of scope, §16). Per-tool skills roots
come from the existing `agents/<tool>/skill-roots.ts` (user scope): claude-code
`~/.claude/skills`; codex `~/.agents/skills` (current) **and** `~/.codex/skills` (legacy) — dual-root
semantics in §10.2.

---

## 3. Design decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Two flat verbs: `skillsmith promote <skill>…` and `skillsmith dev <skill>…`, with `demote` as a built-in alias of `dev`.** `dev` is the primary name (user-mandated: "dev mode" is the developer verb people reach for); `demote` is kept for symmetry with `promote`. No alias for `promote`. | Flat verb-first surface per `skillsmith-cli-design.md §1.1`; alias policy per §5 (aliases are cheap, primaries are what help/docs teach). |
| D2 | **Targets are installed skill names (the leaf directory name in a tool's skills root); a filesystem path to a placement is also accepted.** Multiple targets allowed; `--all` flips every eligible placement and is mutually exclusive with positionals. An argument containing a path separator (or `.`/`..` prefix) is resolved as a path; otherwise as a name across the selected tools' skills roots. | Names are what `list` shows and what users know; paths cover scripting and disambiguation. Mirrors `uninstall`'s name-first targeting. |
| D3 | **Default tool set = every tool where the target currently has a flippable placement; `--tool` restricts, and explicit-is-required.** An explicitly `--tool`-named tool with no placement for the target → exit 4; an auto-detected absence is simply not in the set. | Same explicit-vs-best-effort principle as verify D6 — the fast default tolerates asymmetric fleets, an explicit request is a real gate. |
| D4 | **One placements ledger** at `$SKILLSMITH_DATA/placements.json` (versioned `schemaVersion: 1`, `kind: "skillsmith.placements"`), holding per-(skill, tool) placement records **and** the swap journal. Concurrency via `proper-lockfile` on the ledger path; the lock spans the whole flip. | Single file = single lock, single atomic write, single fsync story. The stack summary mandates `proper-lockfile` for cross-process write coordination. A coarse global lock is correct at fleet scale (≤ dozens of skills) and removes per-skill lock ordering hazards. |
| D5 | **Round-trip losslessness is a ledger invariant: flipping never deletes the opposite record.** Promote writes/updates `pinned` and keeps `dev`; demote re-points `mode` and keeps `pinned`; store entries are never deleted by P12. | This is the mechanism that makes `dev → promote → dev` byte-identical and makes `--rollback` of a *committed* flip a normal inverse flip rather than journal surgery. |
| D6 | **Store layout is P09's, seeded now:** `$SKILLSMITH_DATA/store/<ns>/<name>@<rev>/<skill>/`, where a clean-git snapshot uses `<owner>/<repo>@<sha12>` — byte-identical to P09's planned `<owner>/<repo>@<sha>/<skill>/` grammar. Local-only provenance extends the same grammar without colliding: `local/<dirname>@content-<hash12>` (non-git source) and `<ns>/<name>@dirty-<hash12>` (dirty tree, opt-in). Entries are write-once and immutable. | P09 inherits, not migrates: its entries parse under this grammar and P12's entries parse under P09's readers. The `local/` namespace and prefixed revs (`content-`, `dirty-`) can never collide with GitHub owner names' `@<sha12>` form. |
| D7 | **"Pinned at git SHA" resolution:** clean git tree → snapshot the working tree (≡ HEAD by cleanness), record full SHA. Dirty git tree → **refuse (exit 2)** unless `--allow-dirty`, which snapshots the working tree under `@dirty-<contentHash12>` with the SHA recorded alongside `dirty: true` and a warning. Non-git source → allowed, pinned at `@content-<contentHash12>` with a notice. | Promotion's promise is *recorded provenance*. A clean SHA is perfect provenance; a content hash is honest provenance (non-git); a SHA over a dirty tree is a lie — hence dirty is opt-in and its rev never claims to be the SHA. |
| D8 | **The swap is a same-directory, rename-based protocol with a write-ahead journal** (§8): journal intent → build the new placement under a dot-prefixed staging name in the same skills root → rename the live entry to a backup name → rename staging to live → cleanup → journal commit. Every phase transition is journaled before the filesystem step it describes. | `rename(2)` is atomic only within a filesystem; staging *inside* the skills root guarantees that. POSIX `rename` cannot replace a symlink with a directory (ENOTDIR) or a directory with a symlink (EISDIR/ENOTEMPTY), so a two-rename swap with a backup name is required — and the backup doubles as physical rollback material. |
| D9 | **Crash contract (threat model):** full recovery from process death (SIGKILL, crash, SIGINT) at any instant — the journal phase determines the exact on-disk state, `--rollback` restores the before-state, re-running the same command completes the flip. Power-loss safety is best-effort via fsync of staged files, the ledger, and parent directories (macOS caveat noted in §8.5). | An honest, testable bar. Process-death recovery is provable with deterministic fault injection (§15); strict power-loss ordering (F_FULLFSYNC on every step) would triple I/O cost for a laptop-local dev tool. |
| D10 | **`--rollback` is direction-agnostic and available on both verbs** (same behavior): with an uncommitted journal it restores the journaled before-state; with a committed last transition it performs the normal inverse flip from retained records. A target with an uncommitted journal refuses every operation except `--rollback` and a same-op re-run (exit 2 with remediation). | One recovery verb to remember, discoverable from either command. Blocking other ops on an unresolved journal prevents compounding a half-swap. |
| D11 | **Promote gates on P11 verify with the minimal skill-covering mode per tool:** claude-code → static (its static covers manifest + skills); codex → deep, which implies static per verify D3 (codex static is manifest-only; deep is auth-free and model-free, ~2-8 s). A `fail` verdict for a tool blocks that tool's flip (exit 1); `warn` blocks only under `--strict`; inconclusive (verifier could not run) proceeds with a warning, or blocks under `--strict`. `--no-verify` skips the gate and records `verify: "skipped"` in the ledger. | The per-tool coverage table is P11's central finding; running codex-static-only would gate on a green that never looked at the skill. Verify runs against the **dev source** (bare-skill input, verify §4.1); the snapshot is contentHash-verified byte-identical, so the gate's result transfers to the store copy. |
| D12 | **Multi-tool flips are per-tool transactions, not one cross-tool transaction.** Each (skill, tool) placement swaps independently with its own journal entry; a failure on the second tool leaves the first flipped, reported per-tool, batch exit = highest per-result code (`skillsmith-cli-design.md §6.1`). The ledger represents partial states first-class (`mode` is per-tool). | Cross-tool atomicity would require a multi-directory two-phase commit for little gain — partial states are legitimate (claude pinned / codex dev is a valid fleet), visible in `--json`, and each side is individually rollback-able. |
| D13 | **Idempotence is convergent, apply-style.** `promote` on an already-pinned placement: no-op (exit 0, notice) when the store rev already matches the current source rev; **re-pin** (snapshot + swap, action `updated`) when the source has moved. `dev` on an already-dev placement: no-op. | Matches §1.5 house idempotence and makes `promote` mean "make production current", which is what a release flow wants. |
| D14 | **Commands never prompt.** Flips are reversible by construction (D5), so there is no destructive confirmation to gate; `--no-prompt`/`--yes` are accepted no-ops. The one deletion — the old pinned copy after demotion — happens only after its content hash matches the retained store entry; on mismatch (user edited the pinned copy in place) the copy is kept as the backup name and a warning tells the user where it is. | Keeps P12 free of prompt machinery and makes both commands CI-safe by default. The hash check turns the only data-loss hazard into a preserved file + warning. |
| D15 | **Placement I/O goes through injected `ScanEnv` primitives** (env layer): `pathKind`, `readDir`, `readLink`, `makeSymlink`, `rename`, `copyTree`, `removeTree`, `makeDir`, `readTextFile`, `writeTextFile`, `fsyncFile`, `fsyncDir`, `withFileLock` (wrapping `proper-lockfile`). Core stays pure; per-agent placement detection lives in `agents/<tool>/placement.ts`; the flip engine, store, and ledger live in a new `core/src/place/`; the CLI owns exit codes and rendering. | Same pattern as P11's `env.exec` addition: the swap engine becomes unit-testable with a fake filesystem, which is exactly what the deterministic crash-point tests (§15) require. Boundaries per CLAUDE.md / ADR 0001 / ADR 0003. |

`$SKILLSMITH_DATA` throughout = `$SKILLSMITH_HOME` if set, else `$XDG_DATA_HOME/skillsmith`, else
`~/.local/share/skillsmith` (`skillsmith-cli-design.md §6.3`).

---

## 4. CLI surface

```
skillsmith promote [<skill>...] [--all] [--tool claude-code|codex]...
                   [--strict] [--no-verify] [--allow-dirty]
                   [--rollback] [--dry-run] [--json]

skillsmith dev     [<skill>...] [--all] [--tool claude-code|codex]...
                   [--source <path>] [--rollback] [--dry-run] [--json]
skillsmith demote  …            # built-in alias of dev
```

| Flag | Short | Applies to | Type | Default | Semantics |
|---|---|---|---|---|---|
| `<skill>…` | — | both | positional | — | One or more targets (name or placement path, D2). Required unless `--all`. |
| `--all` | — | both | bool | off | Flip every eligible placement: `promote --all` = every `dev` placement in the selected tools; `dev --all` = every `pinned` placement **with a recorded dev source** (others are skipped with a notice). Mutually exclusive with positionals (exit 2 if both). |
| `--tool` | `-t` | both | enum, repeatable | all tools with a flippable placement | Restrict to tool(s). Named-but-absent placement → exit 4 (D3). Values outside `{claude-code, codex}` → exit 2. |
| `--strict` | — | promote | bool | off | Verify-gate `warn` verdicts block (exit 1); inconclusive verify blocks instead of warning (D11). |
| `--no-verify` | — | promote | bool | off | Skip the verify gate; ledger records `verify: "skipped"`. |
| `--allow-dirty` | — | promote | bool | off | Permit snapshotting a dirty git tree under `@dirty-<hash12>` with a warning (D7). |
| `--source` | — | dev | path | — | Dev source for a placement with no recorded dev source (adoption of a hand-copied dir). Must be a directory containing `SKILL.md`. Only valid with exactly one target (exit 2 otherwise). |
| `--rollback` | — | both | bool | off | Recovery/undo (D10). With positionals or `--all`; takes no other operation flags (`--source`, `--no-verify`, `--allow-dirty`, `--strict` with `--rollback` → exit 2). |
| `--dry-run` | — | both | bool | off | Print the operation plan (per-(skill, tool) actions); write nothing, take no lock. |
| `--json` | — | both | bool | off | Emit the versioned JSON report on stdout (§11). |

Inherited global flags apply unchanged (`-C/--cd`, `--color`/`--no-color`, `-v/--verbose`,
`-q/--quiet`, `--no-prompt`, `--debug`; `skillsmith-cli-design.md §3.1`). Neither command prompts
(D14), so `--no-prompt` and `--yes` are no-ops.

### 4.1 `promote` semantics (per (skill, tool))

1. Resolve placement; must be `dev` (already `pinned` → convergence per D13; `store-linked`/`absent`
   → refused/exit 4 per D3).
2. Resolve the dev source from the live symlink target (adopting if unmanaged). Dangling → exit 5.
3. Verify gate (D11) unless `--no-verify`.
4. Resolve provenance: repo root (`git -C <src> rev-parse --show-toplevel` via `env.exec`),
   cleanliness (`git status --porcelain`), HEAD SHA, origin remote parsed to `<owner>/<repo>` when
   possible. Apply D7.
5. Snapshot to the store (§6.3) — idempotent when the entry already exists with matching content.
6. Atomic swap symlink → copy (§8), journaled.
7. Ledger: `mode: "pinned"`, `pinned` record updated, `dev` record retained.

### 4.2 `dev` semantics (per (skill, tool))

1. Resolve placement; must be `pinned` (already `dev` → no-op; `store-linked`/`absent` → refused /
   exit 4).
2. Resolve the dev source: the ledger's `dev.sourcePath`, else `--source <path>`, else refuse
   (exit 2: "no recorded dev source; pass --source <path>"). `--source` must exist and contain
   `SKILL.md` (exit 2 otherwise); when both exist and disagree, `--source` wins and the record is
   updated.
3. Atomic swap copy → symlink (§8), journaled. The old copy is deleted only after its content hash
   matches the retained store entry (D14).
4. Ledger: `mode: "dev"`, `dev` record updated, `pinned` record and store entry retained (D5).

---

## 5. Target and tool resolution

- **Name targets** are matched against the leaf entries of each selected tool's user-scope skills
  root(s) and against ledger keys. A name matching nothing anywhere → exit 4 ("no placement found").
- **Path targets** are `lstat`ed directly; the owning tool is inferred from which skills root
  contains the path (a path outside every known skills root → exit 2).
- **Tool set**: default = tools where the target has a flippable placement; `--tool` both restricts
  and *requires* (D3).
- Batch runs (multiple targets and/or multiple tools, `--all`) process each (skill, tool) pair
  independently and exit with the highest per-pair code (§12).

---

## 6. The store (seed of P09)

### 6.1 Layout and rev grammar

```
$SKILLSMITH_DATA/store/<ns>/<name>@<rev>/<skill>/
  ns/name  := <owner>/<repo>      # origin remote parseable as a GitHub-style owner/repo
            | local/<dirname>     # no repo, or no parseable remote (dirname = repo-root or source basename)
  rev      := <sha12>             # clean git tree (P09-identical form)
            | dirty-<hash12>      # dirty git tree, via --allow-dirty
            | content-<hash12>    # non-git source
  skill    := skill leaf name
```

`<sha12>` = first 12 hex of the full commit SHA (full SHA lives in the ledger). `<hash12>` = first
12 hex of the content hash (§6.2). The prefixed forms cannot collide with bare `<sha12>`, so P09's
readers can parse every P12-created path and vice versa; P09 itself only ever mints
`<owner>/<repo>@<sha12>`.

### 6.2 Content hash (canonical)

`sha256` over a canonical manifest of the skill directory: for each entry in sorted relative-path
order, one record `\n`-joined —
regular file: `<relpath>\0F<exec:0|1>\0<sha256(bytes)>`; symlink: `<relpath>\0L\0<link target>`.
Directories are implied by paths. The full digest is stored in the ledger
(`contentHash: "sha256:<64hex>"`); path segments truncate to 12 hex. The same function verifies
snapshot fidelity (§6.3) and guards the demote-time deletion (D14).

### 6.3 Snapshot protocol (write-once, atomic)

1. Compute the target store path from provenance (D7). If it exists: compute its content hash —
   match → **reuse** (idempotent, `store.reused: true`); mismatch → hard error (integrity violation:
   a `@<sha12>` entry must be reproducible), exit 1.
2. Stage under `$SKILLSMITH_DATA/store/.staging/<txId>/` (same filesystem as the store by
   construction): `copyTree` the skill dir from the **dev source**, fsync files, compare content
   hash against the source (guards concurrent edits mid-copy; mismatch → retry once, then exit 1).
3. `makeDir` parents; `rename` staging → final path; `fsyncDir` the parent.
4. Orphaned `.staging/<txId>` dirs (from crashes) are swept opportunistically at the start of any
   flip while the ledger lock is held.

Store entries are immutable and are never deleted by P12 (GC → P09).

---

## 7. The placements ledger (lockfile)

### 7.1 Location, versioning, concurrency

- Path: `$SKILLSMITH_DATA/placements.json`.
- Versioned contract in the house style: `schemaVersion: 1`, `kind: "skillsmith.placements"`,
  evolved additively (new optional fields within v1; removal/retype bumps the version). Read with a
  zod schema; an unparseable ledger is a hard error (exit 3) — never silently regenerated, since it
  holds the only copy of dev↔prod round-trip state.
- **Locking:** `proper-lockfile` on the ledger path (`placements.json.lock` sidecar), acquired
  before the first read of a mutating command and held across the entire flip batch —
  `stale: 30_000`, `update: 5_000`, `retries: 5` with backoff; lock release registered via the
  existing SIGINT teardown path. A crashed holder goes stale and is broken by the next comer; the
  journal (§8) — not the lock — is what guarantees consistency after a crash.
- **Write protocol:** mutate in memory → write `placements.json.tmp-<txId>` → `fsyncFile` → `rename`
  over `placements.json` → `fsyncDir`. Every journal phase transition (§8.3) is persisted this way
  *before* the filesystem step it authorizes (write-ahead).

### 7.2 Schema

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
          "dev": {                                   // retained across promote (D5)
            "sourcePath": "/Users/alice/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan",
                                                     // literal symlink target, restored verbatim on demote
            "resolvedPath": "/Users/alice/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan",
            "repoRoot": "/Users/alice/c/smorinlabs-harness",   // null when non-git
            "sourceRelPath": "plugins/factor-harness/skills/factor-scan", // null when non-git
            "remote": "smorinlabs/smorinlabs-harness",         // parsed owner/repo, null when unparseable
            "recordedAt": "2026-07-07T18:20:11Z"
          },
          "pinned": {                                // retained across dev (D5)
            "storePath": "/Users/alice/.local/share/skillsmith/store/smorinlabs/smorinlabs-harness@3f2a1b9c0d4e/factor-scan",
            "rev": "3f2a1b9c0d4e",                   // rev path segment (§6.1)
            "gitSha": "3f2a1b9c0d4e…40hex",          // full 40-hex SHA; null when the source was not a git tree
            "dirty": false,
            "contentHash": "sha256:…64hex",
            "snapshotAt": "2026-07-07T18:20:11Z",
            "verify": "passed"                       // 'passed' | 'warned' | 'skipped' (gate outcome at snapshot time)
          },
          "journal": null                            // or the in-flight/last transition (§8.3)
        },
        "codex": { "placementPath": "…/.codex/skills/factor-scan", "mode": "dev", "dev": { … }, "pinned": null, "journal": null }
      }
    }
  }
}
```

Field notes:

- `dev.sourcePath` is the **literal** symlink target string (may be relative or contain `~`-free
  raw text exactly as the link stores it); `resolvedPath` is its absolute resolution at record time.
  Demotion recreates the symlink from `sourcePath` verbatim — this is what makes the round trip
  byte-identical even for hand-made links.
- `pinned.gitSha` is the full 40-hex SHA when the source was a git tree (clean or dirty), `null`
  for non-git sources. `dirty: true` pairs only with `rev: "dirty-<hash12>"`.
- `journal` holds the last transition for the pair and is the crash-recovery record (§8.3); a
  `phase` short of `committed` marks the pair blocked (D10).
- **Losslessness invariant (D5):** a flip updates `mode` and its own side's record; it never nulls
  the other side. `pinned` is only replaced (not nulled) by a newer promote; `dev` is only replaced
  by a newer adoption/`--source`.

---

## 8. The atomic swap (state machine)

### 8.1 Filesystem facts the protocol is built on

- `rename(2)` is atomic within one filesystem; staging entries are created **inside the skills
  root** (sibling of the live placement) to guarantee that.
- `rename` cannot replace a symlink with a directory (`ENOTDIR`) nor a directory with a symlink
  (`EISDIR`/`ENOTEMPTY`) — the destination must be moved aside first. Hence the two-rename swap
  with a backup name, which also gives `--rollback` physical material.
- Reserved names inside a skills root: staging `.skillsmith-staging-<skill>-<txId>`, backup
  `.skillsmith-backup-<skill>-<txId>`. Dot-prefixed names are ignored by our detection (§2) and by
  the tools' skill discovery (fixture-verified in TS01).

### 8.2 Phases

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
P1 prepared    journal written; dev source resolved (§4.2)
P2 staged      staging symlink created: makeSymlink(dev.sourcePath, .skillsmith-staging-…)
P3 backed-up   rename(live dir → .skillsmith-backup-…)              ← live path now ABSENT
P4 live        rename(.skillsmith-staging-… → live path)            ← live path now the symlink
P5 committed   backup dir removed iff contentHash(backup) == pinned.contentHash,
               else kept + warning (D14); fsyncDir; ledger updated
```

Each journal write lands (write-ahead, §7.1) **before** the filesystem action of the phase it
names authorizes; i.e. `phase: "backed-up"` is persisted, then the P3 rename runs, then
`phase: "live"` is persisted, then the P4 rename runs, then commit.

### 8.3 Journal record

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

### 8.4 Crash points and recovery

The journaled phase is a *lower bound* on progress: a crash can land after the journal write but
before (or during) the phase's filesystem action, so recovery probes the filesystem to disambiguate
— every probe is a single `pathKind` check, and every cell below is deterministic.

| Crash window | Journal says | Live path | Recovery: `--rollback` | Recovery: same-op re-run |
|---|---|---|---|---|
| C0 before P1 journal | none | old, intact | nothing to do | fresh run |
| C1 after `prepared`, during staging | `prepared` | old, intact | remove staging remnant, clear journal | rebuild staging, continue |
| C2 after `staged`, before P3 rename | `staged` | old, intact | remove staging, clear journal | continue at P3 |
| C3 after `backed-up` journal, around P3 rename | `backed-up` | **old or ABSENT** (probe) | if live still old: remove staging, clear journal; if absent: `rename(backup → live)`, remove staging, clear journal | if live still old: run P3; if absent: continue at P4 |
| C4 after `live` journal, around P4 rename | `live` | **ABSENT or new** (probe) | if absent: `rename(backup → live)`, remove staging; if new: `rename(live → staging-name)`, `rename(backup → live)`, remove staging'; clear journal | if absent: run P4; if new: continue at P5 |
| C5 after P4, before commit write | `live` | new | as C4 "new" row | complete P5 (cleanup + commit) |
| C6 committed | `committed` | new | inverse flip via retained records (a normal, fully journaled flip in the opposite direction — D10) | no-op (already converged, D13) |

Invariants provable from the table (and locked by tests, §15):

1. **The live path is never a partial artifact.** It is always exactly one of: the old placement,
   the complete new placement, or absent — never a half-copied directory (staging is built under a
   dot-name and only ever *renamed* to live).
2. **Absence is always recoverable**: whenever the live path is absent, the backup entry exists
   (P3 rename is atomic), so `--rollback` restores the before-state with one rename.
3. **Nothing is deleted before commit** except the staging remnant; the backup — the only copy of
   the old state's physical form — is removed only in P5, after the new live entry exists.

Recovery runs under the ledger lock; an uncommitted journal blocks all other operations on the pair
(exit 2 with remediation naming both options) — see D10.

### 8.5 fsync notes (macOS/Linux)

Staged files are fsynced at P2; the skills root directory is fsynced after the P3–P5 rename
sequence; every ledger write is fsync-file + fsync-dir (§7.1). On macOS, `fsync` may not force
platter/NAND flush (`F_FULLFSYNC` does); P12 deliberately uses plain `fsync` — the crash contract
(D9) guarantees process-death recovery, and treats power loss as best-effort. This is recorded here
so nobody "fixes" it into a 3× slower flip without revisiting D9.

---

## 9. Verify gate (promote only)

Per D11, for each tool being flipped, promote runs the P11 verifier **on the dev source directory**
(bare-skill input; verify wraps it in an ephemeral plugin per verify spec §4.1):

| Tool being promoted | Verify invocation (via `core/verify`) | Why this mode |
|---|---|---|
| claude-code | tool `claude-code`, mode `static` | Claude static covers manifest + skills with reasons — the whole gate. |
| codex | tool `codex`, modes `static + deep` | Codex static is manifest-only; deep is the only skill-validating surface, and it is auth-free/model-free (verify §7.4). |

Blocking rule per tool: verdict `fail` → that tool's flip is refused, action `failed`, exit
contribution 1. Verdict `warn` → proceeds (recorded `verify: "warned"`) unless `--strict`.
`inconclusive` (verifier unavailable/timeout) → proceeds with a stderr warning, or blocks under
`--strict` — mirroring verify's explicit-is-required D6, `--strict` is the "this gate must really
run" switch. `--no-verify` skips the gate entirely and the ledger records `verify: "skipped"` so a
later audit can see unverified promotions. The gate runs once per (skill, tool) before any journal
write — a blocked flip touches nothing.

---

## 10. Multi-tool semantics

### 10.1 Defaults and partial flips

Default tool set per target = every tool with a flippable placement (D3). Flips are per-tool
transactions (D12): the batch continues past a failed pair, results are reported per (skill, tool),
and the ledger's per-tool `mode` makes mixed states (claude `pinned`, codex `dev`) first-class.
`--rollback` likewise operates per selected (skill, tool) pair on its own journal/records.

### 10.2 Codex dual location

Codex has two user-scope roots, already ranked in `agents/codex/skill-roots.ts`:
`~/.agents/skills` (current convention, priority) and `~/.codex/skills` (legacy; honors
`$CODEX_HOME`). P12 policy:

- **Read both.** A placement is wherever the skill is found.
- **Write in place.** A flip swaps the placement in the root where it was found — P12 never
  migrates between roots (that is placement *creation* policy, i.e. P09's decision to make).
- **Found only in the legacy root:** flip there; emit an info notice ("codex placement is in the
  legacy ~/.codex/skills; the current convention is ~/.agents/skills — a future
  `skillsmith install` can migrate it").
- **Found in both roots:** refuse the codex flip for that skill (exit 2) with both paths printed —
  codex's own precedence between duplicates is not something P12 should silently bet on. Other
  tools' flips for the same skill proceed (D12).

---

## 11. JSON contract (`--json`)

One schema for both commands (and `--rollback`), versioned in the house style
(`schemaVersion: 1`, discriminated `kind`), additive evolution only, zod-validated by the CLI
before writing (pattern of `verify-json.ts`).

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
      "reason": null,                    // human-readable cause for skipped/refused/failed
      "before": { "mode": "dev", "symlinkTarget": "/Users/alice/c/…/factor-scan" },
      "after":  { "mode": "pinned", "storePath": "…/store/smorinlabs/smorinlabs-harness@3f2a1b9c0d4e/factor-scan" },
      "store":  { "path": "…", "rev": "3f2a1b9c0d4e", "gitSha": "…40hex", "dirty": false, "reused": false },
      "verify": { "gate": "passed", "verdict": "pass" }   // null for dev/rollback or --no-verify ('gate':'skipped')
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

Action vocabulary: `flipped` (mode changed), `updated` (re-pin per D13), `noop` (already
converged), `skipped` (ineligible under `--all`, e.g. no recorded dev source), `refused` (blocked
before any journal write: dual-location conflict, dirty without `--allow-dirty`, unresolved journal,
verify `fail`… — nothing was touched), `failed` (an error mid-flight; the pair's journal/backup
state is reported in `reason`), `rolled-back`.

---

## 12. Exit codes

Reuses the documented set (`skillsmith-cli-design.md §6.1`); no new numeric codes. Batch runs exit
with the **highest** code across (skill, tool) results (§6.1 batch-max — unlike verify, no override
is needed here because 1-vs-4 never competes for the same pair: a verify `fail` and an absent
placement cannot both apply to one result).

| Code | Meaning for `promote` / `dev` |
|---|---|
| `0` | All pairs `flipped` / `updated` / `noop` / `skipped` / `rolled-back`. Idempotent no-ops are successes (§1.5). |
| `1` | A pair `failed` (verify-gate `fail`, snapshot integrity error, mid-flight I/O error — state left recoverable per §8.4) . |
| `2` | Usage or refusal: bad flag combination, `--all` + positionals, unknown `--tool` value, path target outside every skills root, `--source` invalid/missing when required, dirty tree without `--allow-dirty`, codex dual-location conflict, unresolved journal without `--rollback`/same-op re-run. |
| `3` | Placements ledger unreadable/unparseable (it is config-class state; never silently regenerated, §7.1). |
| `4` | No placement for an explicitly requested target/tool: unknown skill name, or `--tool`-named tool has no flippable placement (D3). |
| `5` | Dev source unresolvable: dangling dev symlink on `promote`, recorded `dev.sourcePath` missing on `dev`. |
| `6` | Permission: skills root, store, or ledger path not writable. |
| `130` | SIGINT — in-flight pair finishes its current journal write, then aborts; state is recoverable per §8.4. |

---

## 13. Architecture and where code lives

Follows the per-agent boundary (CLAUDE.md), the core/CLI split (ADR 0001), and the import zones
(ADR 0003). `place/` is a high-level orchestrator like `verify/` — the zone list gains
`packages/core/src/{skills,plugins,commands}` ↛ `place` and `place` may import `env/`, `detect/`,
`agents/`, `verify/` (promote gate) — recorded as an ADR 0003 amendment in the implementing PR.

```
packages/core/src/
  place/
    types.ts          PlacementClass, PlacementRecord, LedgerFile, Journal, FlipReport, FlipAction …
    ledger.ts         readLedger / writeLedger (atomic, zod-validated) / withLedgerLock (proper-lockfile)
    store.ts          provenance resolution (git via env.exec), content hash, snapshot protocol (§6.3)
    swap.ts           the state machine (§8): runFlip(env, plan) — journaled phases, recovery, rollback
    plan.ts           target/tool resolution (§5), eligibility, dry-run plan (Operation[]-log style)
    run.ts            promote(env, opts) / dev(env, opts) / rollback(env, opts)
                      -> Result<FlipReport, SkillSmithError>; wires verify gate for promote
  agents/claude-code/placement.ts   classifyPlacement(env, skillsRoot, name) + user-scope roots reuse
  agents/codex/placement.ts         same + dual-root policy data (§10.2)
packages/cli/src/
  commands/promote.ts   flags, calls place/run.promote, exit codes (§12), rendering
  commands/dev.ts       same for dev; registers the `demote` alias
  output/flip-human.ts  per-(skill, tool) action lines + summary
  output/flip-json.ts   FlipJsonSchema (zod) + renderFlipJson (validates before write)
```

Core-interface additions (env layer, D15): the fs/lock primitives listed in D15 join `ScanEnv`
beside P11's `exec`; `defaultScanEnv()` implements them over Bun/node:fs, tests inject an in-memory
fake filesystem with fault injection (§15). New `SkillSmithError` codes:
`placement-not-found` (→ 4), `source-unresolvable` (→ 5), `ledger-error` (→ 3),
`permission-denied` (→ 6), `flip-refused` (→ 2), `flip-failed` (→ 1); mapped in
`cli/util/exit-codes.ts`.

New runtime dependency: `proper-lockfile` (already on the approved V1 stack list). No other deps.

---

## 14. Error handling

| Condition | Handling |
|---|---|
| Target name matches nothing | `placement-not-found` → exit 4, listing the roots searched. |
| `--tool` named, no flippable placement there | exit 4 (D3), naming what *was* found (`absent`, `store-linked`). |
| Dev symlink dangles on promote | `source-unresolvable` → exit 5, printing the dead target. |
| `dev` with no recorded source and no `--source` | exit 2 with the exact remediation flag. |
| Dirty git tree without `--allow-dirty` | `refused`, exit 2, printing `git status --porcelain` summary. |
| Symlink target is not a skill dir (no `SKILL.md`, e.g. a repo root) | `refused`, exit 2 ("target of the dev symlink is not a skill directory"). |
| Verify gate `fail` | `failed`, exit 1; per-tool findings rendered via verify's human/JSON output. |
| Store entry exists with mismatched content at `@<sha12>` | integrity error, exit 1 (§6.3). |
| Unresolved journal on the pair | every op except `--rollback` / same-op re-run refuses, exit 2, message names both. |
| Ledger unparseable | exit 3; never regenerated (§7.1). |
| Lock held by a live process | wait/retry per §7.1, then exit 1 ("another skillsmith operation is running"). |
| Demoted copy hash ≠ store entry | copy preserved under the backup name; warning with the path (D14). |
| SIGINT | finish current journal write, abort, exit 130; state recoverable (§8.4). |

---

## 15. Testing strategy

- **Fixture fleet (P12-TS01)** — a fake `$HOME` under `packages/core/tests/fixtures/place/`:
  `~/.claude/skills` with symlink placements into a fixture "checkout" tree (a real git repo built
  by the fixture setup: `git init` + commit, so clean/dirty/SHA paths are real), plus a pinned-copy
  placement; `~/.codex/skills` (legacy) and `~/.agents/skills` (current) trees covering
  legacy-only, current-only, and both-roots-conflict cases; a dot-entry (`.system`) that must be
  ignored. Fixture setup also proves dot-prefixed staging names are invisible to placement
  detection.
- **Unit: detection** — classification table (`dev`/`pinned`/`store-linked`/`absent`, dangling
  symlink) per agent against the fixture fleet via injected env.
- **Unit: store** — provenance matrix {clean git + remote, clean git no remote, dirty, non-git} →
  expected `<ns>/<name>@<rev>` paths; snapshot idempotence (reuse on matching hash); integrity
  error on mismatched `@sha12` content; content-hash canonicalization (file order, exec bit,
  symlink entries).
- **Unit: ledger** — round-trip zod validation, atomic write protocol, losslessness invariant (D5)
  after promote/dev/promote sequences, additive-schema golden JSON.
- **Interrupted-swap suite (the TS02 acceptance core)** — deterministic crash-point injection: the
  fake env wraps every primitive and throws `SimulatedCrash` at the Nth mutating call; the harness
  runs `promote` (and `dev`) with N swept from 1 until the flip completes, and after **every**
  crash asserts the §8.4 invariants: (1) live path is old-complete, new-complete, or absent —
  never partial; (2) if absent, backup exists; (3) `--rollback` restores the before-state
  **byte-identically** (symlink target string / directory content hash); then separately (4) a
  same-op re-run converges to the committed state. This sweep mechanically visits C0–C6 without
  hand-picking crash points.
- **Round-trip e2e (P12-TS02)** — on the fixture fleet: `dev → promote → dev` asserts the final
  symlink target equals the original literal target, ledger `dev`+`pinned` records both present,
  store entry still on disk; then `promote` again asserts store reuse (`reused: true`). A second
  e2e drives the real CLI as a subprocess against a temp `$HOME`/`$SKILLSMITH_HOME` and SIGKILLs it
  at a phase barrier (test-only env var `SKILLSMITH_TEST_PAUSE_AT=<phase>`, honored only when
  `SKILLSMITH_E2E=1`), then runs `--rollback` and asserts restoration — proving the journal works
  across real process death, not just simulated throws.
- **Exit-code table test** — drive §12 across {noop, flipped, refused-dirty, verify-fail,
  named-tool-absent, dangling-source, unresolved-journal, ledger-corrupt} and assert
  0/1/2/3/4/5.
- **Verify-gate tests** — canned verify reports (pass/warn/fail/inconclusive) × {default,
  `--strict`, `--no-verify`} → block/proceed matrix; asserts codex gate requests `deep` and claude
  gate requests `static`.
- `bun run check` green (biome + eslint boundaries incl. the new `place/` zones + tsc + actionlint
  + bun test).

---

## 16. Out of scope

- Fetching/cloning remote sources; creating new placements; `install`/`uninstall` (→ P09).
- Store garbage collection and reference counting (→ P09).
- Project- and system-scope flips; `--scope` flag (user scope only in P12).
- Migrating codex placements between `~/.codex/skills` and `~/.agents/skills` (§10.2 — placement
  creation policy, → P09).
- kilo-code / opencode placements (no verify gate exists for them; their agent slots keep stubs).
- Cross-tool transactional flips (per-tool by design, D12).
- Marketplace/registry publishing; any notion of "promote to a registry".
- A `--timeout` flag; verify-gate timeouts follow P11's constants.

---

## 17. Open questions

None held in this spec. Two residual, non-blocking questions are tracked where the house style
puts them — one in each command page: journal reuse by P09 (`research/commands/promote.md`) and
`--source` shorthand forms (`research/commands/dev.md`). Neither changes P12 behavior.
