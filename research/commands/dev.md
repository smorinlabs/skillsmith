# dev

`skillsmith dev` (**alias: `demote`**) puts a skill into **dev mode** (a symlink into a local source
checkout) for a tool. Three things live under this one verb, disambiguated by placement state:

- **flip** (P12) — a **pinned** (production) placement swaps its copy for the dev symlink recorded
  at the last `promote`. Lossless: the pinned record and its store entry are retained, so a later
  `promote` reuses the snapshot and `--rollback` can restore either state.
- **create** (P13, `--source`) — an **absent** placement gets a brand-new symlink into the checkout
  at `--source`, plus a dev-only ledger record. This is how a local checkout becomes a skill
  placement for the first time — no prior `install`/`promote` history required.
- **adopt** (P13, `--source`) — a placement that is **already** a hand-made symlink pointing at
  `--source` (e.g. a manual `ln -s`) gets recorded into the ledger, record-only. The disk entry
  itself is never touched.

`dev` is the primary verb (it names the mode developers reach for); `demote` is a built-in alias for
symmetry with `promote`.

Full design rationale for the P12 flip/swap state machine, ledger schema, crash points, and JSON
contract lives in `docs/superpowers/specs/2026-07-07-promote-dev-design.md`. The P13 create/adopt
state machine (S1–S6) and its design decisions (D1–D5) live in
`docs/superpowers/specs/2026-07-10-p13-dev-source-prd.md`. This page is the command surface for
both.

## Argument order

```
skillsmith dev [<skill>...] [FLAGS]
skillsmith demote [<skill>...] [FLAGS]     # alias
```

Zero or more positionals: each `<skill>` is an installed skill name (the leaf directory name in a
tool's user-scope skills root) or a filesystem path to a placement. At least one positional is
required unless `--all` is passed; `--all` with positionals is a usage error (exit 2).

## Commands

**`skillsmith dev <skill>... [--tool <name>]... [--source <path>] [--dry-run] [--json]`** — P12.
For each (skill, tool) pair with a **pinned** placement: resolves the dev source — the ledger's
recorded `dev.sourcePath` from the last promote, or `--source <path>` for placements SkillSmith has
no record of (e.g. a hand-copied skill directory) — then swaps pinned copy → dev symlink with the
same journaled, rename-based protocol as `promote`. The symlink is recreated from the recorded
target **verbatim**, so a `dev → promote → dev` round trip is byte-identical. The old pinned copy
is deleted only after its content hash matches the retained store entry; if the copy was edited in
place, it is preserved under a backup name and a warning prints its path. No recorded source and no
`--source` → refusal (exit 2) naming the flag. Already-dev placements are idempotent no-ops.

**`skillsmith dev <skill> --source <path> [--tool <name>]... [--dest <path>] [--strict] [--no-verify] [--dry-run] [--json]`** — P13.
For an **absent** or **already-dev** placement, `--source` creates or adopts instead of flipping
(flipping only applies to a *pinned* placement — see the P12 form above). Exactly one target is
required (exit 2 otherwise). State per (skill, tool) pair:

| # | Placement state | Behavior | Result action |
|---|---|---|---|
| S1 | absent | validate `--source` (dir exists, contains `SKILL.md`) → verify gate → staged-rename symlink into place → dev-only ledger record | `created` |
| S2 | a symlink matching `--source`, **not yet recorded** (e.g. a hand-made `ln -s`) | verify gate → ledger dev record; **disk untouched** | `adopted` |
| S3 | a symlink matching `--source`, already recorded | nothing to do | `noop` |
| S4 | a symlink whose target does **not** match `--source` | refused — `dev` never silently repoints an existing symlink | `refused` (exit 2) |
| S5 | pinned (production) | unchanged P12 flip behavior — `--source` fills in a missing recorded source; a recorded source that **disagrees** with `--source` refuses (S5b — see below) | `flipped` / `refused` |
| S6 | a real file/dir that is not a pinned copy (foreign object) | refused | `refused` (exit 2) |

Both create (S1) and adopt (S2) run the **static verify gate by default** — hermetic and
auth-free, the same static checks the `verify` command itself runs by default (`--static`,
no `--deep`). `--no-verify` skips it entirely
(gate recorded as `skipped`); `--strict` upgrades warnings and inconclusive results to blocking. A
gate failure writes nothing (exit 1). A source directory whose basename differs from the placement
name is a **warning** on the result, not a refusal (you can `dev factor-scan --source ~/c/renamed-repo/skills/old-name`
and it still creates — just flags the naming mismatch).

`--dest <path>` overrides the destination root for a **created** placement (S1 only; it has no
effect on adopt, flip, or refusal outcomes). It requires exactly one `--tool` — an unscoped
destination is ambiguous across tools, so combining `--dest` with the default (both-tools) selection
or with `--tool` passed more than once is a usage error (exit 2).

With no `--tool`, both default tools are tried in the usual fixed order and pairs are independent —
one pair refusing does not stop the other (unchanged P12 semantics). For codex, a **create** always
lands at the current convention (`~/.agents/skills`); the legacy `~/.codex/skills` root is
adopt-in-place only — a skill is never placed at both codex roots at once (see the dual-location
refusal below).

**BREAKING CHANGE from P12 (S5b):** previously, `--source` disagreeing with an already-recorded dev
source **won** — the record was silently updated to the new source. It now **refuses**. `dev` never
silently repoints a recorded source, matching the S4 rule for an unrecorded symlink. If you really
mean to re-point a pinned placement's dev source, there is currently no override flag for it (open
question, below) — the ledger record must be corrected out of band.

