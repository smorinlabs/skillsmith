# P09 PRD — `skillsmith install` / `uninstall` (the acquisition verbs)

**Status:** Approved (Steve, 2026-07-07) · **Owner:** Steve Morin · **Target:** v0.6.0
**Consumes:** P12 store/ledger/swap (`packages/core/src/place/*`), P11 verify
**Supersedes:** the claude-code-only scoping in PROJECTS.md P09 and parts of
`research/commands/install.md` / `uninstall.md` (April drafts — grammar revised here;
the BR spec must reconcile those command docs to this PRD).

---

## 1. Problem & goal

Skillsmith can verify skills (v0.4.0) and flip local placements between dev and
production (v0.5.0), but cannot **acquire a skill from a remote source** — that still
requires hand-cloning repos and hand-managing symlinks. P09 adds the acquisition verbs:

- `install` — fetch from a git host, pin into the existing content-addressed store,
  place for the chosen tools, record in the ledger.
- `uninstall` — remove placements + ledger records (store entries are immortal).

Success = the full lifecycle works end-to-end with one coherent store, ledger, and
provenance model: `install → verify → dev ⇄ promote → uninstall`.

## 2. Users & primary scenarios

1. **Fleet owner, new machine** — rebuild the personal fleet from
   `smorinlabs/smorinlabs-harness` without cloning anything by hand.
2. **Public adopter (post-P14)** — a stranger runs the README one-liner and gets a
   working skill with provenance.
3. **Team repo** — project-scoped, ref-pinned installs that resolve identically for
   every teammate and CI.
4. **Install-then-hack (P12 interop)** — install someone's skill; `dev --source
   <local clone>` to iterate; `promote` to re-pin at your SHA; `dev --rollback` to undo.
5. **Deliberate upgrade/downgrade** — `install --force --ref <tag>`; store entries are
   write-once so reverting is another `--force --ref` away. (No `update` verb in v1.)

## 3. Source grammar (core requirement)

```
skillsmith install <source>[@<ref>] [<source>...]

<source> :=
  owner/repo                       # GitHub sugar (github.com implied)
  owner/repo/<skill-name>          # GitHub sugar; skill resolved BY NAME (repo-wide scan)
  <host>/owner/repo[/<name>]       # host-explicit: gitlab.com/…, git.corp/… — no config
  <git-url>[//path/to/skill]       # any https/ssh/scp URL; `//` = explicit path in repo
  owner/repo//path/to/skill        # sugar + explicit path (go-getter/Terraform precedent)
```

- **R1 — name resolution default:** scan the fetched repo for directories containing
  `SKILL.md` whose directory name matches; works at any depth (real fleets keep skills
  at e.g. `plugins/<plugin>/skills/<skill>/`).
- **R2 — loud ambiguity:** name matches >1 → list every match with its `//path`,
  exit 2. Non-TTY never guesses.
- **R3 — bare `owner/repo`:** exactly one skill in repo (incl. root `SKILL.md`) →
  install it; several → TTY interactive picker, non-TTY list + exit 2.
- **R4 — refs:** `@ref` suffix (tag/branch/SHA) is sugar; `--ref` canonical (default
  HEAD); `--pin` freezes the resolved SHA in the ledger. `@` is only a ref separator
  after the path portion (never inside scp `user@host`).
- **R5 — dropped forms:** the April `repo/skill` default-org form is REMOVED
  (ambiguous). One-part bare names are reserved (future registry) and rejected with a
  clear message.
- **R6 — no local paths:** filesystem paths are rejected with guidance to
  `dev --source` / `promote` — install is remote-acquisition only.
- **R7 — multi-segment owners (GitLab subgroups):** handled only via host-explicit or
  `//` forms; the resolver must never mint store namespaces violating the 2-segment
  `<ns>/<name>@<rev>` grammar (closes PR #5 follow-up #4; includes clamping
  `parseRemote` in `place/store.ts`).

## 4. Where things land (placement model)

The **repo is never installed** — it exists transiently; only the skill subtree persists.

| Stage | Location | Lifetime |
|---|---|---|
| Fetch (repo) | `<dataDir>/.fetch/<txId>/` — blobless partial clone | seconds; removed on success AND failure; orphans reclaimed by the same sweep pattern as store `.staging` |
| Store (skill) | `<dataDir>/store/<owner>/<repo>@<sha12>/<skill>/` | forever (write-once, never deleted) |
| Placement | `~/.claude/skills/<skill>` → store symlink; codex roots likewise; `./.claude/skills/<skill>` for `--project`; `--direct` = plain copy, no symlink | until uninstall/dev |
| Ledger | `<dataDir>/placements.json` | permanent |

`<dataDir>` = `$SKILLSMITH_HOME` or `$XDG_DATA_HOME/skillsmith` (see
`packages/core/src/place/paths.ts` — reuse, do not reinvent). Installing N skills from
one `repo@sha` shares a store namespace; re-installing a stored rev copies nothing
(`reused: true`).

## 5. Functional requirements — install

- **F1 fetch:** blobless partial clone at the requested ref into `<dataDir>/.fetch/<txId>`;
  resolve ref → full SHA; cleanup guaranteed; orphaned fetch dirs swept like `.staging`.
  Network failure → `source-unresolvable` (exit 5 family), never a half-install.
- **F2 store/ledger reuse:** snapshot via P12's store exactly (clean-by-construction →
  `<owner>/<repo>@<sha12>`); record placement `mode: 'pinned'` with a new **additive**
  `origin` field (source form, host, ref requested, SHA resolved, installedAt) — ledger
  stays schemaVersion 1.
