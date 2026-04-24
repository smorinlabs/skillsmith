# SkillSmith CLI design — critical inconsistencies

The three highest-impact findings extracted from [`skillsmith-cli-design-inconsistencies.md`](./skillsmith-cli-design-inconsistencies.md). These are flagged as critical because each of them requires a substantive design decision before implementation can proceed — not just a text fix:

- **CID-007** is an architectural ambiguity: the content-addressed store and the cross-tool adapter cannot both be correct as currently described.
- **CID-008** is a naming-rule contradiction whose resolution changes env var names used across the entire doc.
- **CID-003** is a flag-definition contradiction that affects help output, the global flag table, and short-flag allocation (§1.7).

The remaining 24 findings are documented in the sibling inconsistencies doc.

---

## CID-007 — Store keying vs cross-tool adaptation

- **Category:** store architecture
- **Severity:** definite
- **Location(s):** §1.11 L190 (store layout `…/store/<owner>/<repo>@<sha>/<skill>/` — no tool qualifier); §1.16 L259–L260 ("SkillSmith applies a per-target-tool adapter that transforms the skill on the way into the store"); §4.3 cross-tool mockup L690–L700 (shows store path and symlink path, store path is `…/acme/agent-tools@3f2a1b/claude-reviewer`)
- **Finding:** The store is content-addressed by `(owner, repo, sha, skill)` with no tool component. Cross-tool adaptation is described as transforming "on the way into the store." If the same `(owner, repo, sha, skill)` is installed once for `claude-code` (no adaptation) and once for `codex` (adapted), the second write would either collide with or overwrite the first.
- **Why it's an inconsistency:** The model "each tool/scope holds a symlink into the same store entry" (§0.5.2, §1.11) is incompatible with per-tool transformation at store-write time.
- **Recommended fix:** Pick a model and make both sections say the same thing. Two defensible models:
  1. **Adapt at symlink time.** Store always holds original (or a canonicalized form). Adapter output lives outside the store or in a per-tool overlay. Update §1.16 to say "on the way to the target" rather than "on the way into the store"; update §8 adapter-engine bullet similarly.
  2. **Adapt at store time, tool-aware store key.** Extend the store layout to `…/<owner>/<repo>@<sha>/<skill>/<tool>/` so per-tool adapted bytes coexist. Update §1.11 store layout and all downstream paths (§6.4, §8).
- **Alternatives with recommendation:** Model **(1)** is simpler (store stays source-of-truth, adapters are pure functions invoked at install/symlink time) and preserves the "no duplicate bytes" promise when the same source is installed for multiple same-tool scopes. Model (2) adds filesystem duplication whenever a skill is installed for >1 tool but makes `list` trivially tool-aware without traversal. Recommend model (1).

DECISION: 1. Adapt at symlink time

---

## CID-008 — Env var naming rule vs actual names

- **Category:** naming rule
- **Severity:** definite
- **Location(s):** §5 L894 (rule: "Match env var name by uppercasing and replacing dots/dashes with underscores (`SKILLSMITH_DEFAULT_TOOL`, `SKILLSMITH_REGISTRY_DEFAULT`)"); §6.3 L933–L936 (`SKILLSMITH_TOOL`, `SKILLSMITH_SCOPE`, `SKILLSMITH_PATH`, `SKILLSMITH_REGISTRY`); §3.1–§3.7 flag tables (all use the short names)
- **Finding:** The stated naming rule produces long-form env var names (`SKILLSMITH_DEFAULT_TOOL`, `SKILLSMITH_REGISTRY_DEFAULT`) that the rest of the doc never uses. The actually-used names drop the `DEFAULT_` / `_DEFAULT` segment.
- **Why it's an inconsistency:** §5 is an authoritative naming-rule section. Either the rule is wrong (config keys are `tool`/`scope`/`path`, not `default-tool`/`default-scope`), or the env var names are wrong, or the rule and the names refer to different keys.
- **Recommended fix:** Decide on canonical config-key names and make the rule match:
  1. If config keys are bare (`tool`, `scope`, `path`, `registry`), update §5 example to `SKILLSMITH_TOOL`, `SKILLSMITH_REGISTRY` and drop the `DEFAULT` examples.
  2. If config keys are `default-tool` / `registry.default` as stated, update §6.3 to `SKILLSMITH_DEFAULT_TOOL`, `SKILLSMITH_REGISTRY_DEFAULT` and every flag table's Env var column.
- **Alternatives with recommendation:** Option (1) is the less invasive fix and aligns with common CLI conventions (most tools expose `TOOL_X` rather than `TOOL_DEFAULT_X`). Recommend (1). Keep dotted config keys for hierarchy (`registry.default`) but map to `SKILLSMITH_REGISTRY` (drop trailing `_DEFAULT`) when the config section has a clear primary value.

DECISION: Yes use option 1

---

## CID-003 — Global `-C` long form

- **Category:** flag definition
- **Severity:** definite
- **Location(s):** §3.1 L403 (`-C` | Long=— | path | `.`); §4.1 L527 (`-C, --path <dir>`); §1.7 L167 (`-p = --path`); §3.2 L415 (install `-p, --path`)
- **Finding:** §3.1 defines the global flag as `-C` with **no** long form. §4.1's rendered help shows `-C, --path <dir>`. But `--path` is already bound to `-p` (install's install-path override). This produces three contradictions: (a) §3.1 says no long form; (b) §4.1 invents a long form; (c) that invented long form collides with another flag.
- **Why it's an inconsistency:** A reader comparing the flag table to the help output gets different answers, and the help output describes a flag that cannot exist (two shorts for one long).
- **Recommended fix:** Decide on a long form (e.g., `--cd <dir>` following git's convention, or `--chdir`) and set it consistently. Update §3.1 long column and §4.1 help line.
- **Alternatives:** (a) Keep `-C` short-only and update §4.1 to show `-C <dir>` with no long form; (b) use `--chdir`; (c) use `--working-dir`. Recommendation: `--cd` for brevity and git-parity.

DECISION: Use recommendation --cd <dir> for the long form