**`skillsmith dev --all [--tool <name>]...`** — P12.
Demotes every pinned placement **with a recorded dev source** in the selected tools; pinned
placements without one are skipped with a notice (a fleet-wide `--all` must not stop to ask for
sources). Per-pair results are independent; batch exit code is the highest per-pair code.
`--all` combined with `--source` is a usage error (exit 2) — create/adopt are inherently targeted at
one placement, so `--all` gains no create/adopt semantics (PRD D5).

**`skillsmith dev --rollback <skill>...`** — P12.
Recovery/undo, direction-agnostic and identical to `promote --rollback`: with an uncommitted swap
journal it restores the journaled before-state; with a committed last transition it performs the
normal inverse flip from the retained ledger records. Not combinable with `--source` (exit 2).
Rollback-of-create is **out of scope** — undoing a `--source` create is `skillsmith uninstall`, not
`--rollback` (create/adopt keep no swap journal to roll back — see Crash safety, below).

Rationale for `--source` being dev-only: `promote` can always read the dev source off the live
symlink, but a pinned copy carries no pointer back to a checkout — the ledger is that pointer, and
`--source` is how SkillSmith learns it in the first place (create), confirms a hand-made one
(adopt), or fills in a gap on an existing pinned placement (S5).

## Feature table

| # | Feature | Phase | Why |
|---|---|---|---|
| 14.1 | **`skillsmith dev <skill>...`** (alias `demote`) — atomic copy→symlink swap from the recorded dev source, ledger update, store entry retained | P12 | The edit-loop flow: flip back to a live checkout without losing the pin. |
| 14.2 | **`--source <path>`** on a pinned placement (S5) — fills in a missing recorded dev source | P12 | Hand-copied skill dirs (real fleet: several exist under `~/.codex/skills`) have no provenance to read. |
| 14.3 | **`--all`** — fleet-wide demote of recorded placements, skip-with-notice otherwise | P12 | Symmetric with `promote --all`; safe by construction (never guesses a source). |
| 14.4 | **`--rollback`** — journal-based recovery + inverse flip | P12 | Same recovery verb on both commands; the TS02 recoverability acceptance. |
| 14.5 | **`--source <path>`** on an absent placement (S1) — create a dev symlink + ledger record from a local checkout | P13 | The one command that puts a local checkout into dev mode; removes the last hand-rolled `ln -s` from downstream tooling. |
| 14.6 | **`--source <path>`** on a matching hand-made symlink (S2) — adopt into the ledger, record-only | P13 | A skill someone `ln -s`'d by hand becomes SkillSmith-managed without touching disk. |
| 14.7 | **`--dest <path>`** — override the destination root for a created placement | P13 | One-off placements outside the default tool roots (e.g. a project-scoped skills dir). |
| 14.8 | **`--strict`** / **`--no-verify`** on create/adopt — upgrade warnings to blocking, or skip the gate entirely | P13 | D2: static verify is the default gate (catches frontmatter rot); some workflows need to bypass or tighten it. |

## Flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--all` | — | bool | false | — | Demote every pinned placement with a recorded dev source in the selected tools. Mutually exclusive with positionals and with `--source`. |
| `--tool` | `-t` | enum/repeatable | all tools with a flippable placement | `SKILLSMITH_TOOL` | Restrict to tool(s): `claude-code` \| `codex`. A named tool with no placement for the target → exit 4. |
| `--source` | — | path | — | — | Pinned placement (S5): fills in a missing recorded dev source. Absent placement (S1): creates. Matching unrecorded symlink (S2): adopts. Single target only (exit 2 otherwise); must be a directory containing `SKILL.md`; resolved to an absolute path before any use or recording. |
| `--dest` | — | path | tool default (Claude Code `~/.claude/skills`; codex `~/.agents/skills`) | — | Destination root for a **created** placement (S1 only). Requires exactly one `--tool` (exit 2 otherwise). |
| `--strict` | — | bool | false | — | Create/adopt only: verify warnings and inconclusive results block instead of passing through. |
| `--no-verify` | — | bool | false | — | Create/adopt only: skip the static verify gate entirely (recorded as `skipped`). |
| `--rollback` | — | bool | false | — | Restore the prior placement state (see above). Not combinable with `--source`. |
| `--dry-run` | — | bool | false | — | Print the per-(skill, tool) operation plan; write nothing, take no lock, run no verify gate. |
| `--json` | — | bool | false | — | Emit the versioned `skillsmith.flip` JSON report on stdout (schemaVersion 2 — see below). |

Global inherited flags (`-C/--cd`, `--color`/`--no-color`, `-v/--verbose`, `-q/--quiet`, `--debug`)
apply per `skillsmith-cli-design.md §3.1`. `dev` never prompts — every outcome (flip, create, adopt)
is reversible or hash-guarded — so `--no-prompt` and `--yes` are accepted no-ops.

## Help output

Captured verbatim from `skillsmith dev --help` (P13):

```
Usage: skillsmith dev|demote [options] [skill...]

Flip a skill from production (pinned copy) back to dev mode (symlink).

Arguments:
  skill              Skill name(s) or placement path(s)

Options:
  --all              Demote every pinned placement with a recorded dev source.
                     (default: false)
  -t, --tool <name>  Restrict to tool(s): claude-code | codex. Repeatable.
                     (choices: "claude-code", "codex", default: [])
  --source <path>    Dev source: create (absent) or adopt (matching symlink) a
                     placement.
  --dest <path>      Destination root for a created placement (requires exactly
                     one --tool).
  --strict           Treat verify warnings/inconclusive as blocking on
                     create/adopt. (default: false)
  --no-verify        Skip the static verify gate on create/adopt.
  --rollback         Restore the prior placement state (undo / crash recovery).
                     (default: false)
  --dry-run          Show the plan without changing anything. (default: false)
  --json             Emit the versioned JSON report on stdout. (default: false)
  --no-prompt        Accepted no-op — dev never prompts.
  --yes              Accepted no-op — dev never prompts. (default: false)
  -h, --help         display help for command

ALIASES
  demote

EXAMPLES
  # Back to the live checkout recorded at promote time
  $ skillsmith dev factor-scan

  # Adopt a hand-copied skill into dev mode
  $ skillsmith dev gh-fix-ci --tool codex --source ~/c/gh-fix-ci/skills/gh-fix-ci

  # Whole fleet back to dev for a hack session
  $ skillsmith dev --all

  # Undo the last flip (or recover an interrupted one)
  $ skillsmith dev --rollback factor-scan

EXIT CODES
  0    demoted / created / adopted (or already in that state — idempotent no-op)
  1    a flip failed (swap error, or a verify-gate failure on create/adopt; state recoverable)
  2    usage error or refusal (no recorded source without --source, mismatched symlink target
       (S4) or recorded source (S5b), foreign object at the placement path (S6), unresolved
       journal, …)
  3    placements ledger unreadable
  4    no placement found for a requested skill/tool
  5    recorded dev source no longer exists on disk
  6    permission error (skills dir or ledger not writable)
  130  cancelled (SIGINT; state recoverable)
```