- **F3 placement:** store-symlink default / `--direct` copy; per-tool transactions via
  P12's swap + journal (same crash-safety: a killed install is resumable/rollbackable).
- **F4 tools:** multi-tool day one — `claude-code` + `codex` (supersedes April
  claude-only). Default all detected; `--tool` narrows.
- **F5 scopes:** `user` (default outside a git repo) and `project` (default inside;
  `./.claude/skills` etc.). `system` deferred. Cross-scope duplicate → shadowing warning,
  exit 2 unless `--force`.
- **F6 verify gate:** static verify runs on the fetched skill BEFORE placement (same
  policy as promote: fail blocks; warn blocks under `--strict`); `--no-verify` recorded
  in the ledger.
- **F7 idempotence:** same source → same rev → already placed = friendly no-op, exit 0.
  `--force` re-executes.
- **F8 batch:** multiple sources; fail-fast unless `--continue-on-error`; ONE ledger
  lock per invocation held across the batch.
- **F9 security floor:** install executes NOTHING from the fetched repo — no hooks, no
  scripts, pure file placement.
- **F10 output:** human summary per placement + versioned `--json` report (consistent
  with the verify/flip contracts); `--dry-run` prints the full plan.

## 6. Functional requirements — uninstall

- **U1** `uninstall <skill>...` (aliases `rm`, `remove`) removes placements + ledger
  records; store entries never deleted.
- **U2** Ambiguity across scopes/tools → list + exit 2; disambiguate with
  `--scope` / `--tool` / `--all-scopes`.
- **U3** A placement in **dev mode** is refused with guidance (`promote` or
  `dev --rollback` first) unless `--force` — protects live symlinks into working checkouts.
- **U4** `--dry-run`, `--yes`, `--json`; exit codes from the established table.

## 7. Non-functional

Crash-safe (journal semantics inherited from P12; env-gated SIGKILL live e2e required) ·
deterministic offline errors · macOS + Linux (Windows out of scope) · no new runtime
deps beyond `git` subprocess use (consistent with existing provenance code) · store
growth accepted (write-once; no GC in v1).

## 8. Out of scope (explicit)

`sync`/`apply` manifests · cross-tool adaptation · kilo-code/opencode targets ·
registries / one-part names · lifecycle hooks · an `update` verb · marketplace-aware
addressing (`plugin@marketplace`) · store GC/pruning · Windows.

## 9. Resolved design questions (defaults locked 2026-07-07)

| # | Question | Decision |
|---|---|---|
| Q1 | Bare `owner/repo`, many skills | TTY picker; non-TTY exit 2 (R3) |
| Q2 | Local paths as sources | Rejected — `dev`/`promote` own local (R6) |
| Q3 | Verify gate default | On, static, `--no-verify` escape (F6) |
| Q4 | Configurable default host | No — GitHub sugar hardcoded; host-explicit covers the rest |
| Q5 | Fetch temp location | Under `<dataDir>/.fetch/`, not `$TMPDIR`, so the P12 sweep pattern reclaims orphans |

## 10. Acceptance

- The five scenarios in §2 runnable verbatim; grammar table covered by unit tests incl.
  every ambiguity/rejection path.
- Env-gated live e2e: install a real skill from `smorinlabs/smorinlabs-harness`, then
  round-trip `dev --source` → `promote` → `uninstall`.
- `bun run check` green; per-repo SDD process (per-task reviews + fable final review);
  ships as **v0.6.0** via the proven release pipeline (feat squash → release-please).

## 11. Implementation kickoff pointers (for the P09 session)

- Reuse, never reinvent: `packages/core/src/place/{paths,store,ledger,swap,plan,run}.ts`
  (P12) and `packages/core/src/verify/*` + `agents/*/verify.ts` (P11).
- Reconcile `research/commands/install.md` + `uninstall.md` to this PRD (grammar changed;
  local-path and default-org forms removed; adaptation mockups out of scope).
- Binding review carry-forwards live in `.superpowers/sdd/progress.md` (P11/P12
  sections) — esp. resumeSwap committed-journal semantics, one-lock-per-invocation,
  path-basis rules, and the PR #5 follow-ups list (items 2, 4, 8 touch this work).
- Precedent docs: `docs/superpowers/specs/2026-07-07-promote-dev-design.md` and
  `docs/superpowers/plans/2026-07-07-promote-dev-implementation.md` are the house style
  to follow for the BR spec and PL plan.
