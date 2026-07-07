# SkillSmith P09 design — `install` / `uninstall` — the acquisition verbs

**Status:** Draft (2026-07-07). This is the P09-BR deliverable.
**Design gate:** Adjudicated 2026-07-07 by the project owner. All decisions ratified; D10 amended
to add an opt-in `--deep` flag (O3's alternative, chosen over ship-static-only-and-revisit); O1
deferred to a follow-up project. See §18 for the per-question record.
**PRD:** `docs/superpowers/specs/2026-07-07-p09-install-prd.md` (approved 2026-07-07) — every
R#/F#/U#/Q# requirement cited below is binding; this spec elaborates them into a buildable design.
**Scope:** Two new commands. `skillsmith install <source>[@<ref>]…` fetches a skill from a git
host via a blobless partial clone, pins it into the existing content-addressed store, places it for
the chosen tools/scopes (store symlink by default, `--direct` copy), and records provenance in the
placements ledger. `skillsmith uninstall <skill>…` (aliases `rm`, `remove`) removes placements and
ledger records; store entries are immortal.
**Release framing:** `v0.6.0` (minor `feat` — two new commands, additive ledger fields).
**Consumes:** P12 store/ledger/swap (`packages/core/src/place/*`), P11 verify
(`packages/core/src/verify/*`, `agents/*/verify.ts`). Reuse, never reinvent.
**Interop contract:** completes the lifecycle `install → verify → dev ⇄ promote → uninstall` with
one store, one ledger, one provenance model. §2.2 amends P12's `store-linked` refusal so
install-then-hack (PRD scenario 4) works.
**Supersedes:** the April drafts of `research/commands/install.md` / `uninstall.md` (rewritten with
this spec) and P12 §1.1's forward-reference to "P09's reference-counted uninstall" GC — the PRD
locks store entries as write-once and never deleted, with **no GC in v1** (PRD §7, §8).

---

## 1. Background and goal

SkillSmith v0.5.0 can verify skills (P11) and flip existing placements between dev and production
(P12), but acquiring a skill from a remote source is still `git clone` + `ln -s` by hand. P09 adds
the acquisition verbs on top of the machinery P12 already shipped:

- The **store** (`$SKILLSMITH_DATA/store/<ns>/<name>@<rev>/<skill>/`) already exists, is
  write-once, and its rev grammar was designed for exactly this feature (P12 D6: "the seed of
  P09's store"). Install only ever mints `<owner>/<repo>@<sha12>` entries.
- The **ledger** (`placements.json`, schemaVersion 1) already records per-(skill, tool) placement
  state. Install extends it additively: an `origin` record (PRD F2), a pinned placement-form
  discriminator, and a project-scope subtree (§7).
- The **swap engine** (journaled, rename-based, crash-recoverable) already knows how to replace a
  live placement atomically. Install reuses it for placement creation and replacement (PRD F3);
  uninstall reuses it for placement removal.

What is genuinely new: the **source grammar and resolver** (§5), the **fetch pipeline** (§6), the
**scope model** (project scope enters the ledger for the first time, §2.1/§7.3), the
**uninstall destruction semantics** (§9), and the **security floor** — PRD F9: install executes
nothing from the fetched repo **by default**. No hooks, no scripts, no feeding fetched bytes to an
agent binary — unless the operator opts in with `--deep` (D10, §10), which is documented informed
consent to run the codex binary's loader against fetched content, pre-placement. Every decision
below is checked against F9's default floor.

### 1.1 Non-goals (this feature)

Per PRD §8, all explicit: `sync`/`apply` manifests · cross-tool adaptation (the April `adapted/`
overlay model is dead for v1 — the store copy is placed as authored) · kilo-code/opencode targets
(agent dirs keep their stubs) · registries and one-part names (reserved, rejected loudly) ·
lifecycle hooks · an `update` verb (deliberate upgrade = `install --force --ref`, PRD scenario 5) ·
marketplace addressing · store GC/pruning · Windows · `system` scope (deferred) · values layering,
`--set`, `--path` overrides (April-draft features not carried into v1) · auth/token plumbing
(`SKILLSMITH_TOKEN*` from the design doc §6.3 is deferred; git's own credential machinery is what
runs — see §6.5).

---

## 2. The placement model (scopes, classes, and the P12 amendment)

### 2.1 Scopes and roots

P09 introduces the `--scope` axis (PRD F5): `user` and `project`; `system` deferred. Roots come
from the existing per-agent `skill-roots.ts` (never hardcode paths elsewhere):

| Tool | user scope | project scope | legacy (read-only) |
|---|---|---|---|
| claude-code | `~/.claude/skills` (honors `CLAUDE_CONFIG_DIR`) | `<projectRoot>/.claude/skills` | — |
| codex | `~/.agents/skills` | `<projectRoot>/.agents/skills` | `~/.codex/skills` (honors `CODEX_HOME`) |

Sources: `agents/claude-code/skill-roots.ts`, `agents/codex/skill-roots.ts` (project case).
`<projectRoot>` = the git toplevel containing `cwd` (realpath basis, from
`git rev-parse --show-toplevel`); outside a git repo, `cwd` itself is the project root candidate
but the **default** scope is then `user` (D8). Codex's legacy root is never written by install
(D15); it is read for conflict detection and is a first-class *removal* location for uninstall.

Default scope: `project` when `cwd` is inside a git work tree, else `user` (PRD F5). Explicit
`--scope user|project` (sugar `--user` / `--project`) overrides.

### 2.2 Placement classes — the P12 §2 amendment

P12 classified `store-linked` (symlink whose resolved target is inside the store root) as
non-flippable, "managed by `install`; cannot occur before P09 ships". P09 ships. The class table
is amended as follows (this is the resolution of the store-linked design tension, D9):

| Class | On disk | `promote` | `dev` | `install` | `uninstall` |
|---|---|---|---|---|---|
| `dev` | symlink outside the store | flip (unchanged) | no-op (unchanged) | refuse; `--force` replaces after adopting the link target into the dev record (§8.4) | **refuse** (U3) unless `--force` |
| `pinned` | real directory | converge (unchanged) | flip (unchanged) | refuse; `--force` replaces (backup kept unless hash-matched, §8.4) | remove; unmanaged (no ledger pair) refused unless `--force` (§9.2) |
| `store-linked` | symlink into the store | **converge like `pinned`** when the pair has a dev record: no-op if the dev source's rev matches, re-pin if moved — the re-pin *honors the recorded placement form* and re-creates a store symlink to the new entry (D9). No pair record → refused ("managed state missing; reinstall with `skillsmith install --force`"). | **accepted**: with a recorded dev source, or with `--source <path>` (the install-then-hack path, PRD scenario 4). Swaps store-symlink → dev-symlink; pinned record and store entry retained (P12 D5). | idempotence check (F7): same rev → no-op; new rev/`--force` → replace swap | remove (the normal case) |
| `absent` | nothing | exit 4 (unchanged) | exit 4 (unchanged) | **place** (fresh install) | convergent no-op, exit 0 (§9.1) |

What stays refused from P12: `promote`/`dev` on a store-linked placement with **no ledger pair**
(a hand-made symlink into the store — SkillSmith cannot know its origin; `dev --source` is the one
escape, since adoption records everything it needs). P12's shipped tests remain conceptually valid:
they asserted refusal for store-linked pairs *without records*, which is exactly the state that
existed before P09; pairs written by install carry records and take the new paths above.

Ledger representation (design tension 2, D6/D7): the on-disk `store-linked` class is **not** a new
ledger mode. The pair records `mode: 'pinned'` (PRD F2) and the additive field
`pinned.placement: 'symlink' | 'copy'` distinguishes the materialization; absent means `'copy'`
(every P12-written record). `classifyPlacement` (`agents/placement-shared.ts`) is unchanged — the
run layers map (`mode: 'pinned'` + `placement: 'symlink'`) ⇔ on-disk `store-linked`.

Dot-prefixed entries in skills roots remain invisible to detection (P12 §2); install's staging and
backup names reuse P12's reserved dot-names (§8.2).

---

## 3. Design decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Two flat verbs: `skillsmith install <source>…` (alias `i`) and `skillsmith uninstall <skill>…` (aliases `rm`, `remove`).** | Flat verb-first surface and the exact alias set fixed by `skillsmith-cli-design.md` §5 and PRD U1. |
| D2 | **Source grammar per PRD §3, parsed by a single deterministic pure function** (§5): ref separator = the last `@` in the source iff it occurs after the last `/`; host-explicit = first segment contains a `.` (or `:port`); `//` splits the repo path from the in-repo skill path; >3 sugar segments without `//` are rejected (subgroups must use `//` or host-explicit ≤4-segment forms). One-part names rejected (R5); filesystem paths rejected with `dev --source`/`promote` guidance (R6). | Every rule is decidable without network or filesystem probes — parse errors are instant, deterministic, and offline. The last-`@`-after-last-`/` rule makes scp `git@host:…` and `https://user@host/…` unambiguous per R4. GitHub owner names cannot contain dots, so the dot test cleanly separates hosts from owners (R7 forms). |
| D3 | **Name resolution runs against the fetched tree listing, not a checkout** (R1): `git ls-tree -r --name-only <sha>` enumerates every path; candidate skills are directories containing `SKILL.md` at any depth; a name selector matches candidates whose directory basename equals the name (case-sensitive). Zero matches → exit 5; >1 match → TTY picker, non-TTY list + exit 2 (R2). Bare `owner/repo` → exactly one candidate installs, several → TTY picker, non-TTY list + exit 2 (R3/Q1). | The tree listing needs no blobs (F1's blobless clone stays blobless through resolution). The picker applies to both R2 and R3 in a TTY — R2's "non-TTY never guesses" defines the non-TTY arm; Q1 fixes the TTY pattern; one consistent UX. |
| D4 | **The TTY picker is a callback injected by the CLI** (`InstallDeps.pick`); core never prompts. The CLI wires `@clack/prompts` `select()` only when stderr+stdin are TTYs and neither `--no-prompt` nor `--json` is set; otherwise `pick` is absent and ambiguity is a refusal (exit 2, candidates listed). `--yes` is an accepted no-op — the picker is a *choice*, not a confirmation, so `--yes` never auto-picks. | Core purity (CLAUDE.md: `@clack/prompts` is CLI-only; the stack summary approves it there). Injection keeps `runInstall` unit-testable with a scripted picker. Disabling under `--json` keeps stdout a single JSON value (§6.2 of the design doc). |
| D5 | **Fetch = `git init` + `git fetch --filter=blob:none --depth 1 origin <ref>` + `ls-tree` scan + cone `sparse-checkout` of only the selected skill directory** into `<dataDir>/.fetch/<txId>/` (§6). Ref → SHA via `FETCH_HEAD`; full-SHA refs fetched directly; short SHAs rejected. All git via `env.exec` (P11 primitive); no new runtime deps (PRD §7). | Blobless + sparse means the network cost is one packfile of trees plus the blobs of the one skill subtree — the repo is never installed (PRD §4) and never even fully materialized. `--depth 1` drops history; GitHub/GitLab both allow full-SHA `fetch` and `--filter`. |
| D6 | **Ledger stays schemaVersion 1; every P09 field is additive** (§7): `PairRecord.origin?`, `PinnedRecord.placement?`, `LedgerFile.projects?`, `Journal.before.liveKind?`. **Two deliberate enum widenings** — `Journal.op` gains `'install' | 'uninstall'` and `Journal.before` gains an `{ mode: 'absent' }` variant — are confined to crash windows: install/uninstall null the journal in the same ledger write that commits the terminal pair state, and every locked v0.6.0 batch runs a journal-hygiene sweep that completes any lingering committed acquisition journal. A v0.5.0 binary reading a ledger *during* such a crash window fails loudly (exit 3) rather than misinterpreting it. | PRD F2 mandates schemaVersion 1 + additive `origin`. PRD F3 mandates reusing P12's swap **+ journal**, which forces the ops into the journal enum; the alternative (a second journal file) splits crash-truth across two files and re-opens every §8.4 invariant. Adjudication per the additive-evolution rule: the widened values are never at rest in a healthy ledger, recovery requires the same-or-newer binary that wrote them, and versions move forward in lockstep pre-1.0. Known limitation recorded: any v0.5.0 binary that *rewrites* the ledger strips additive fields (zod strips unknown keys before `writeLedger`) — acceptable pre-1.0, noted for the P14 packaging review. |
| D7 | **Default placement = store symlink; `--direct` = plain copy materialized *from the store entry*** (never from the fetch dir). Both are recorded as `mode: 'pinned'` with `pinned.placement: 'symlink' | 'copy'`. The store entry is created in every case — `--direct` changes only the placement materialization, not provenance. | PRD §4 placement table. Copying from the store (not the fetch dir) means the placement is provably byte-identical to the pinned entry (`contentHash` verified by the swap's staging check), and `--direct` keeps the full round-trip/`dev`/`promote` interop of a P12 `pinned` placement. |
| D8 | **Scope default: `project` inside a git work tree, else `user`; project-scope pairs live in an additive `LedgerFile.projects` subtree keyed by the project root's realpath** (§7.3). The user-scope `skills` tree is untouched. `promote`/`dev` remain user-scope-only (P12 §16 stands; O1, deferred at the design gate — §18). | PRD F5. Keying by realpath states the path basis explicitly (P12 carry-forward): it matches `git rev-parse --show-toplevel`'s realpath output, so the same repo reached via a symlinked path maps to one key. Mirroring the `skills` shape keeps one PairRecord schema and lets uninstall/list code share record handling. |
| D9 | **Store-linked flip amendment** (§2.2): `dev` accepts store-linked (recorded source or `--source`); `promote` on the resulting dev placement — and convergence on a store-linked placement itself — honors `pinned.placement`, re-creating a store *symlink* for installed skills instead of a copy. Store-linked with no pair record stays refused for `promote`; `dev --source` may adopt it. | PRD scenario 4 requires exactly this loop: `install → dev --source <clone> → promote` must end managed and pinned *in the same placement form install chose*, or the acquisition verb and the flip verbs fight each other. Honoring the recorded form makes `promote` mean "make production current" (P12 D13) without silently converting a symlink fleet into copies. |
| D10 | **Verify gate: mode `static` for both tools by DEFAULT, on the fetched skill, before snapshot** (PRD F6/Q3), **plus an opt-in `--deep` flag (bool, default `false`) amended in at the design gate 2026-07-07 — O3's alternative, chosen over ship-static-only-and-revisit.** claude-code's gate is unaffected by `--deep`: its static already covers manifest + skills, the whole gate (P11), so there is nothing deep adds. Codex's gate, under `--deep`, runs **static + deep** — the promote-parity gate — on the *fetched* skill, at the exact pipeline point the static gate already runs (before snapshot/placement, §10). Blocking policy is identical under `--deep` and the default: `fail` blocks (exit 1), `warn` blocks under `--strict`, `inconclusive` warns or blocks under `--strict`; `--no-verify` skips and records `verify: "skipped"`. `--deep` combined with `--no-verify` is a flag contradiction — usage refusal, exit 2 (§13/§14). **Codex deep is still NOT run by default**: deep launches the codex binary, which loads and parses the just-fetched skill — feeding untrusted bytes to a local agent binary is exactly what F9's *default* floor exists to prevent at acquisition time. `--deep` is documented informed consent to do exactly that, pre-placement, not a change to the default. The codex coverage gap under the default gate (static is manifest-only, P11's central finding) is accepted and documented: the remediation is `--deep` itself, or a post-install `skillsmith verify <skill> --deep`; `promote` (scenario 4) still gates deep unconditionally. | Q3 locked "on, static" as the default, and F9's default floor is absolute — install executes nothing from the fetched repo unless the operator opts in. The gate's result transfers to the placed artifact because the store snapshot is contentHash-verified byte-identical to the verified source (same transfer argument as P12 D11). The design gate chose the opt-in over O3's original ship-static-only recommendation: explicit, greppable consent (same rationale as D16's `--force`) turns a silent coverage gap into a documented choice without weakening the default floor for the common case. |
| D11 | **Install transaction per (source, tool, scope), in PRD order: resolve → fetch → verify → snapshot → place → record.** Resolve/fetch/verify/snapshot run once per source; place+record run per (tool, scope) as independent journaled swaps (P12 D12 per-tool transactions). Placement uses the P12 swap engine with a new journal op `'install'`: fresh installs have `before: { mode: 'absent' }` and degenerate to stage→publish (no backup); replacements (`--force`, new rev) run the full two-rename protocol. The journal is nulled in the commit write. | PRD F3 verbatim ("per-tool transactions via P12's swap + journal"). Reuse means the §8.4 crash table, `--rollback` reachability via `plan.ts`'s open-journal surfacing, and the SIGKILL e2e harness all apply to install for free (§8.5). |
| D12 | **Uninstall removes the placement and the entire PairRecord** — dev record, pinned record, origin history — for each selected (skill, tool, scope); store entries are never deleted (U1, PRD §7). Dev-mode placements are refused with `promote`/`dev --rollback` guidance unless `--force` (U3). Placements with no ledger pair are refused unless `--force` (SkillSmith didn't create them; an unmanaged pinned dir has no store copy, so with `--force` its backup is kept unless hash-matched — the D14-P12 pattern). Absent everywhere → convergent no-op, exit 0 with a notice (ratified at design gate 2026-07-07). | Uninstall is the one deliberate destruction verb: keeping zombie records for removed placements would make the ledger lie to `list`/detection. The accepted loss — a pinned-mode pair's retained dev record dies with the pair — is recoverable by `dev --source` after a reinstall, and the removal report prints everything being forgotten. P12's D5 ("flips never delete the opposite record") is untouched: it constrains flips, not uninstall. |
| D13 | **Batch semantics (F8): sources process sequentially; fail-fast — a source-level failure stops scheduling later sources (reported `skipped`) unless `--continue-on-error`. ONE ledger lock per invocation, acquired before the first mutation and held across the entire batch** (fetch and verify included). Exit code = highest per-result code in both modes. | The one-lock rule is the P12-T02 carry-forward codified by F8 (per-skill locking exhausts proper-lockfile retries at 25-way fan-out). Holding it across fetch/verify follows P12 precedent (the promote gate already runs codex ~2–8 s under the lock); a concurrent invocation waits or fails loudly. Batch-max exit is strictly more informative than the design doc §6.1's "`--continue-on-error` ⇒ exit 1"; the divergence is deliberate and recorded here — one uniform batch-max rule across every multi-target skillsmith verb (P12 established it). Ratified at design gate 2026-07-07. |
| D14 | **Idempotence (F7) is convergent:** same source → same resolved rev → placement intact and recorded → `noop`, exit 0. `--force` re-executes (action `updated`) — including same-rev re-place and deliberate up/downgrade via `--ref` (scenario 5). A placement on disk with no ledger record but matching the resolved store entry (crash between place and record, or hand-made) is converged by re-recording (action `repaired`). | House idempotence §1.5. `repaired` keeps the crash story honest without a repair verb: re-running the same install always converges. |
| D15 | **Codex roots: install writes only the current-convention roots** (`~/.agents/skills`, `./.agents/skills`); the legacy root is read-only for install. Skill already present in the legacy root → refuse (exit 2) with "uninstall it from the legacy root first: `skillsmith uninstall <skill> --tool codex`". **Uninstall treats legacy-root placements as first-class removable** (with the P12 legacy notice). No auto-migration in v1: migration = `uninstall` + `install`. | Writing the current root is the placement-creation decision P12 §10.2 explicitly deferred to P09. Auto-migrating on `--force` would make install delete things outside its target root — a destruction side-effect the destruction verb should own instead. Installing alongside a legacy copy would mint the dual-root conflict P12 refuses to flip. |
| D16 | **Neither verb ever asks a confirmation question.** Install's only interaction is the R2/R3 picker (D4). Uninstall never prompts: removals of managed placements are recoverable (store immortal + reinstall), and the two data-loss hazards (dev-mode links, unmanaged dirs) are gated by `--force`, not prompts; `--yes`/`--no-prompt` are accepted (picker-relevant for install, no-ops for uninstall). | Same CI-safety rationale as P12 D14. Prompt-gating destruction invites `--yes`-blindness; `--force` is greppable in scripts and history. |
| D17 | **Dead-PID ledger-lock detection (PR #5 follow-up #2): deferred with rationale.** After SIGKILL, `proper-lockfile`'s mtime staleness frees the lock in ≤ 30 s (`stale: 30_000`); the journal — not the lock — guarantees consistency (P12 §7.1). PID liveness checks are unreliable (PID reuse, containers) and lockfile's staleness mechanism is the vetted path. Recorded as accepted latency: worst case, the next skillsmith command after a SIGKILL waits ~30 s. | The follow-up asked adopt-or-defer; the 30 s orphan window is a laptop-CLI annoyance, not a correctness hazard, and shrinking it buys complexity in the exact code whose simplicity the crash proofs depend on. Revisit if fleet automation ever runs skillsmith in tight loops. |

`$SKILLSMITH_DATA` / `<dataDir>` throughout = `resolveDataDir` in `packages/core/src/place/paths.ts`
(`$SKILLSMITH_HOME`, else `$XDG_DATA_HOME/skillsmith`) — reused, not reinvented (PRD §4).

---

## 4. CLI surface

```
skillsmith install   <source>[@<ref>] [<source>...]
                     [--tool claude-code|codex]... [--scope user|project | --user | --project]
                     [--ref <ref>] [--pin] [--direct] [--force]
                     [--strict] [--no-verify] [--deep]
                     [--continue-on-error] [--dry-run] [--json]
skillsmith i         …            # built-in alias

skillsmith uninstall <skill>... [--tool claude-code|codex]...
                     [--scope user|project | --user | --project] [--all-scopes]
                     [--force] [--dry-run] [--json]
skillsmith rm | remove …          # built-in aliases
```

### 4.1 `install` flags

| Flag | Short | Type | Default | Semantics |
|---|---|---|---|---|
| `<source>…` | — | positional, ≥1 | — | Source references per the grammar (§5). Each may carry its own `@<ref>`. |
| `--tool` | `-t` | enum, repeatable | all **detected** tools | Target tool(s): `claude-code`, `codex` (F4). Auto mode places for every detected tool and skips undetected ones silently; an explicitly named tool that is not detected → exit 4 with its install hint (`agents/<tool>/install-hint.ts`). No tool detected at all → exit 4. Detection = the existing `agents/<tool>/detect.ts`. |
| `--scope` | `-s` | enum | `project` in a git work tree, else `user` | `user` or `project` (F5; `system` rejected with "deferred"). |
| `--user` / `--project` | — | bool | — | Sugar for `--scope=user` / `--scope=project`. Combining contradictory scope flags → exit 2. |
| `--ref` | — | string | `HEAD` (remote default branch) | Canonical ref flag (R4). Only valid with exactly one `<source>` (exit 2 otherwise); conflicts with that source's `@<ref>` suffix → exit 2. |
| `--pin` | — | bool | off | Records `origin.pin: true` — the resolved SHA is frozen against any future `update`-class verb (R4). The resolved SHA is *always* recorded either way; `--pin` is a policy marker, not a resolution change. |
| `--direct` | — | bool | off | Place a plain copy (materialized from the store entry) instead of a store symlink (D7). |
| `--force` | `-f` | bool | off | Re-execute an idempotent no-op; replace an existing placement of any class (dev links are adopted into the dev record first, §8.4); override cross-scope shadowing (F5/F7). |
| `--strict` | — | bool | off | Verify-gate `warn`/`inconclusive` block (D10). |
| `--no-verify` | — | bool | off | Skip the verify gate; `pinned.verify: "skipped"` recorded (F6). |
| `--deep` | — | bool | off | Opt in to the promote-parity verify gate (D10, amended at the design gate): codex runs static + deep on the fetched skill, at the same pipeline point the static gate runs, before snapshot/placement; claude-code is unaffected. Conflicts with `--no-verify` (both set → exit 2, usage refusal). |
| `--continue-on-error` | — | bool | off | Keep processing later sources after a source-level failure (F8/D13). |
| `--dry-run` | — | bool | off | Full plan (F10): parses, fetches (read-only; no lock, no store/ledger writes), resolves names and SHAs, prints per-(source, tool, scope) actions incl. shadowing and idempotence verdicts. |
| `--json` | — | bool | off | Versioned JSON report on stdout (§12); disables the picker (D4). |
| `--yes` / `--no-prompt` | `-y` / — | bool | off | `--no-prompt` forces non-TTY picker behavior (list + exit 2 on ambiguity); `--yes` is an accepted no-op (D4/D16). |

Inherited global flags apply unchanged (`-C/--cd`, `--color`/`--no-color`, `-v`, `-q`, `--debug`;
design doc §3.1).

### 4.2 `install` pipeline (per source, then per (tool, scope))

1. **Parse** (§5): pure; any grammar rejection is exit 2 before any I/O.
2. **Plan targets:** tools (detected or `--tool`), scope (D8). Pre-place checks that need no
   network (scope-flag conflicts, unknown tools) fail here.
3. **Fetch + resolve** (§6): resolve ref → full SHA; enumerate candidate skills from the tree
   (D3); apply the selector (name / `//path` / whole-repo), picker on ambiguity (D4). Fetch is
   **elided** when the store already holds the resolved entry (§6.4).
4. **Verify gate** (§10): static by default for both tools requested for this source (codex also
   runs deep under `--deep`, D10), against the fetched skill dir (or the store entry when fetch was
   elided). Runs once per (source, tool).
5. **Snapshot** (§7.1): `snapshotToStore` with provenance built from the *parsed source* (not
   `git remote`): `ns/name` = clamped repo path (§7.2), rev = `<sha12>`. Idempotent reuse when the
   entry exists (`reused: true`); content mismatch at an existing `@<sha12>` = integrity error,
   exit 1 (P12 §6.3 unchanged).
6. **Place** — per (tool, scope), each an independent journaled swap (§8): shadowing check (F5,
   §11.2) → idempotence check (F7, D14) → fresh publish or replace swap.
7. **Record** — the pair's terminal state (mode `pinned`, `pinned` record with `placement`,
   `origin`, dev record if adopted) persists in the same ledger write that nulls the journal (D6).
8. **Cleanup:** the source's `.fetch/<txId>` dir is removed on success *and* failure (F1).

Steps 3–8 run under the single invocation-wide ledger lock (D13); step 8's sweep guarantee is
backstopped by the orphan sweep (§6.3).

### 4.3 `uninstall` flags

| Flag | Short | Type | Default | Semantics |
|---|---|---|---|---|
| `<skill>…` | — | positional, ≥1 | — | Installed skill names (leaf directory names) or placement paths (P12 D2 targeting). |
| `--tool` | `-t` | enum, repeatable | every tool where the skill is found | Restrict to tool(s). Uninstall needs no binary detection — it operates on directories and the ledger. |
| `--scope` | `-s` | enum | see U2 resolution below | `user` or `project`. |
| `--user` / `--project` | — | bool | — | Sugar, as install. |
| `--all-scopes` | — | bool | off | Remove from user scope *and* the current project's scope (U2). Other projects' records are reachable only via `-C <dir>`. |
| `--force` | `-f` | bool | off | Override the dev-mode refusal (U3) and the unmanaged-placement refusal (D12). |
| `--dry-run` | — | bool | off | Print the removal plan; no lock, no writes (U4). |
| `--json` | — | bool | off | Versioned JSON report (§12.2). |
| `--yes` | `-y` | bool | off | Accepted no-op — uninstall never prompts (D16, satisfies U4's flag list). |

**Scope resolution (U2):** with no scope flag, the search set is user scope + the current project
scope (+ codex legacy root). Found in exactly one scope → remove there. Found in more than one →
list every (scope, tool, path) match and exit 2; disambiguate with `--scope`, `--tool`, or
`--all-scopes`. Found nowhere → convergent no-op, exit 0 with a notice (D12).

---

## 5. Source grammar

### 5.1 Forms (PRD §3, binding)

```
<source> :=
  owner/repo                       # GitHub sugar; whole-repo (R3)
  owner/repo/<name>                # GitHub sugar; skill by name, repo-wide scan (R1)
  owner/repo//path/to/skill        # sugar + explicit path
  <host>/owner/repo[/<name>]       # host-explicit (dot or :port in first segment); no config (Q4)
  <host>/repo/path//path/to/skill  # host-explicit + subgroups via `//` (R7)
  <git-url>[//path/to/skill]       # https/ssh/scp URL; `//` = explicit in-repo path
Every form may end with @<ref> after the path portion (R4).
```

### 5.2 Parse algorithm (pure, ordered)

1. **Ref split:** the ref separator is the **last `@` in the source iff it occurs after the last
   `/`**. Split there → `(body, ref)`. This never fires inside scp `user@host` (the `@` precedes
   `host:owner/…`'s slashes) or URL userinfo (`https://user@host/…`). An `@` in the body *before*
   the last `/` that is not part of a URL/scp authority → reject: "place `@<ref>` after the path
   portion".
2. **URL detection:** `body` contains `://` → URL form (scheme ∈ `https`, `http`, `ssh`, `git`);
   or matches scp form `^[^/\s]+@[^/:\s]+:` → scp form. Split an optional `//path` from the URL's
   *path portion* (the first `//` after the authority). Repo path = URL path segments,
   `.git`-stripped.
3. **Local-path rejection (R6):** `body` starts with `/`, `./`, `../`, `~`, or is `.`/`..` →
   reject with "install acquires remote sources only — for a local checkout use
   `skillsmith dev <skill> --source <path>` then `skillsmith promote <skill>`".
4. **Sugar / host-explicit:** split an optional `//skillpath` (first `//`); a *trailing* bare `//`
   means "whole repo" (needed for subgroup repos, D2). Split the base on `/`:
   - first segment contains `.` or `:` → **host-explicit**: `host / seg…`. After the host:
     2 segments = repo, whole-repo mode; 3 segments = repo + `<name>` selector; ≥4 segments
     without `//` → reject ("ambiguous subgroup path — use `<host>/group/sub/repo//path/to/skill`
     or a trailing `//` for a whole-repo scan"). With `//`, *all* segments after the host are the
     repo path (any depth — subgroups, R7).
   - else **GitHub sugar** (`github.com` implied, hardcoded — Q4): 1 segment → reject (R5:
     "one-part names are reserved for a future registry; use `owner/repo[/<name>]`"); 2 segments =
     repo, whole-repo mode; 3 segments = repo + `<name>`; ≥4 without `//` → reject as above.
5. **Selector normalization:** `//path` segments must be non-empty, must not contain `.`/`..`
   segments, and the final segment (the skill's directory name) must not start with `.`
   (dot-entries are invisible to placement detection). `<name>` selectors likewise.
6. **Clone URL:** sugar/host-explicit forms clone `https://<host>/<repo-path>.git`; URL/scp forms
   clone verbatim (minus `//path` and `@ref`). SSH users use explicit URLs (no config, Q4).

Skill *name* = the final segment of the resolved skill path; for a root-`SKILL.md` repo (R3), the
skill directory is the repo root and the name = the repo's final path segment.

### 5.3 Parse table (unit-test fixture — every row is a test)

| # | Source | Host | Repo path | Selector | Ref | Outcome |
|---|---|---|---|---|---|---|
| 1 | `smorinlabs/smorinlabs-harness` | github.com | `smorinlabs/smorinlabs-harness` | whole-repo (R3) | HEAD | ok |
| 2 | `smorinlabs/smorinlabs-harness/factor-scan` | github.com | same | name `factor-scan` (R1) | HEAD | ok |
| 3 | `smorinlabs/smorinlabs-harness/factor-scan@v1.2.0` | github.com | same | name `factor-scan` | `v1.2.0` | ok |
| 4 | `owner/repo@main` | github.com | `owner/repo` | whole-repo | `main` | ok |
| 5 | `owner/repo//plugins/fh/skills/factor-scan` | github.com | `owner/repo` | path `plugins/fh/skills/factor-scan` | HEAD | ok |
| 6 | `owner/repo//plugins/fh/skills/factor-scan@8c1d…40hex` | github.com | `owner/repo` | path … | full SHA | ok |
| 7 | `gitlab.com/acme/tools` | gitlab.com | `acme/tools` | whole-repo | HEAD | ok |
| 8 | `gitlab.com/acme/tools/review` | gitlab.com | `acme/tools` | name `review` | HEAD | ok |
| 9 | `git.corp.example:8443/team/kit/lint@release-2` | git.corp.example:8443 | `team/kit` | name `lint` | `release-2` | ok |
| 10 | `gitlab.com/acme/platform/tools//skills/review` | gitlab.com | `acme/platform/tools` (subgroup) | path `skills/review` | HEAD | ok (store ns `acme/platform-tools`, §7.2) |
| 11 | `gitlab.com/acme/platform/tools//` | gitlab.com | `acme/platform/tools` | whole-repo | HEAD | ok (trailing `//`) |
| 12 | `https://gitlab.com/acme/platform/tools.git//skills/review@main` | gitlab.com | `acme/platform/tools` | path `skills/review` | `main` | ok |
| 13 | `git@github.com:smorinlabs/skillsmith.git//plugins/x/skills/y@main` | github.com (scp) | `smorinlabs/skillsmith` | path `plugins/x/skills/y` | `main` | ok — `git@`'s `@` precedes the last `/`, not a ref |
| 14 | `ssh://git@git.corp/team/kit//skills/lint` | git.corp (ssh) | `team/kit` | path `skills/lint` | HEAD | ok |
| 15 | `factor-scan` | — | — | — | — | **reject (R5)**: one-part names reserved; suggest `owner/repo/factor-scan` |
| 16 | `repo@main` | — | — | — | — | **reject (R5)** after ref-strip leaves one part |
| 17 | `./skills/factor-scan`, `/Users/a/c/x`, `~/c/x` | — | — | — | — | **reject (R6)** with `dev --source`/`promote` guidance |
| 18 | `gitlab.com/acme/platform/tools/review` | — | — | — | — | **reject (D2)**: ≥4 segments after host without `//` — ambiguous subgroup |
| 19 | `owner/repo@v2//path` | — | — | — | — | **reject (R4)**: `@` before the end of the path portion — "place `@<ref>` after the skill path: `owner/repo//path@v2`" |
| 20 | `owner/repo/a/b/c` | — | — | — | — | **reject (D2)**: >3 sugar segments without `//` |

---

## 6. Fetch design (F1, Q5)

### 6.1 Location and lifetime

Fetches land in `<dataDir>/.fetch/<txId>/` (`txId` = the invocation's 8-hex generator, one dir per
source) — under the data dir, not `$TMPDIR`, so the sweep pattern reclaims orphans (Q5). The dir
is removed on success **and** failure of its source (F1); a crash orphan is reclaimed by §6.3.

### 6.2 Git sequence (all via `env.exec`, F9-clean: nothing fetched is ever executed)

```
git init -q <fetchDir>
git -C <fetchDir> remote add origin <cloneUrl>
git -C <fetchDir> fetch -q --filter=blob:none --depth 1 origin <ref>   # <ref> = branch|tag|full SHA|HEAD
sha=$(git -C <fetchDir> rev-parse FETCH_HEAD)                          # ref → full 40-hex SHA
git -C <fetchDir> ls-tree -r --name-only FETCH_HEAD                    # tree listing, NO blobs (D3 scan)
# after the selector picks exactly one skill path:
git -C <fetchDir> sparse-checkout set --cone <skillDir>                # ('' / no-op for a root skill)
git -C <fetchDir> checkout -q --detach FETCH_HEAD                      # blobs fetched only for <skillDir>
```

- `<ref>` handling: `HEAD` fetches the remote default branch; a 40-hex ref is fetched as a SHA
  (GitHub/GitLab permit reachable-SHA fetch); short SHAs are rejected at parse-adjacent validation
  ("use a full 40-hex SHA, a tag, or a branch") — they cannot be resolved remotely without
  fetching history.
- Any non-zero git exit in this sequence → `source-unresolvable` (exit 5) with the git stderr tail;
  by construction no store/placement/ledger write has happened for this source — never a
  half-install (F1). Offline behavior is deterministic: the first `fetch` fails the same way every
  time (NFR).
- Each git call runs with a timeout via `ExecOptions.timeoutMs` (fetch/checkout 120 s, plumbing
  10 s) and the invocation's `AbortSignal`.

### 6.3 Orphan sweep

At the start of every **locked** install/uninstall batch (alongside P12's `sweepStaging`): remove
every `<dataDir>/.fetch/<entry>` whose mtime is older than 60 minutes. The age guard is a
deliberate deviation from the sweep-all `.staging` pattern, with rationale: `.staging` dirs are
created only under the ledger lock, so a locked sweep can never race a live writer — but `.fetch`
dirs are also created by **unlocked `--dry-run`** fetches (§4.1), and a sweep-all would delete a
concurrent dry-run's working dir mid-scan. Sixty minutes bounds orphan lifetime while making the
race practically impossible.

### 6.4 Fetch elision (offline reinstall)

When the ref resolves to a SHA **without a clone** — the ref is a literal 40-hex SHA, or
`git ls-remote <cloneUrl> <ref>` returns it — and the store already holds
`<ns>/<name>@<sha12>/<skill>`, the clone is skipped entirely: verify and placement run against the
store entry (content-hash-guaranteed identical to what a fetch would produce). Elision is
permitted only when the skill path is already known without a tree scan — an explicit `//path`
source, or a ledger `origin` record matching (repo, skill, resolved SHA) — so the never-guess rule
(R2) cannot be bypassed by a stale store hit. Consequence: `uninstall` → `install <src>@<full-sha>`
round-trips **fully offline** (ls-remote is skipped for literal SHAs); branch/tag refs still need
one cheap `ls-remote` round trip.

### 6.5 Auth

Git's own machinery (ssh agent, credential helpers) authenticates private hosts — install adds no
token plumbing in v1 (`SKILLSMITH_TOKEN*` deferred, §1.1). A credential prompt from git under
`--no-prompt`/non-TTY fails the fetch (exit 5) rather than hanging: fetches run with
`GIT_TERMINAL_PROMPT=0`.

---

## 7. Store and ledger (reuse + additive schema)

### 7.1 Store reuse

`snapshotToStore` (`place/store.ts`) is reused verbatim: staging under `store/.staging/<txId>`,
double-hash verification, atomic rename, write-once with reuse-or-integrity-error. Install calls
it with the fetched skill dir as `sourceDir` and a **pre-built provenance** (from the parsed
source — `git remote` interrogation is neither needed nor trusted):
`{ kind: 'git-clean', gitSha: <resolved 40-hex>, ns, name, … }`. Install only ever mints
`<owner>/<repo>@<sha12>` revs (PRD F2 "clean-by-construction"). Installing N skills from one
`repo@sha` shares the namespace; re-installing a stored rev copies nothing (`reused: true`).

### 7.2 Namespace clamp (R7 / PR #5 follow-up #4 — mandated)

The store grammar is frozen at two segments: `<ns>/<name>@<rev>`. Multi-segment repo paths
(GitLab subgroups, host-explicit deep paths) are clamped by one shared rule:

```
ns   = sanitize(first repo-path segment)
name = sanitize(remaining segments joined with '-')     # 'acme/platform/tools' → 'acme/platform-tools'
sanitize: replace every char outside [A-Za-z0-9._-] with '-'; strip trailing '.git'
```

The same helper (`clampStoreNs` in `place/store.ts`) **replaces the tail of `parseRemote`**: today
`parseRemote` returns `repo: 'sub/repo'` for a subgroup origin URL, which would mint a
3-segment store path from `promote` — the exact PR #5 follow-up #4 hazard. After the clamp, both
promote-provenance and install-resolution produce identical 2-segment namespaces for the same
repo. Collisions between a clamped subgroup (`acme/platform-tools`) and a real repo of that name
are addressed, not ignored: they can only meet at an identical `@<sha12>`, where the store's
existing content-hash integrity check either reuses (identical content) or fails loudly (P12
§6.3). Full provenance (host, unclamped repo path) lives in `origin`, so the clamp never loses
information — the store path is an address, the ledger is the record.

### 7.3 Ledger schema (additive, schemaVersion 1)

New/changed fields only — everything else is P12 §7.2 verbatim:

```jsonc
{
  "schemaVersion": 1,
  "kind": "skillsmith.placements",
  "updatedAt": "…",
  "skills": { /* USER-SCOPE pairs, exactly as P12; PairRecords may now carry the additions below */ },
  "projects": {                                    // ADDITIVE (D8): project-scope pairs
    "/Users/alice/c/team-repo": {                  // key = project root, REALPATH basis (D8)
      "skills": { "review": { "tools": { "claude-code": { /* PairRecord, same shape */ } } } }
    }
  }
}
```

```jsonc
// PairRecord additions (all optional — old records parse unchanged):
{
  "placementPath": "/Users/alice/.claude/skills/factor-scan",
  "mode": "pinned",
  "dev": null,                                     // populated by adoption / later `dev --source`
  "pinned": {
    "storePath": "…/store/smorinlabs/smorinlabs-harness@8c1d2e3f4a5b/factor-scan",
    "rev": "8c1d2e3f4a5b",
    "gitSha": "8c1d…40hex",
    "dirty": false,
    "contentHash": "sha256:…64hex",
    "snapshotAt": "…",
    "verify": "passed",                            // 'passed' | 'warned' | 'skipped' — F6's --no-verify audit trail
    "placement": "symlink"                         // ADDITIVE (D7): 'symlink' | 'copy'; absent = 'copy' (all P12 records)
  },
  "origin": {                                      // ADDITIVE (F2): acquisition provenance, written only by install
    "source": "smorinlabs/smorinlabs-harness/factor-scan",  // the literal user argument
    "host": "github.com",
    "repo": "smorinlabs/smorinlabs-harness",       // UNCLAMPED repo path (subgroups keep their '/')
    "skillPath": "plugins/factor-harness/skills/factor-scan", // in-repo path; '' for a root skill
    "refRequested": null,                          // '@ref' / --ref as given; null = HEAD default
    "refResolved": "8c1d…40hex",                   // always the full SHA
    "pin": false,                                  // --pin policy marker (R4)
    "installedAt": "2026-07-07T20:14:03Z"
  },
  "journal": null                                  // op may be 'install' | 'uninstall' ONLY while in flight (D6)
}
```

- **Journal widenings (D6):** `Journal.op` ∈ `'promote' | 'dev' | 'rollback' | 'install' |
  'uninstall'`; `Journal.before` gains `{ mode: 'absent' }` and every variant gains optional
  `liveKind: 'symlink' | 'dir'` (records the physical kind of the pre-op live entry, which
  `rollbackSwap` needs now that `mode: 'pinned'` can be a symlink — §8.3).
- **Path bases (carry-forward):** `projects` keys and `origin` carry no filesystem paths except
  the realpath project key; `placementPath` stays the literal `join(root, skill)` (P12);
  `origin.skillPath` is a repo-relative git tree path (never a filesystem path).
- **FLIP_TOOLS constraint (PR #5 follow-up #8):** the ledger's tool-key schema is
  `z.record(z.enum(FLIP_TOOLS), …)` — unknown tool keys are rejected by every shipped reader. F4
  keeps v1 at `{claude-code, codex}`, so P09 adds **no** tool keys; any future tool (kilo-code,
  opencode) widens this enum and breaks old readers *persistently* (unlike D6's crash-window
  widenings) — that addition must revisit the schemaVersion question. Recorded here so nobody adds
  a tool key casually.

---

## 8. Install placement transaction (swap reuse + crash story)

### 8.1 Swap engine changes (in `place/swap.ts`, behavior-preserving for P12 ops)

- `SwapPlan` gains op `'install'` with a build payload
  `install: { build: 'symlink' | 'copy'; storePath: string; contentHash: string; pinned: PinnedRecord; origin: OriginRecord; adoptedDev: DevRecord | null }`.
  `buildStaging` selects the build shape: `'symlink'` → `makeSymlink(storePath, stagingPath)`;
  `'copy'` → `copyTree(storePath → staging)` + fsync + hash check (identical to the promote build).
- `before` for a fresh install = `{ mode: 'absent' }`; the P3 backup rename is skipped when the
  live path is absent (the engine's existing probe already does this) and the P4 publish rename is
  the single visible mutation.
- **Commit (P5) for `'install'`:** one ledger write sets the pair's terminal state (mode
  `pinned`, `pinned`, `origin`, `dev` = adopted record or retained) **and `journal: null`** —
  unlike flips, no committed journal is left at rest (D6). Backup reclamation (replace case) runs
  *before* that write, authorized by a persisted `phase: 'committed'` journal exactly as P12 P5
  orders it; a crash between the committed-journal write and the terminal write leaves a committed
  `'install'` journal that the hygiene sweep (§8.5) finishes.
- `rollbackSwap` reads `before.liveKind` (when present) instead of inferring the physical kind
  from `before.mode`, and learns the `{ mode: 'absent' }` case: rollback of an uncommitted fresh
  install = remove staging, remove the live entry if it is the new artifact, clear the journal —
  restoring "nothing there".

### 8.2 Reserved names

Same dot-names as P12 (§8.2): `.skillsmith-staging-<skill>-<txId>`,
`.skillsmith-backup-<skill>-<txId>`, invisible to placement detection and tool discovery.

### 8.3 Phases

Fresh install (live path absent). `before = { mode: "absent" }`:

```
P1 prepared    journal (op:'install', txId, before: {mode:'absent'}, stagingPath, backupPath)
               persisted; the pair record is created carrying the staged terminal records
               (pinned/origin) behind the uncommitted journal, with mode: 'pinned' — PairRecord.mode
               cannot represent absence; the journal's `before` is what records the pre-state
P2 staged      staging built per D7: symlink → store entry, or copied tree (fsynced, hash-verified)
P3 backed-up   persisted; the P3 rename is a no-op (live path absent — probe skips it)
P4 live        rename(staging → live path)                       ← the ONLY visible mutation
P5 committed   fsyncDir; ONE ledger write: pair terminal state + journal: null; done
```

Replace (`--force` / new rev over an existing placement). `before = { mode: 'pinned'|'dev',
liveKind, … }` — the full P12 two-rename protocol, with reclamation rules:

```
P3 backed-up   rename(live → backup)   (a dev symlink's target was FIRST adopted into the pair's
                                        dev record at P1 — losslessness for hand-made links, D12/§8.4)
P5 committed   backup reclaimed iff reproducible: symlink backups always (targets recorded);
               dir backups only when contentHash(backup) matches a store entry recorded on the pair
               (old pinned or new); otherwise the backup is KEPT + warning (P12 D14 pattern).
               Then the terminal ledger write (journal: null).
```

### 8.4 Crash windows

P12 §8.4's table applies mechanically (same engine, same probes). Install-specific rows:

| Crash window | Journal | Live path | `--rollback` | same-op re-run (re-`install`) |
|---|---|---|---|---|
| fresh, C1–C2 (before P4) | `prepared`/`staged`/`backed-up`, before `absent` | absent | remove staging, clear journal → still absent | rebuild staging, publish, commit |
| fresh, C4 (around P4) | `live` | absent **or** new (probe) | remove new live entry if present, remove staging, clear journal → absent | complete publish + commit |
| fresh, C5 (before terminal write) | `live`/`committed` | new | as C4 if uncommitted; committed → §8.5 sweep finishes | converges: `repaired`/`noop` (D14) — **never** reported as a fresh success (resumeSwap committed-journal carry-forward: `ok(committed: true)` on a committed journal means "residue reclaimed", not "my attempt succeeded") |
| replace, C3–C4 | per P12 §8.4 C3/C4 | old / absent / new | P12 recovery verbatim (backup exists whenever live is absent) | P12 continuation verbatim |

Recovery routes: an uncommitted `'install'` journal blocks promote/dev/uninstall on the pair
(exit 2), and `plan.ts`'s open-journal surfacing (P12 F1 behavior) keeps the pair reachable even
when the live path is absent. There is deliberately **no `install --rollback` flag**: recovery is
(a) re-running the same install, which converges (D14), or (b) the existing flip-verb recovery,
`promote --rollback <skill>` / `dev --rollback <skill>`, which handle acquisition journals too —
`rollbackSwap` is op-agnostic once it reads `before.liveKind`/`{ mode: 'absent' }` (§8.1). One
recovery story, two entry points; the refusal message on a blocked pair names both exact commands.

### 8.5 Journal hygiene sweep

At the start of every locked batch (install, uninstall, promote, dev, rollback — v0.6.0 code), for
every pair whose journal is `phase: 'committed'` with op `'install'` or `'uninstall'`: finish the
terminal transition (install → null the journal; uninstall → delete the pair) and reclaim any
backup/staging residue. Bounded lifetime for D6's enum widening; idempotent; runs under the lock.

---

## 9. Uninstall pipeline

### 9.1 Semantics per (skill, tool, scope)

1. Resolve targets (§4.3): names against skills roots (user + current project + codex legacy) and
   ledger keys; paths per P12 D2 (scope/tool inferred from the containing root).
2. Refusals before any journal write: U2 ambiguity (exit 2); U3 dev-mode placement without
   `--force` (exit 2, guidance: "`skillsmith promote <skill>` to pin it first, or
   `skillsmith dev --rollback <skill>` to restore the pinned copy, or `--force` to remove the
   symlink — the checkout itself is never touched"); unmanaged placement without `--force`
   (exit 2, D12); pair with an uncommitted journal (exit 2, unchanged P12 rule).
3. Journaled removal:

```
P1 prepared    journal (op:'uninstall', before: {mode, liveKind, storePath/symlinkTarget…}) persisted
P3 backed-up   persisted, then rename(live → backup)             ← live path now ABSENT
P5 committed   persisted (backup still on disk) → reclaim backup:
                 symlink backup → unlink (target recorded in the report and, if managed, the ledger);
                 dir backup → removed iff contentHash matches the pair's pinned.contentHash,
                 else KEPT + warning (unmanaged/edited copies are never silently destroyed)
               → terminal ledger write: PairRecord DELETED (journal disappears with it)
```

4. Store entries are **never** deleted (U1; PRD §7 — no GC in v1). The report prints the surviving
   store path so "where did my bytes go" has an answer.
5. Absent everywhere → `noop`, exit 0, notice (D12; ratified at design gate 2026-07-07). Placement
   absent but a stale pair exists → remove the record, action `removed` with reason "placement was
   already gone".

### 9.2 Crash windows

| Window | Journal | Live | Recovery (`--rollback` via flip verbs) | re-run `uninstall` |
|---|---|---|---|---|
| after P1, before P3 rename | `prepared`/`backed-up` | present | clear journal (nothing moved) | proceed from P3 |
| after P3 rename | `backed-up`/`committed(pre-reclaim)` | absent (backup exists) | rename(backup → live), clear journal — placement restored | reclaim + delete pair |
| after reclaim, before terminal write | `committed` | absent | nothing to restore (backup verified reproducible before reclaim) | hygiene sweep / re-run deletes the pair |

Invariants unchanged from P12 §8.4: live is never partial; whenever live is absent before commit,
the backup exists; nothing unreproducible is deleted before the committed journal is durable.

---

## 10. Verify gate (install)

Per D10 — mode `static` for **both** tools BY DEFAULT, run once per (source, tool) against the
fetched skill directory (bare-skill input; P11's `resolveTarget` wraps it in an ephemeral plugin,
verify §4.1), *before* snapshot and placement. An opt-in `--deep` flag (amended at the design gate
2026-07-07, resolving O3 — §18) requests the promote-parity gate for codex; claude-code is
unaffected either way:

| Tool | Invocation | Coverage note |
|---|---|---|
| claude-code | `verifyPlugin(env, { path: <fetchedSkillDir>, tools: ['claude-code'], deep: false })` — always, `--deep` has no effect here. | static covers manifest + skills — the whole gate (P11). |
| codex | default: same with `tools: ['codex']`, `deep: false`. Under `--deep`: `deep: true` — static + deep, at this same pipeline point (before snapshot/placement). | Default: static is manifest-only; the skill-substance gap is **accepted under F9's default floor** (D10) — deep would launch the codex binary on just-fetched untrusted content. Remediation: `--deep` itself, or a post-install `skillsmith verify <skill> --deep`; `promote` still gates deep unconditionally. Under `--deep`: the gap is closed for this install — the operator has given informed consent to run the codex binary against the fetched, unplaced skill. |

Blocking is **identical under `--deep` and the default**: `fail` → that source's placements for
that tool are `failed`, exit contribution 1; `warn` → proceed (`pinned.verify: "warned"`) unless
`--strict`; `inconclusive` → proceed with a warning unless `--strict`; `--no-verify` → gate
skipped, `pinned.verify: "skipped"` (auditable, F6). `--deep` combined with `--no-verify` is a
flag contradiction, refused before any I/O: exit 2 (§13/§14). A gate that blocks touches nothing —
it runs before any journal or store write for that source. Under fetch elision (§6.4) the gate
runs against the store entry, in whichever mode was requested (static, or static+deep under
`--deep`); the result transfers by content-hash identity (D10).

**F9 checklist (every pipeline step):** parse — no I/O; fetch — git plumbing only, no checkout
scripts, no hooks (`git init`+`fetch`+`sparse-checkout`+`checkout` execute nothing from the fetched
tree; `core.hooksPath` is irrelevant because the fetch dir's config is skillsmith-created and no
repo-supplied config is ever honored — `git -C` on a dir we `init`ed); verify — static parsers
only **by default** (D10); snapshot/place — `copyTree`/`makeSymlink`/`rename`; record — JSON
write. No step executes fetched content **by default**. `--deep` is the one deliberate, opt-in
exception — it launches the codex binary against the fetched skill, and it is documented as
informed consent (D10), not silently absorbed into this checklist. Exec bits are *preserved* by
the content-hash manifest but nothing runs unless `--deep` was explicitly requested.

---

## 11. Batch, idempotence, shadowing

### 11.1 Batch (F8, D13)

Sources are processed in argument order under one ledger lock. Per source: fetch/verify/snapshot,
then its (tool, scope) placements as independent journaled swaps (a placement failure for one tool
does not skip the other tool — P12 D12). A **source-level** failure (parse handled earlier; fetch,
verify-block, snapshot) marks that source's results `failed`/`refused` and — without
`--continue-on-error` — all later sources `skipped` (`reason: "fail-fast"`). Completed placements
are never rolled back by a later failure. Exit code = batch max (§13).

### 11.2 Shadowing (F5)

Before placing at scope A, the same (skill, tool) is probed at the other scope (on-disk classify +
ledger). A hit → the placement is `refused` (exit 2) with both paths and the tool's precedence
note ("project-scope skills shadow user-scope skills of the same name for this repo"), unless
`--force`, which proceeds and downgrades the refusal to a warning. Codex-specific: a hit in the
**legacy** root triggers D15's refusal (uninstall-first guidance) — `--force` does *not* override
the legacy conflict (it would mint P12's dual-root refusal state).

### 11.3 Idempotence (F7, D14)

Same source → ref resolves to the recorded `origin.refResolved` → placement on disk intact
(class matches `pinned.placement`, symlink targets the recorded store path / copy present) →
`noop`, exit 0, "already installed at `<rev>`". Source moved (new SHA) → `updated` via replace
swap. `--force` → re-execute even at the same rev (`updated`). Placement intact but record
missing → `repaired` (record re-written, no fs change). Store reuse is orthogonal
(`store.reused`).

---

## 12. JSON contracts (F10, U4)

House style: versioned, discriminated `kind`, zod-validated by the CLI before writing (pattern of
`flip-json.ts`), additive evolution only. Two kinds — the verbs' vocabularies differ too much to
share `skillsmith.flip`.

### 12.1 `skillsmith install --json`

```jsonc
{
  "schemaVersion": 1,
  "kind": "skillsmith.install",
  "dryRun": false,
  "requested": {
    "sources": ["smorinlabs/smorinlabs-harness/factor-scan"],
    "tools": ["claude-code", "codex"], "explicitTools": false,
    "scope": "user", "explicitScope": false,
    "ref": null, "pin": false, "direct": false, "force": false,
    "verify": "static",                      // 'static' | 'skipped' (--no-verify)
    "deep": false                            // ADDITIVE (D10, design gate amendment): --deep requested
  },
  "results": [
    {
      "source": "smorinlabs/smorinlabs-harness/factor-scan",
      "skill": "factor-scan",
      "tool": "claude-code",                 // null for source-level failures (parse/fetch/ambiguity)
      "scope": "user",
      "placementPath": "/Users/alice/.claude/skills/factor-scan",
      "action": "installed",                 // 'installed' | 'updated' | 'repaired' | 'noop' | 'skipped' | 'refused' | 'failed'
      "reason": null,                        // human cause for skipped/refused/failed; notices otherwise
      "placement": "symlink",                // 'symlink' | 'copy'
      "store": { "path": "…/store/smorinlabs/smorinlabs-harness@8c1d2e3f4a5b/factor-scan",
                 "rev": "8c1d2e3f4a5b", "gitSha": "8c1d…40hex", "reused": false },
      "origin": { "host": "github.com", "repo": "smorinlabs/smorinlabs-harness",
                  "skillPath": "plugins/factor-harness/skills/factor-scan",
                  "refRequested": null, "refResolved": "8c1d…40hex", "pin": false },
      "verify": { "gate": "passed", "verdict": "pass",
                  "mode": "static" },         // ADDITIVE (D10): 'static' | 'static+deep' — the mode
                                              // actually run for THIS tool (codex only under --deep;
                                              // claude-code is always 'static'); null when gate skipped
      "candidates": null                     // string[] of //paths on R2/R3 ambiguity refusals
    }
  ],
  "summary": { "installed": 1, "updated": 0, "repaired": 0, "noop": 0,
               "skipped": 0, "refused": 0, "failed": 0 }
}
```

### 12.2 `skillsmith uninstall --json`

```jsonc
{
  "schemaVersion": 1,
  "kind": "skillsmith.uninstall",
  "dryRun": false,
  "requested": { "targets": ["factor-scan"], "tools": ["claude-code", "codex"],
                 "explicitTools": false, "scope": null, "allScopes": false, "force": false },
  "results": [
    {
      "skill": "factor-scan",
      "tool": "claude-code",
      "scope": "user",
      "placementPath": "/Users/alice/.claude/skills/factor-scan",
      "action": "removed",                   // 'removed' | 'noop' | 'refused' | 'failed'
      "reason": null,
      "before": { "mode": "pinned", "placement": "symlink",
                  "storePath": "…@8c1d2e3f4a5b/factor-scan", "symlinkTarget": null },
      "storeRetained": "…/store/smorinlabs/smorinlabs-harness@8c1d2e3f4a5b/factor-scan",
      "backupKept": null                     // path when an unreproducible copy was preserved
    }
  ],
  "summary": { "removed": 1, "noop": 0, "refused": 0, "failed": 0 }
}
```

Human output mirrors P12's per-pair action lines + summary (`output/install-human.ts`); mockups
live in the rewritten `research/commands/install.md` / `uninstall.md` and are normative for the
renderer.

---

## 13. Exit codes

Reuses the documented set (`skillsmith-cli-design.md` §6.1); no new numeric codes. Batch exit =
highest per-result code (D13, both fail-fast and `--continue-on-error`).

| Code | `install` | `uninstall` |
|---|---|---|
| 0 | all `installed`/`updated`/`repaired`/`noop` (+ warnings) | all `removed`/`noop` (idempotent absence included) |
| 1 | verify-gate `fail`; snapshot integrity error; mid-swap I/O failure (state recoverable §8.4); lock unobtainable | mid-removal I/O failure (state recoverable §9.2); lock unobtainable |
| 2 | grammar rejections (R4/R5/R6, D2 ambiguous segments); R2/R3 ambiguity in non-TTY/`--json`/`--no-prompt`; shadowing without `--force` (F5); codex legacy-root conflict (D15); existing different-origin placement without `--force`; `--ref` with multiple sources or conflicting `@ref`; contradictory scope flags; `--deep` with `--no-verify` (flag contradiction, D10); unresolved journal on the pair | U2 cross-scope ambiguity; U3 dev-mode refusal; unmanaged placement without `--force`; unresolved journal |
| 3 | placements ledger unreadable/unparseable (never regenerated — P12 §7.1) | same |
| 4 | explicitly `--tool`-named tool not detected (install hint printed); no tool detected at all | — (uninstall needs no detection) |
| 5 | source unresolvable: network/clone failure, repo or ref not found, name matching **zero** skills in the repo (R1), short-SHA ref | — |
| 6 | skills root, store, `.fetch`, or ledger path not writable | skills root or ledger not writable |
| 130 | SIGINT — current journal write finishes, batch aborts, state recoverable | same |

Error-code → exit mapping extends `cli/util/exit-codes.ts`: new core error code
`tool-unavailable` → 4; existing `source-unresolvable` → 5, `flip-refused` → 2, `flip-failed` → 1,
`ledger-error` → 3, `permission-denied` → 6 are reused as-is (the acquisition engine returns the
same `Result<T, SkillSmithError>` family).

---

## 14. Error handling

| Condition | Handling |
|---|---|
| One-part source (`factor-scan`) | exit 2, R5 message: reserved for a future registry; suggest `owner/repo/factor-scan`. |
| Local path source | exit 2, R6 message with `dev --source` / `promote` guidance. |
| `@ref` before the path portion | exit 2 with the corrected form (parse table #19). |
| ≥4 path segments without `//` | exit 2, subgroup guidance (parse table #18/#20). |
| Network down / repo 404 / ref not found | exit 5 (`source-unresolvable`), git stderr tail included; nothing written (F1). Deterministic offline. |
| Name matches zero skills | exit 5, listing "searched `<n>` SKILL.md directories at `<sha12>`". |
| Name matches >1 / bare repo has >1 skill | TTY: picker (D4). Non-TTY/`--json`/`--no-prompt`: exit 2 listing every match as an exact `owner/repo//path` re-run line (R2). |
| Bare repo has exactly one skill | install it (R3). |
| Skill dir name starts with `.` | exit 2 ("dot-prefixed skills are invisible to placement detection"). |
| Verify gate `fail` / `warn`+`--strict` | `failed`, exit 1, findings rendered via verify's output; nothing placed for that source (D10). |
| `--deep` combined with `--no-verify` | exit 2, usage refusal before any I/O — the two flags contradict (opt in to a deeper gate vs. skip the gate entirely); message names both flags (D10). |
| Store entry exists with different content at `@<sha12>` | integrity error, exit 1 (P12 §6.3 verbatim). |
| Same skill present at the other scope | `refused` exit 2 + shadowing explanation; `--force` proceeds with warning (F5). |
| Codex skill present in legacy `~/.codex/skills` | `refused` exit 2, uninstall-first guidance; `--force` does not override (D15). |
| Placement exists, different origin, no `--force` | `refused` exit 2, printing the recorded origin. |
| Placement exists, same rev | `noop` exit 0 (F7). |
| Explicit `--tool` not detected | exit 4 + canonical install hint. |
| Uncommitted journal on the pair (any op) | every operation except the journal-op's re-run and `--rollback` refuses, exit 2, message names both commands (P12 rule extended to acquisition ops). |
| Committed `install`/`uninstall` journal found (crash residue) | hygiene sweep completes it silently at next locked batch (§8.5); the sweeping command's own results are unaffected. |
| Uninstall: dev-mode placement | `refused` exit 2 (U3) with promote / `dev --rollback` / `--force` guidance; `--force` removes the symlink only (checkout untouched, target printed). |
| Uninstall: unmanaged placement | `refused` exit 2 unless `--force`; with `--force`, dir backups not hash-matched to a store entry are **kept** + warning (D12). |
| Uninstall: absent everywhere | `noop` exit 0 with notice (D12). |
| Ledger unparseable | exit 3; never regenerated. |
| Lock held by a live process | wait/retry per P12 §7.1, then exit 1 ("another skillsmith operation is running"). Post-SIGKILL orphan frees in ≤30 s (D17). |
| SIGINT | finish current journal write, mark remaining results `skipped`/`interrupted`, exit 130. |

---

## 15. Architecture and where code lives

Follows the core/CLI split (ADR 0001), per-agent boundaries (CLAUDE.md), and import zones
(ADR 0003). `acquire/` is a new top-level orchestrator zone **above** `place/`:

```
packages/core/src/
  acquire/
    types.ts        SourceSpec, ResolvedSource, OriginRecord, InstallOptions/Report/Result,
                    UninstallOptions/Report/Result, InstallDeps (verify, now, newTxId, pick?)
    source.ts       parseSource (§5 grammar — pure), clamp/sanitize helpers (shared w/ store.ts)
    fetch.ts        fetchRepo (§6.2 git sequence via env.exec), lsTreeSkills (SKILL.md scan),
                    resolveRefSha (ls-remote / literal), sweepFetchDir (§6.3)
    resolve.ts      candidate matching (R1–R3), ambiguity outcomes, fetch-elision check (§6.4)
    run.ts          runInstall(env, opts, deps) / runUninstall(env, opts, deps)
                    -> Result<InstallReport|UninstallReport, SkillSmithError>
                    batch loop, single lock, hygiene sweep, verify gate, snapshot, swaps, records
  place/            (amended, P12 tests stay green)
    types.ts        Journal op/before widenings (D6), SwapPlan 'install' payload, PinnedRecord.placement,
                    PairRecord.origin, LedgerFile.projects
    ledger.ts       zod schema additions (all optional/additive); project-subtree accessors
    store.ts        clampStoreNs helper; parseRemote tail clamped through it (§7.2)
    swap.ts         'install'/'uninstall' ops, build-shape dispatch, before.liveKind in rollback,
                    terminal-write journal nulling (§8.1)
packages/cli/src/
  commands/install.ts     flags (§4.1), @clack picker wiring (D4), exit codes, rendering; alias 'i'
  commands/uninstall.ts   flags (§4.3), exit codes, rendering; aliases 'rm', 'remove'
  output/install-human.ts / install-json.ts    per-result lines + zod-validated JSON (§12), both verbs
```

**ADR 0003 amendment (to be recorded in the implementing PR, as P12 §13 did):** add zones —
`packages/core/src/{skills,plugins,commands,verify,place}` ↛ `acquire` (acquire is the topmost
orchestrator; it may import `env/`, `detect/`, `agents/`, `verify/`, `place/`); CLI leaf rules
unchanged. Per-agent code stays per-agent: install hints come from the existing
`agents/<tool>/install-hint.ts`, roots from `agents/<tool>/skill-roots.ts`, placement classes from
`agents/<tool>/placement.ts` — no new per-agent files are required, and nothing merges across
agent directories.

New runtime dependencies: **none** (PRD §7). `@clack/prompts` is already on the approved stack and
already CLI-permitted; git runs via `env.exec`. Core purity holds: `runInstall`/`runUninstall`
return `Result<…, SkillSmithError>`; the CLI owns prompts, exit codes, and output.

---

## 16. Testing strategy

- **Grammar table (unit):** every row of §5.3 (20 cases) plus fuzz-ish edges (`@` in userinfo,
  trailing slashes, `.git` stripping, `:port` hosts) through `parseSource` — pure, no env.
- **Clamp unit tests:** `clampStoreNs` matrix (2-seg, subgroup, dotted/sanitized segments) and the
  `parseRemote` regression: a subgroup origin URL must now produce a 2-segment ns (the PR #5 #4
  case), asserted against both promote-provenance and install-resolution paths.
- **Fetch fixture (hermetic, no network):** a local **bare** git repo (fixture setup:
  `git init --bare` + push of a tree containing root/one/many-skill layouts, tags, branches) with
  `uploadpack.allowFilter=true`, addressed via `file://` — exercises the exact §6.2 sequence:
  blobless fetch, `ls-tree` scan, sparse checkout, SHA resolution, ref-not-found, and
  fetch-elision (store pre-seeded, ls-remote path). Offline determinism: an unreachable URL
  asserts exit 5 with no store/ledger mutation.
- **Resolver unit:** R1 depth matching, R2 multi-match candidates, R3 single/multi, scripted
  `pick` callback (choose / decline), zero-match exit 5.
- **Install e2e (fixture fleet):** extend P12's fake-`$HOME` fixture: fresh install (symlink +
  ledger assertions incl. `origin`), `--direct`, idempotent re-run (`noop`), `--force` same-rev
  (`updated`), new-rev update, `repaired` (record deleted between runs), project scope
  (`projects` subtree keyed by realpath), shadowing refusal + `--force`, codex legacy-root
  refusal, explicit-tool-undetected exit 4.
- **Store-linked interop e2e:** install → `dev --source <fixture checkout>` → edit → `promote`
  asserts the placement is a store **symlink** again (D9), new rev, `origin` retained → `dev`
  → `promote` round-trip lossless → `uninstall` removes pair, store entries still on disk.
- **Uninstall suite:** managed symlink/copy removal (+ `storeRetained`), U2 ambiguity listing, U3
  refusal + `--force`, unmanaged refusal + kept backup on hash mismatch, absent no-op exit 0,
  stale-record repair, legacy-root removal with notice.
- **Crash suite (deterministic injection):** the P12 `SimulatedCrash` harness swept over every
  mutating env call for: fresh install, replace install, uninstall — asserting after every crash
  point: live path is old-complete/new-complete/absent (never partial); backup exists whenever
  live is absent pre-commit; `--rollback` (via the flip verbs) restores the before-state
  byte-identically; a same-op re-run converges; a committed acquisition journal is finished by the
  hygiene sweep. Plus the ledger-compat probe: a ledger frozen mid-crash (op `'install'`) must
  FAIL the P12-era schema (documents D6's adjudication) and pass the v0.6.0 schema.
- **SIGKILL live e2e (env-gated, NFR):** extend P12's `SKILLSMITH_TEST_PAUSE_AT` subprocess
  harness (`SKILLSMITH_E2E=1`): SIGKILL a real `skillsmith install` at each phase barrier against
  a temp `$SKILLSMITH_HOME` + `file://` fixture remote; assert recovery by re-run and by
  `--rollback`; assert the ≤30 s lock-staleness bound is the only added latency (D17).
- **Live e2e (env-gated, PRD §10):** `SKILLSMITH_E2E=1` against `smorinlabs/smorinlabs-harness`:
  install a real skill (bare, name, and `//path` forms), then the scenario-4 round-trip
  `dev --source <local clone>` → `promote` → `dev --rollback` → `uninstall`; `--force --ref <tag>`
  up/downgrade (scenario 5); non-TTY ambiguity listing (R2).
- **Verify-gate tests (D10, amended for `--deep`):** canned verify reports (pass/warn/fail/
  inconclusive) × {default, `--strict`, `--no-verify`, `--deep`} → block/proceed matrix; asserts
  the codex gate requests `static` by default and `static+deep` under `--deep`; asserts the
  claude-code gate requests `static` unconditionally, unaffected by `--deep`; asserts `--deep` +
  `--no-verify` together is a usage refusal, exit 2, before any fetch/I/O.
- **Exit-code table test:** drive §13 across the enumerated conditions; batch-max asserted for
  fail-fast and `--continue-on-error`.
- **JSON contract tests:** zod round-trip + golden files for both kinds; picker-disabled-under-
  `--json` asserted.
- `bun run check` green (biome + eslint boundaries incl. the new `acquire/` zones + tsc +
  actionlint + bun test).

---

## 17. Out of scope

Everything in §1.1, plus, explicitly: parallel multi-source fetching (sequential in v1 — one lock,
simple ordering); store GC / reference counting (PRD §7 overrides P12 §1.1's forward-reference);
`install --rollback` as a flag (recovery is re-run + the flip verbs' `--rollback`, §8.4);
migration of codex legacy-root placements (uninstall+install is the migration, D15);
project-scope `promote`/`dev` (O1, deferred to a follow-up project at the design gate — §18);
dead-PID lock detection (D17, deferred);
`SKILLSMITH_TOOL`/`SKILLSMITH_SCOPE`/`SKILLSMITH_PATH` env-var flag defaults (April-draft feature,
not implemented anywhere today — revisit with config work); Windows.

---

## 18. Design gate resolutions (formerly "open questions")

No open questions remain in this spec. All three below were adjudicated by the project owner on
2026-07-07 (see the header block); the original framing is kept intact under each so the history
of what was asked and recommended stays readable — only the outcome is new.

- **O1 — project-scope flips. ADJUDICATED: deferred to a follow-up project; project-scope
  placements are install/uninstall-only in v0.6.0; the scenario-4 acceptance runs at user scope.**
  Install defaults to project scope inside a repo (F5), but `promote`/`dev` remain user-scope-only
  (P12 §16). A team-repo install therefore cannot run the scenario-4 hack loop *at project scope*
  until flips learn `--scope`. Recommendation: defer to a follow-up (P13-class); run the scenario-4
  acceptance at user scope (the PRD's fleet scenarios are user-scope). Consequence if deferred:
  documented asymmetry — project-scope placements are install/uninstall-only in v0.6.0. The
  recommendation was adopted as-is; the follow-up project has not yet been filed.
- **O2 — journal-op widening (D6) ratification. ADJUDICATED: D6 widening ratified as specced.**
  The alternative (a second journal file) keeps v0.5.0 readers happy even in crash windows at the
  cost of a split crash-truth. Recommendation: widen with terminal-null + hygiene sweep as specced.
  Consequence: a v0.5.0 binary run against a ledger frozen mid-install-crash exits 3 until any
  v0.6.0 command runs. The recommendation was adopted as-is.
- **O3 — codex install gate is manifest-only (D10). ADJUDICATED: opt-in `--deep` added (D10's
  design-gate amendment) — the design gate chose the alternative, not the original
  recommendation.** If the coverage
  gap is unacceptable, the alternative is an opt-in `--deep` install flag (explicit consent
  weakens the F9 argument). Original recommendation (NOT adopted): ship static-only + the printed
  remediation notice; revisit after P14 exposure. What shipped instead: the alternative — a
  `--deep` flag (D10, §4.1, §10) that opts codex into the promote-parity gate (static + deep) on
  the fetched skill, pre-placement; claude-code is unaffected; blocking policy matches the default
  gate; `--deep` + `--no-verify` is a usage refusal (exit 2). The default remains static-only for
  both tools — F9's floor still holds for anyone who does not pass `--deep`.