The `--help` text's own "Adopt a hand-copied skill" example is the **P12** S5 case (a hand-COPIED
*directory*, i.e. a pinned placement missing its recorded source). The two P13 examples below —
create (S1) and adopt of a hand-made *symlink* (S2) — are not yet in the CLI's own `--help` text
(tracked separately from this doc) but are equally valid:

```
# Put a local checkout into dev mode for the very first time — no prior install/promote (create, S1)
$ skillsmith dev factor-scan --source ~/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan

# Record a hand-made `ln -s` into the ledger, disk untouched (adopt, S2)
$ ln -s ~/c/gh-fix-ci/skills/gh-fix-ci ~/.agents/skills/gh-fix-ci
$ skillsmith dev gh-fix-ci --tool codex --source ~/c/gh-fix-ci/skills/gh-fix-ci
```

## Error and prompt mockups

**`skillsmith dev factor-scan` — success (human output):**
```
Flipping factor-scan to dev mode  (tools: claude-code)

claude-code  ~/.claude/skills/factor-scan
  source   ~/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan  (recorded at promote)
  swap     pinned copy -> dev symlink                                  flipped
           pin retained: smorinlabs/smorinlabs-harness@3f2a1b9c0d4e

1 flipped.  Exit code: 0
```

**No recorded dev source:**
```
error: cannot flip 'gh-fix-ci' (codex) to dev mode: no dev source is recorded.

  This placement is a plain directory that SkillSmith did not create, so there
  is no checkout to point a symlink at. Tell it where the source lives:

    skillsmith dev gh-fix-ci --tool codex --source <path-to-skill-checkout>

Exit code: 2
```

**Recorded source missing on disk:**
```
error: the recorded dev source for 'factor-scan' (claude-code) no longer exists:

    ~/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan

  Restore the checkout at that path, or pass the SAME --source again once it's back.
Exit code: 5
```
Note (P13, S5b): if you meant to point this placement at a *different* checkout entirely, passing a
different `--source` here now **refuses** (see the S5b mockup below) rather than re-pointing the
record — there is currently no in-band way to redirect an already-recorded dev source.

**Pinned copy was edited in place (demote still proceeds):**
```
warning: the pinned copy of 'factor-scan' (claude-code) differs from its store
         snapshot — it was modified in place. The modified copy was preserved at:

           ~/.claude/skills/.skillsmith-backup-factor-scan-9f4c2a17

1 flipped, 1 warning.  Exit code: 0
```

**`skillsmith dev factor-scan --source <path>` on an absent placement — create (S1) succeeds:**
```
Flipping factor-scan to dev mode  (tools: claude-code)

claude-code  ~/.claude/skills/factor-scan
  source   ~/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan
  verify   static gate passed
  result   created — dev symlink + ledger record

1 created.  Exit code: 0
```

**`skillsmith dev gh-fix-ci --tool codex --source <path>` over a pre-made `ln -s` — adopt (S2) succeeds, disk untouched:**
```
Flipping gh-fix-ci to dev mode  (tools: codex)

codex  ~/.agents/skills/gh-fix-ci
  source   ~/c/gh-fix-ci/skills/gh-fix-ci
  verify   static gate passed
  result   adopted — recorded only, disk unchanged

1 adopted.  Exit code: 0
```

