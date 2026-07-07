# dev

`skillsmith dev` (**alias: `demote`**) flips a skill placement from **production** (a pinned copy in
the tool's skills directory) back to **dev mode** (a symlink into the local source checkout). It is
the developer half of the `promote` ⇄ `dev` pair: record the prod placement, atomically swap the
pinned copy for the dev symlink, and update the placements ledger. The flip is lossless — the
pinned record and its store entry are retained, so a later `promote` reuses the snapshot and
`--rollback` can restore either state. `dev` is the primary verb (it names the mode developers
reach for); `demote` is a built-in alias for symmetry with `promote`.

Full design rationale — placement model, ledger schema, the swap state machine with crash points,
and the JSON contract — lives in `docs/superpowers/specs/2026-07-07-promote-dev-design.md`. This
page is the command surface.

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
For each (skill, tool) pair with a pinned placement: resolves the dev source — the ledger's
recorded `dev.sourcePath` from the last promote, or `--source <path>` for placements SkillSmith has
no record of (e.g. a hand-copied skill directory) — then swaps pinned copy → dev symlink with the
same journaled, rename-based protocol as `promote`. The symlink is recreated from the recorded
target **verbatim**, so a `dev → promote → dev` round trip is byte-identical. The old pinned copy
is deleted only after its content hash matches the retained store entry; if the copy was edited in
place, it is preserved under a backup name and a warning prints its path. No recorded source and no
`--source` → refusal (exit 2) naming the flag. Already-dev placements are idempotent no-ops.

**`skillsmith dev --all [--tool <name>]...`** — P12.
Demotes every pinned placement **with a recorded dev source** in the selected tools; pinned
placements without one are skipped with a notice (a fleet-wide `--all` must not stop to ask for
sources). Per-pair results are independent; batch exit code is the highest per-pair code.

**`skillsmith dev --rollback <skill>...`** — P12.
Recovery/undo, direction-agnostic and identical to `promote --rollback`: with an uncommitted swap
journal it restores the journaled before-state; with a committed last transition it performs the
normal inverse flip from the retained ledger records.

Rationale for `--source` being dev-only: `promote` can always read the dev source off the live
symlink, but a pinned copy carries no pointer back to a checkout — the ledger is that pointer, and
`--source` is the adoption path when no ledger record exists. `--source` is only valid with exactly
one target (exit 2 otherwise) and must be a directory containing `SKILL.md`; when it disagrees with
an existing record, `--source` wins and the record is updated.

## Feature table

| # | Feature | Phase | Why |
|---|---|---|---|
| 14.1 | **`skillsmith dev <skill>...`** (alias `demote`) — atomic copy→symlink swap from the recorded dev source, ledger update, store entry retained | P12 | The edit-loop flow: flip back to a live checkout without losing the pin. |
| 14.2 | **`--source <path>`** — adopt a placement with no recorded dev source | P12 | Hand-copied skill dirs (real fleet: several exist under `~/.codex/skills`) have no provenance to read. |
| 14.3 | **`--all`** — fleet-wide demote of recorded placements, skip-with-notice otherwise | P12 | Symmetric with `promote --all`; safe by construction (never guesses a source). |
| 14.4 | **`--rollback`** — journal-based recovery + inverse flip | P12 | Same recovery verb on both commands; the TS02 recoverability acceptance. |

## Flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--all` | — | bool | false | — | Demote every pinned placement with a recorded dev source in the selected tools. Mutually exclusive with positionals. |
| `--tool` | `-t` | enum/repeatable | all tools with a flippable placement | `SKILLSMITH_TOOL` | Restrict to tool(s): `claude-code` \| `codex`. A named tool with no placement for the target → exit 4. |
| `--source` | — | path | — | — | Dev source for a placement with no ledger record. Single target only; must contain `SKILL.md`. |
| `--rollback` | — | bool | false | — | Restore the prior placement state (see above). Not combinable with `--source`. |
| `--dry-run` | — | bool | false | — | Print the per-(skill, tool) operation plan; write nothing, take no lock. |
| `--json` | — | bool | false | — | Emit the versioned `skillsmith.flip` JSON report on stdout. |

Global inherited flags (`-C/--cd`, `--color`/`--no-color`, `-v/--verbose`, `-q/--quiet`, `--debug`)
apply per `skillsmith-cli-design.md §3.1`. `dev` never prompts — the flip is reversible and the
only deletion is hash-guarded — so `--no-prompt` and `--yes` are accepted no-ops.

## Help output

```
Flip a skill from production (pinned copy) back to dev mode (symlink).

USAGE
  skillsmith dev [<skill>...] [flags]

ALIASES
  demote

FLAGS
      --all               Demote every pinned placement with a recorded dev source.
  -t, --tool <name>       Restrict to tool(s): claude-code | codex. Repeatable.
      --source <path>     Dev source for a placement with no recorded source.
      --rollback          Restore the prior placement state (undo / crash recovery).
      --dry-run           Show the plan without changing anything.
      --json              Emit the versioned JSON report on stdout.

INHERITED FLAGS
  (See 'skillsmith help' for details)

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
  0    demoted (or already in dev mode — idempotent no-op)
  1    a flip failed (swap error; state recoverable)
  2    usage error or refusal (no recorded source without --source, unresolved journal, …)
  3    placements ledger unreadable
  4    no placement found for a requested skill/tool
  5    recorded dev source no longer exists on disk
  6    permission error (skills dir or ledger not writable)
  130  cancelled (SIGINT; state recoverable)
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

  Restore the checkout, or re-point it with --source <path>.
Exit code: 5
```

**Pinned copy was edited in place (demote still proceeds):**
```
warning: the pinned copy of 'factor-scan' (claude-code) differs from its store
         snapshot — it was modified in place. The modified copy was preserved at:

           ~/.claude/skills/.skillsmith-backup-factor-scan-9f4c2a17

1 flipped, 1 warning.  Exit code: 0
```

## Open questions

1. **Should `--source` accept `owner/repo` shorthand (cloning on demand) in addition to a local
   path?** Leaning no — fetching is `install`'s job, and P09's source resolver should stay the only
   code that turns a shorthand into a checkout. Revisit when P09's resolver lands, in case reusing
   it here is nearly free.
