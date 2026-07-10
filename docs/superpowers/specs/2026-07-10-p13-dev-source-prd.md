# P13 PRD — `dev --source`: create + adopt dev placements

**Status:** APPROVED — decisions D1–D5 locked with Steve via walkthrough,
2026-07-10 · **Author:** Fable · **Issue:** #9 · **Plan:**
`docs/superpowers/plans/2026-07-10-p13-dev-source-plan.md`

## Goal

`skillsmith dev <name-or-path> --source <path>` becomes the one command that
puts a local checkout's skill into dev mode: **create** when no placement
exists, **adopt (record-only)** when a matching hand-made symlink exists,
today's flip behavior otherwise. Removes the last `ln -s` from downstream
tooling (smorin-harness `skill-create`).

## CLI surface

```
skillsmith dev <name-or-path> --source <path> [--tool <t>]... [--dest <path>]
              [--no-verify] [--strict] [--dry-run] [--json]
```

- `<name-or-path>`: skill name (placement resolved per tool) or explicit
  placement path. `--source`: local dir containing `SKILL.md`; resolved to an
  **absolute** path before any use or recording (never record a relative
  source — sidesteps #10 for all new records).
- No `--tool` → both default tools (claude-code, codex), pairs processed in
  the existing fixed order; pairs remain independent (one pair's refusal does
  not stop the next — unchanged from P12 semantics).
- `--dest <path>` overrides the **default destination location** for the
  created placement; requires exactly one `--tool` (usage error otherwise —
  an unscoped path is ambiguous across tools).
- `--all` with `--source` is a **usage error (exit 2)**. Create/adopt are
  inherently targeted; `--all` gains no new semantics (see also bug #11).

## State machine (per (skill, tool) pair, when `--source` is given)

| # | Placement state | Behavior | Action | Exit contrib. |
|---|---|---|---|---|
| S1 | absent | validate source → verify gate → **staged-rename symlink** → ledger dev record | `created` | 0 |
| S2 | dev symlink, `readlink` == resolved source, **not** in ledger | validate + verify gate → ledger dev record; **disk untouched** | `adopted` | 0 |
| S3 | dev symlink, recorded, matching | nothing | `noop` | 0 |
| S4 | dev symlink, `readlink` != resolved source | refuse — never silently repoint | `refused` | 2 |
| S5 | pinned | **unchanged P12 behavior** (`--source` may fill a missing recorded source, as today; recorded-source mismatch → refuse) | (existing) | (existing) |
| S6 | placement exists but is a real file/dir that is not a pinned copy | refuse (foreign object) | `refused` | 2 |

Validation (S1/S2): source dir exists, contains `SKILL.md`; source basename ≠
placement name → **warning**, not refusal. Codex dual-root presence → refuse
(existing rule).

## The five decisions (resolved)

**D1 — Destination locations: modern convention, verified (Steve, walkthrough).**
Default destination locations are Claude Code (`~/.claude/skills`) and Codex's
**current** convention — believed to be `~/.agents/skills` per
`agents/codex/skill-roots.ts`, but **T0 double-verifies against live Codex
behavior and upstream docs before any test pins it**. Once verified, that
location is the create-target AND the consistent default across skillsmith
(doctor guidance, install paths — audit for stragglers). `--dest` provides the
per-invocation override. A skill never gets symlinks in two Codex locations
(dual-location refusal stands). **Downstream (post-P13): migrate all 22 legacy
`~/.codex/skills` placements to the verified location** using `dev --source`
itself (per skill: uninstall legacy → create modern; pilot-first, sequential).

**D2 — Verify gate: static by default for both create and adopt.** Hermetic,
auth-free, catches the frontmatter-rot class (proven twice in the fleet).
`--no-verify` skips; `--strict` upgrades warnings/inconclusive to blocking.
Gate failure → `refused`-style failure, exit 1, **nothing written**. Deep is
not run here (promote's pinning gate keeps its own semantics).

**D3 — Crash safety by state-machine convergence; no new journal op.** Write
order is symlink first (staging name + atomic `rename`), ledger second. A
crash between the two leaves exactly state S2 — re-running the same command
adopts and converges. Idempotent by construction; the journal field stays
absent for create/adopt pairs. Rollback-of-create is **out of scope v1**:
removal is `skillsmith uninstall` (T2 adds a test that uninstall handles a
dev-created pair; if it refuses, that's a finding for a follow-up, and manual
`rm` + doctor parity covers the gap).

**D4 — FlipReport contract: schemaVersion 1 → 2.** New `action` values
`created` / `adopted`; new `summary.created` / `summary.adopted` counters
alongside flipped/refused/failed. Enum growth is a real contract change; the
only consumers today are our own skills, so bump honestly now while it is
cheap. Renderer + contract tests updated together.

**D5 — `--all`: untouched.** Usage error when combined with `--source`; no
`--all` code path grows create/adopt behavior.

## Ledger record shape

S1/S2 write the existing `dev` record shape (sourcePath/resolvedPath/repoRoot/
sourceRelPath/remote/recordedAt) with **no `pinned` and no `journal` field** —
a new legal shape. T2 must audit every reader for pin-assumptions: pair
selection in `plan.ts`, the rollback planner, promote's retained-snapshot
reuse, doctor/list surfaces. Repo metadata (repoRoot/remote): derived as in
promote adoption; a source outside any git repo → record with `repoRoot`/
`remote` null if the schema tolerates it, else refuse (T2 pins the actual
schema tolerance; whichever way, the behavior is explicit and tested).

## Test matrix (T2 writes these failing-first)

State machine S1–S6 × both tools · absolute-resolution of relative `--source` ·
`--all --source` usage error · `--dest` override (honored with one `--tool`;
usage error unscoped; recorded placementPath reflects it) · codex default
destination = the T0-verified location · verify-gate block (S1 and S2) + `--no-verify` +
`--strict` · dual-root refusal · basename-mismatch warning · ledger shape
(dev-only record; no pin/journal) · pin-assumption audit (plan/rollback/list
against a dev-only record) · idempotent re-run (S1 → S3; simulated crash
state → S2 → converged) · `--dry-run` predicts without writing · JSON contract
v2 (actions, counters) · uninstall of a dev-created pair.

## Acceptance

- Live e2e (drift canary extension, sandboxed `SKILLSMITH_HOME`): create on
  both tools from a real checkout; adopt of a pre-made `ln -s`; re-run noop.
- Downstream proof (T8): smorin-harness `skill-create` wire step = one
  `skillsmith dev --source` call per tool; one real fleet skill re-wired
  through it on this machine.
- Issue #9 closed citing shipped semantics; release-please cuts v0.7.0.

## Out of scope

Rollback-of-create (v1) · `install` local-path sources · `--all` growth · any
change to promote's gate semantics. (Codex fleet migration to the verified
modern location is IN scope as a downstream task, per D1.)