**S4 — `--source` disagrees with an existing, unrecorded symlink (never silently repointed):**
```
error: existing dev symlink for 'mismatch' (claude-code) points to
       ~/c/other-repo/skills/mismatch, not --source ~/c/smorinlabs-harness/plugins/factor-harness/skills/mismatch

Exit code: 2
```

**S5b — `--source` disagrees with an already-RECORDED dev source (BREAKING CHANGE from P12: this
used to win and silently update the record):**
```
error: refusing to redirect 'factor-scan' (claude-code): --source
       ~/c/new-checkout/skills/factor-scan disagrees with the recorded dev source
       ~/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan

Exit code: 2
```

**S6 — a foreign object already occupies the placement path:**
```
error: refusing to create 'filey' (claude-code): a foreign file already exists at
       ~/.claude/skills/filey

Exit code: 2
```

**Codex dual-location refusal — a skill present in both the legacy and modern codex roots:**
```
error: found in both ~/.agents/skills and ~/.codex/skills; resolve the duplicate first

Exit code: 2
```

## FlipReport JSON contract (`--json`, schemaVersion 2)

`--json` emits the same `skillsmith.flip` report the P12 flip form does, on
`schemaVersion 2` (PRD D4 — bumped from 1 for this command surface). The delta:

- Two new `action` values on a result: `created`, `adopted` (alongside the existing `flipped`,
  `updated`, `noop`, `skipped`, `refused`, `failed`, `rolled-back`).
- Two new `summary` counters: `created`, `adopted`, alongside the P12 buckets (`flipped`, `updated`,
  `noop`, `skipped`, `refused`, `failed`, `rolledBack`).
- The schema stays **closed** — an unrecognized `action` value is still rejected, not passed through.
- A `created`/`adopted` result's `verify` field reports the create/adopt gate outcome (`gate`:
  `passed` | `warned` | `failed` | `skipped` | `inconclusive`; `verdict`: the underlying tool
  verdict or `null`) — the same shape `promote`'s `verify` field already uses.

```jsonc
{
  "schemaVersion": 2,
  "kind": "skillsmith.flip",
  "op": "dev",
  "results": [
    {
      "skill": "factor-scan", "tool": "claude-code",
      "placementPath": "/Users/alice/.claude/skills/factor-scan",
      "action": "created",
      "after": { "mode": "dev", "symlinkTarget": "/Users/alice/c/.../factor-scan" },
      "verify": { "gate": "passed", "verdict": "pass" }
    }
  ],
  "summary": { "flipped": 0, "updated": 0, "noop": 0, "skipped": 0, "refused": 0,
               "failed": 0, "rolledBack": 0, "created": 1, "adopted": 0 }
}
```

## Crash safety and convergence

Create/adopt (S1/S2) keep **no swap journal** — unlike the P12 flip, which journals each phase of
its rename-based swap for `--rollback` (PRD D3: "no new journal op"). Instead, safety comes from
write ordering plus idempotent re-running:

1. The symlink is written first — via a staging name in the same directory, then an atomic
   `rename` into the final placement path.
2. The ledger record is written second.

A process that dies between those two steps leaves the symlink live on disk but unrecorded — that
is exactly **S2**. Running the identical `dev ... --source <path>` command again does not fail or
duplicate anything: it recognizes the matching symlink and adopts it (record-only), converging to
the same end state a clean create would have reached. There is no `--rollback` for a create — undo
is `skillsmith uninstall`.

## Open questions

1. **Should `--source` accept `owner/repo` shorthand (cloning on demand) in addition to a local
   path?** Leaning no — fetching is `install`'s job, and P09's source resolver should stay the only
   code that turns a shorthand into a checkout. Revisit when P09's resolver lands, in case reusing
   it here is nearly free.
2. **Is there a need for an explicit "re-point a recorded dev source" flag?** S5b (P13) closes the
   silent-repoint path; today the only way to change a placement's recorded source to a genuinely
   different checkout is to edit the ledger out of band. Revisit if this friction shows up in
   practice.
