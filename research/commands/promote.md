# promote

> P17 disposition: shipped current behavior; future target authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#88-dev-promote

`skillsmith promote` flips a skill placement from **dev mode** (a symlink in the tool's skills
directory pointing into a local source checkout) to **production** (a pinned copy materialized from
the content-addressed store). It is the release half of the `promote` ⇄ `dev` pair: verify the
source with the P11 gate, snapshot it into the store pinned at the source's git SHA, then atomically
swap the symlink for the copy. The flip is lossless — the placements ledger keeps the dev source
recorded, so `skillsmith dev` restores the exact symlink later — and journaled, so an interrupted
swap is always recoverable via `--rollback`.

Full design rationale — placement model, store/rev grammar, ledger schema, the swap state machine
with crash points, and the JSON contract — lives in
`docs/superpowers/specs/2026-07-07-promote-dev-design.md`. This page is the command surface.

## Argument order

```
skillsmith promote [<skill>...] [FLAGS]
```

Zero or more positionals: each `<skill>` is an installed skill name (the leaf directory name in a
tool's user-scope skills root) or a filesystem path to a placement. At least one positional is
required unless `--all` is passed; `--all` with positionals is a usage error (exit 2).

## Commands

**`skillsmith promote <skill>... [--tool <name>]... [--strict] [--no-verify] [--allow-dirty] [--dry-run] [--json]`** — P12.
For each (skill, tool) pair with a dev-mode placement: runs the verify gate against the symlink's
source directory (claude-code → static; codex → deep, the only codex surface that validates
skills), snapshots the skill into `$SKILLSMITH_DATA/store/<ns>/<name>@<rev>/<skill>/` (clean git
tree → `<owner>/<repo>@<sha12>`, the same grammar P09 `install` will use), and swaps symlink →
pinned copy with a journaled, rename-based protocol. No `--tool` means "every tool where this skill
currently has a flippable placement." Already-pinned placements converge: no-op when the store rev
matches the current source, re-pin (`updated`) when the source has moved. Hand-made symlinks that
SkillSmith never created are adopted on first promote — the dev source is recorded from the live
symlink target.

**`skillsmith promote --all [--tool <name>]...`** — P12.
Promotes every dev-mode placement in the selected tools. Per-pair results are independent
(a failure on one pair never blocks the rest); batch exit code is the highest per-pair code.

**`skillsmith promote --rollback <skill>...`** — P12.
Recovery/undo. Per-pair behavior is direction-agnostic (a named `dev --rollback <skill>` behaves
identically): with an uncommitted swap journal it restores the journaled before-state (the recovery
path after an interrupted swap); with a committed last transition it performs the normal inverse
flip from the retained ledger records. A pair with an uncommitted journal refuses every other
operation until rolled back or re-run. Target *selection* stays op-specific, though:
`promote --rollback --all` selects dev-class placements (plus any journaled pair), so undoing a
fleet-wide promote is `skillsmith dev --rollback --all`, not `promote --rollback --all`.

Rationale for the verify-gate defaults: Claude static covers manifest + skills with reasons — it is
the whole gate for Claude. Codex static covers only the manifest, so promoting on it alone would
gate on a green that never looked at the skill; codex deep is auth-free and model-free (P11 §7.4),
costing only ~2-8 s of startup latency. `warn` verdicts pass by default and block under `--strict`;
`--no-verify` skips the gate and is recorded in the ledger as an unverified promotion.

## Dirty and non-git sources

Promotion pins provenance, so the source's git state matters:

| Source state | Behavior | Store rev |
|---|---|---|
| clean git tree | snapshot, record full SHA | `<sha12>` |
| dirty git tree | **refused (exit 2)** unless `--allow-dirty`; then snapshot with warning | `dirty-<hash12>` |
| not a git repo | allowed, notice (provenance is content-hash only) | `content-<hash12>` |

`<hash12>` is a canonical sha256 content hash of the skill directory. A dirty snapshot never claims
its SHA as the rev — the SHA is recorded alongside `dirty: true` instead.

## Feature table

| # | Feature | Phase | Why |
|---|---|---|---|
| 13.1 | **`skillsmith promote <skill>...`** — verify gate, store snapshot @ SHA, atomic symlink→copy swap, ledger record, adoption of unmanaged symlinks | P12 | The release flow for the real fleet (18 hand-made dev symlinks today); seeds P09's store. |
| 13.2 | **`--all`** — fleet-wide promote, per-pair independence | P12 | One command to pin the whole fleet before an upgrade or a demo. |
| 13.3 | **`--rollback`** — journal-based recovery + inverse flip | P12 | The TS02 acceptance: an interrupted swap must leave a recoverable state. |
| 13.4 | **`--allow-dirty`** — opt-in dirty snapshots under `dirty-<hash12>` | P12 | Honest provenance without blocking mid-experiment promotion entirely. |

## Flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--all` | — | bool | false | — | Promote every dev-mode placement in the selected tools. Mutually exclusive with positionals. |
| `--tool` | `-t` | enum/repeatable | all tools with a flippable placement | `SKILLSMITH_TOOL` | Restrict to tool(s): `claude-code` \| `codex`. A named tool with no placement for the target → exit 4. |
| `--strict` | — | bool | false | — | Verify-gate warnings block (exit 1); an inconclusive gate blocks instead of warning. |
| `--no-verify` | — | bool | false | — | Skip the verify gate (recorded in the ledger as `verify: "skipped"`). |
| `--allow-dirty` | — | bool | false | — | Permit snapshotting a dirty git tree under `dirty-<hash12>` with a warning. |
| `--rollback` | — | bool | false | — | Restore the prior placement state (see above). Not combinable with `--strict`/`--no-verify`/`--allow-dirty`. |
| `--dry-run` | — | bool | false | — | Print the per-(skill, tool) operation plan; write nothing, take no lock. |
| `--json` | — | bool | false | — | Emit the versioned `skillsmith.flip` JSON report on stdout. |

Global inherited flags (`-C/--cd`, `--color`/`--no-color`, `-v/--verbose`, `-q/--quiet`, `--debug`)
apply per `skillsmith-cli-design.md §3.1`. `promote` never prompts — flips are reversible by
design — so `--no-prompt` and `--yes` are accepted no-ops.

## Help output

```
Promote a skill from dev mode (symlink) to production (pinned copy).

USAGE
  skillsmith promote [<skill>...] [flags]

FLAGS
      --all               Promote every dev-mode placement in the selected tools.
  -t, --tool <name>       Restrict to tool(s): claude-code | codex. Repeatable.
      --strict            Verify-gate warnings block promotion.
      --no-verify         Skip the verify gate (recorded as unverified).
      --allow-dirty       Allow snapshotting a dirty git tree (rev: dirty-<hash>).
      --rollback          Restore the prior placement state (undo / crash recovery).
      --dry-run           Show the plan without changing anything.
      --json              Emit the versioned JSON report on stdout.

INHERITED FLAGS
  (See 'skillsmith help' for details)

EXAMPLES
  # Pin one skill for both tools it is placed in
  $ skillsmith promote factor-scan

  # Pin the whole fleet, previewing first
  $ skillsmith promote --all --dry-run
  $ skillsmith promote --all

  # Claude only, treat verify warnings as blocking
  $ skillsmith promote factor-scan --tool claude-code --strict

  # Recover after an interrupted swap
  $ skillsmith promote --rollback factor-scan

EXIT CODES
  0    promoted (or already pinned — idempotent no-op)
  1    a flip failed (verify gate failed, snapshot/swap error; state recoverable)
  2    usage error or refusal (dirty tree without --allow-dirty, unresolved journal, …)
  3    placements ledger unreadable
  4    no placement found for a requested skill/tool
  5    dev source unresolvable (dangling symlink)
  6    permission error (skills dir, store, or ledger not writable)
  130  cancelled (SIGINT; state recoverable)
```

## Error and prompt mockups

**`skillsmith promote factor-scan` — success (human output):**
```
Promoting factor-scan  (tools: claude-code, codex)

claude-code  ~/.claude/skills/factor-scan
  verify   static: pass
  snapshot smorinlabs/smorinlabs-harness@3f2a1b9c0d4e  (new store entry)
  swap     dev symlink -> pinned copy                                  flipped

codex        ~/.codex/skills/factor-scan
  note     placement is in legacy ~/.codex/skills (current convention: ~/.agents/skills)
  verify   deep: pass
  snapshot smorinlabs/smorinlabs-harness@3f2a1b9c0d4e  (reused)
  swap     dev symlink -> pinned copy                                  flipped

2 flipped.  Exit code: 0
```

**Dirty source tree without `--allow-dirty`:**
```
error: refusing to promote 'factor-scan': the source tree is dirty.

  /Users/alice/c/smorinlabs-harness has uncommitted changes:
    M plugins/factor-harness/skills/factor-scan/SKILL.md

  Commit the changes, or pass --allow-dirty to snapshot the working tree
  as dirty-<hash> (the pin will not claim a git SHA).
Exit code: 2
```

**Verify gate fails:**
```
Promoting bad-skill  (tools: claude-code)

claude-code  ~/.claude/skills/bad-skill
  verify   static: fail
    ✘ claude.frontmatter   SKILL.md
        YAML frontmatter failed to parse: YAML Parse error: Unexpected character.

error: promotion blocked: 'bad-skill' failed verification for claude-code.
  Fix the findings above, or pass --no-verify to promote unverified.
Exit code: 1
```

**Interrupted swap detected on a later run:**
```
error: 'factor-scan' (claude-code) has an unfinished placement swap
       (op: promote, phase: backed-up, started 2026-07-07T18:20:10Z).

  Run 'skillsmith promote --rollback factor-scan' to restore the previous state,
  or re-run 'skillsmith promote factor-scan' to complete the swap.
Exit code: 2
```

## Open questions

1. **Should P09 `install` reuse the P12 swap journal for its own store-symlink placements?** The
   journal/rollback machinery is placement-generic by construction; P09 could adopt it for install
   swaps (making `--rollback` a universal recovery verb) or keep install simpler since it only ever
   creates new entries. Does not change P12 behavior — P12's journal is self-contained either way.
