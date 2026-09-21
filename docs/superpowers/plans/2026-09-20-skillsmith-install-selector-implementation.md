# Skillsmith repository skill selection implementation plan

**Status at implementation candidate:** INSTALL-01 through INSTALL-06 are complete on `feat/install-skill-selector`. Three subagents completed bounded implementation tasks and independent cross-review; all selector findings are repaired and rechecked. INSTALL-07 awaits the clean-candidate canonical gate and INSTALL-08 awaits separate PR delivery. The PR will record final commit-specific gate evidence and delivery status.

**Purpose:** Let a user select one skill from a repository by its directory name or declared frontmatter name. Preserve the exact selected source through installation and subsequent `plan`, `apply`, and `update` operations.

**Scope:** Skillsmith is an open-source CLI for managing packages whose primary artifact is `SKILL.md`. Validation uses local Git repositories, isolated installation directories, and synthetic fixtures. It does not use the user's installed skills, real credentials, or third-party networks.

**References:** [Parent search plan](2026-09-20-skillsmith-search-implementation.md); [search PR #100](https://github.com/smorinlabs/skillsmith/pull/100). Source baseline: `8189acb5622bdb5fbde7db2abc09c46228ec8ede`. Working branch: `feat/install-skill-selector`, based on the search PR. Task IDs `INSTALL-01`–`INSTALL-08` are local to this plan, not project IDs.

## Execution overview

Implement the selector as a separate second PR. Begin with INSTALL-01, which establishes failing regression cases and passing compatibility controls. The detailed tasks in section 5 identify the files, work, and acceptance checks for each deliverable.

| Task ID | Deliverable | Depends on | Status |
| --- | --- | --- | --- |
| [INSTALL-01](#install-01--establish-failing-behavior-and-compatibility-fixtures) | Regression fixtures for name conflicts, cached installs, root skills, and existing installation forms. | Reviewed plan | Complete; baseline failures recorded |
| [INSTALL-02](#install-02--make-frontmatter-reads-data-only-and-bounded) | Data-only frontmatter parsing and bounded Git reads with correct cancellation. | INSTALL-01 | Complete; parser, bound, and cancellation controls pass |
| [INSTALL-03](#install-03--implement-deterministic-selection-at-one-commit) | Directory-first matching, declared-name fallback/override, and ambiguity refusal at one commit. | INSTALL-02 | Complete; focused regressions pass |
| [INSTALL-04](#install-04--wire-production-cli-and-application-preflight) | Production CLI options and shared validation before installation context creation. | INSTALL-03 | Complete; preflight and contract checks pass |
| [INSTALL-05](#install-05--preserve-exact-saved-paths-across-lifecycle-commands) | Exact root and nested source identities across `plan`, `apply`, and `update`. | INSTALL-03, INSTALL-04 | Complete; real Git lifecycle checks pass |
| [INSTALL-06](#install-06--document-the-new-contract-and-close-live-inventories) | README, help, completion, command references, and contract inventory updates. | INSTALL-04, INSTALL-05 | Complete; generated references and inventories agree |
| [INSTALL-07](#install-07--review-and-validate-implementation) | Adversarial implementation review, focused/smoke checks, a clean candidate commit, and the terminal gate. | INSTALL-02 through INSTALL-06 | In progress |
| [INSTALL-08](#install-08--deliver-the-selector-pr-separately) | Separate selector PR with resolved findings and evidence for its exact head. | INSTALL-07 | Pending |

Mark a task complete only when its acceptance checks pass. Record the implementing commit and check results with the task. A completed plan review does not satisfy INSTALL-07, which reviews the actual implementation.

Delivery is complete when the second PR contains the approved behavior, all required validation has passed, and confirmed review findings are resolved. Merge and release remain separate actions. Search's two-minute deadline and 10 MB decoded-response limit remain part of the first PR; this selector plan does not alter them.

## 1. Interface and existing behavior

The approved interface adds two options to the existing `install` command and its alias `i`:

```text
skillsmith install <repository> --skill <name> [--skills-match-frontmatter]
```

`--skill` supplies the lookup name. `--skills-match-frontmatter` is a boolean option: its presence forces matching against the `name:` field in `SKILL.md`. It takes no value and requires `--skill`.

| Concern | Existing contract | Contract after this change |
| --- | --- | --- |
| Select by directory basename | `install owner/repo/review` | Existing form remains; also accept `install owner/repo --skill review`. |
| Select by exact nested path | `install owner/repo//skills/review` | Unchanged; this is the remedy for duplicate nested basenames or declarations. |
| Select by frontmatter name | No repository-wide declared-name lookup | `--skill` falls back to declared names only if no directory matches. |
| Conflicting directory and declared name | No declared-name matching | Directory wins by default; the boolean override skips directory matching. |
| Saved identity | Directory-derived installed name, exact source path, commit SHA and content hash | Unchanged; lookup text never renames an installed skill. |
| `--path`, `-s`, and `@ref` | Destination, scope, and Git reference respectively | Unchanged. |
| Search output | Search PR displays catalog metadata and URLs | Unchanged; this PR does not change `search@1` or add generated install commands. |

For a concrete example, consider these two files:

| Repository file | Declared `name:` | Installed name |
| --- | --- | --- |
| `skills/review/SKILL.md` | `code-review` | `review` |
| `skills/security-review/SKILL.md` | `review` | `security-review` |

Before this change, selecting the first file requires a directory selector such as `acme/agent-tools/review` or the exact path `acme/agent-tools//skills/review`. Its declared name `code-review` is not a lookup key. After this change:

```sh
# Directory match selects skills/review and installs it as review.
skillsmith install acme/agent-tools --skill review

# No directory match; declared-name fallback selects the same skill.
skillsmith install acme/agent-tools --skill code-review

# The override selects skills/security-review and installs it as security-review.
skillsmith install acme/agent-tools --skill review --skills-match-frontmatter
```

These are illustrative future commands, not instructions to install example repositories during this work. A future install command generated from catalog metadata must include `--skills-match-frontmatter`, because a catalog name can conflict with a directory name. That command-generation feature is outside this PR.

## 2. Matching and validation contract

The directory-first order and boolean override are user requirements. Case comparison, lookup-name bounds, metadata budgets, and failure handling below are implementation policies that make those requirements deterministic.

| Request and result | Action |
| --- | --- |
| Default mode, one directory match | Select it without reading other candidates' frontmatter. |
| Default mode, several directory matches | Refuse as ambiguous; no frontmatter fallback and no picker. |
| Default mode, zero directory matches | Scan the full eligible candidate set for declared names. |
| Override present | Skip the directory tier and scan declared names. |
| Declared-name scan, exactly one match | Select it only after the complete scan succeeds. |
| Declared-name scan, zero matches | Report no matching skill. Never fall back to directory names. |
| Declared-name scan, several matches | Refuse as ambiguous; never choose the first result or invoke a picker. |
| Scan incomplete | Fail as a source error, even if an earlier file matched. |

Directory equality remains case-sensitive. Declared-name equality compares complete strings using JavaScript `toLowerCase()` on both sides, without locale-sensitive comparison, substring search, Unicode normalization, trimming, or slugification. Keep candidate identity as `{ path, name }`; `name` remains the directory basename, or the repository basename for a root skill.

Use one pure lookup-name validator at input and metadata boundaries. A usable lookup name has 1–256 Unicode code points, does not begin with ASCII `-`, has no leading or trailing Unicode whitespace, and contains no characters in Unicode categories `Cc`, `Cf`, `Cs`, `Zl`, or `Zp`. Internal spaces and punctuation are allowed. Existing installed-name validation remains stricter and unchanged. Input violations are usage errors; absent, non-string, or unusable metadata names are ineligible rather than matches. The leading-dash restriction is an implementation policy that keeps option-shaped missing values unambiguous. It applies equally to separated and attached values; a skill whose declared name is excluded remains addressable through its supported directory or exact-path selector.

Complete pure validation before context discovery, configuration reads, inventory, network access, or installation writes. The production CLI currently composes `createCurrentApplicationContext()` before calling the application service, and that composition initializes the artifact coordinator's private directory. Therefore application-level validation alone is too late. Put a shared pure selector-request validator in `acquire/selector-request.ts`, export it through the core entry point, and call it from CLI dispatch immediately after `commandRequest()` and before context composition. Repeat validation in the application and core entry points for non-CLI callers. Keep raw option-occurrence/value-provenance checks in CLI preflight. Reject:

- Missing or repeated values for `--skill`, repeated `--skills-match-frontmatter`, and values attached to the boolean option.
- The boolean override without `--skill`.
- `--skill` with anything other than one whole-repository source. Reject embedded name/path selectors using the parsed `SourceSpec.selector`, including URL and SSH forms.
- Empty or unusable lookup names. Preserve existing valid `--ref`, `--pin`, `--no-save`, and `--dry-run` combinations and their existing conflicts.

Both `--skill name` and `--skill=name` must work. `--skills-match-frontmatter` defaults to false and has no negative form. No new short option is introduced.

Commander consumes the next token as a required option value, even when it resembles another option. The shared validator must therefore reject `--skill --no-save`, `--skill --skills-match-frontmatter`, and `--skill --` before context construction. Both `--skill -example` and `--skill=-example` are invalid; ordinary accepted values work in both forms. This policy needs no new argument parser or attached-only exception to CLI Standard R3.5. Preserve the existing option terminator and actual occurrence counting. The parser behavior is documented in [Commander's required-option contract](https://github.com/tj/commander.js#common-option-types-boolean-and-value); [POSIX Guideline 10](https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap12.html#tag_12_02) distinguishes option arguments from a free option terminator.

On ambiguity, report the matching tier and candidate locations. Nested candidates get exact-path alternatives that replace `--skill` and `--skills-match-frontmatter`; retain the user's source host, transport, and selected ref. Build human retry operands from the validated transport-preserving `cloneUrl` plus `//<exact-path>`, and put the ref in a separately quoted `--ref` value. Do not append `@<ref>` or use `canonicalInvocation`: slash-containing refs such as `feature/review` do not round-trip through that inline grammar. Use shell-safe quoting and parser round-trip tests for HTTPS, SCP-style SSH, SSH URLs, subgroup repositories, and slash-containing refs. Keep this human formatting separate from existing machine-field meanings and unchanged wire keys.

Root candidates are displayed as `<repository root: SKILL.md>`. Existing trailing `//` means a whole-repository scan, not an exact-root selector; do not advertise it as a root retry command. A root conflict may be resolvable with a unique declared name and the override. If it is not, say that the current CLI cannot select that root unambiguously. Adding a public exact-root grammar is outside this change.

Use existing lifecycle error envelopes and exit classes: invalid usage, source failure, permission failure, and cancellation remain distinguishable. No-match and ambiguity use the existing per-source report paths. Messages identify the requested name and matching tier safely; never include raw frontmatter, parser excerpts, or unbounded Git output.

## 3. Architecture and source integrity

The production flow is the declarative CLI registry → raw option preflight → shared pure selector validation in `program.ts` → context composition → `runInstallApplication()` in `application/lifecycle-services.ts` → `runInstallInternal()` → `resolveRemoteSource()` → existing materialization, verification, placement, and artifact persistence. `packages/cli/src/commands/install.ts` is a compatibility path; changing it alone does not change the shipped command.

Add optional `skill` and `skillsMatchFrontmatter` fields to `InstallOptions`. Normalize them into one internal request with an explicit matching mode. Forward that request to `ResolveRemoteSourceInput`. Keep `SourceSpec.selector`, `CandidateSkill`, and the keys/result envelopes of `InstallSourceTransport` compatible. Selection metadata lives in a separate internal record and is discarded after choosing the existing candidate.

Resolution proceeds as follows:

1. For every explicit `--skill`, bypass `tryElide()` before fetch, including `--no-save`. One previously installed entry cannot prove that the repository contains no competing candidates.
2. Fetch using the existing transport and validate its immutable 40-hex commit SHA.
3. Enumerate candidates at that SHA. Keep the existing path eligibility rules, including exclusion of dot-prefixed path segments. A catalog listing does not override repository eligibility.
4. Apply the matching table. If metadata is needed, read it at the same SHA through the bounded Git capability below. Scan all eligible candidates before claiming a unique result.
5. Materialize only the selected candidate at the same SHA. Continue through the existing verification and installation machinery.

`lsTreeSkills()` and `sparseCheckoutSkill()` currently use `FETCH_HEAD`. Add an optional trailing resolved-SHA argument to these helpers, after the existing signal argument, and pass the validated SHA from `resolveRemoteSource()`. Existing callers may omit it; existing transport implementations with fewer parameters remain assignable. The default transport must honor the supplied SHA for both tree listing and checkout. This changes neither transport keys nor result envelopes. Tests must move `FETCH_HEAD` between phases to prove the supplied SHA controls metadata and installed bytes. Custom transports remain trusted capabilities, with this obligation documented and tested by default-adapter coverage.

The Git tree parser must not silently drop malformed records and then claim a complete candidate inventory. Tighten `GitPort.listTree` to reject invalid/truncated NUL-delimited records, while preserving valid empty trees, modes, object kinds, and literal filenames. Disable Git replacement objects for listing, bounded metadata reads, and materialization so the same commit consistently identifies the same tree. Keep Git arguments inside `ports/git.ts`.

### Bounded metadata reads

Add `GitBoundedBlobReadRequest` extending the existing blob request with `maxBytes`, and a `GitBoundedBlobReadPort`. Expose `GitPort.readBlobBounded` as an optional capability so old Git-port fakes remain assignable. Declared-name matching requires it and fails explicitly when absent; never fall back to unrestricted `readBlob()`.

The adapter validates a full commit SHA, an exact nonempty repository-relative path, and a nonnegative safe integer byte limit. It then:

1. Probes the exact commit/path with `git --no-replace-objects --literal-pathspecs ... ls-tree -l -z --full-tree <sha> -- <path>`.
2. Requires one complete record for that exact path, a regular-file blob with mode `100644` or `100755`, a valid object ID, and a valid byte size. This new bounded-file capability rejects symbolic-link blobs: their contents are link text, not the linked document. A symlinked `SKILL.md` makes declared-name scanning incomplete rather than silently hiding a potential match. Reject a size above `maxBytes` before starting the binary payload reader.
3. Reads the probed object ID using `cat-file blob`, again with replacement objects disabled. Verify the returned byte length equals the probed size. Check cancellation before, between, and after the subprocesses.

Git documents NUL-delimited literal filenames and size output for [`ls-tree`](https://git-scm.com/docs/git-ls-tree), raw object contents for [`cat-file`](https://git-scm.com/docs/git-cat-file), and the [`--no-replace-objects` / `--literal-pathspecs` switches](https://git-scm.com/docs/git). Use global argv switches, not `GIT_NO_REPLACE_OBJECTS` in the process environment: Skillsmith deliberately scrubs that variable in its Git adapter. Do not use filters or text conversions for metadata reads.

Also scrub `GIT_LITERAL_PATHSPECS`, `GIT_GLOB_PATHSPECS`, `GIT_NOGLOB_PATHSPECS`, and `GIT_ICASE_PATHSPECS` through the existing Git environment boundary. Otherwise inherited glob/case switches can conflict with the explicit literal switch and make valid requests fail. Test poisoned inherited environments through the adapter and real Git.

Keep `BinaryProcessPort` and unrestricted `readBlob()` unchanged. The size probe bounds application payload buffering; it does not bound Git's own memory, stderr, network transfer, partial-clone object retrieval, or total scan duration. A post-read length check alone is not a bound. Existing directory and exact-path installs keep their symlink behavior; only the new declared-name scan refuses unsupported metadata modes.

| Scan budget | Initial value | Enforcement |
| --- | --- | --- |
| Eligible candidates | 1,000 | Before any metadata payload reads; applies only when declared-name scanning is needed. |
| One `SKILL.md` | 1 MiB = 1,048,576 bytes | Probe before payload read. |
| Aggregate `SKILL.md` payload | 16 MiB = 16,777,216 bytes | Sequential reads, each capped at the lesser of the per-file ceiling and remaining budget. |

Accept exact boundaries. A zero remaining budget permits an empty blob but no nonempty blob. These are internal metadata policies, separate from search's two-minute HTTP deadline and 10 MB response body limit. Preserve existing Git subprocess deadlines and parent cancellation; this PR does not add install timeout/size options.

Decode with fatal UTF-8 validation. Missing frontmatter or a valid document with no usable string name is ineligible. Invalid UTF-8, malformed frontmatter, unsupported formats or file modes, failed reads, inconsistent Git metadata, or exhausted budgets make the scan incomplete and fail it. Permission and cancellation retain their own classification. Repair the existing `acquire/fetch.ts` error translation for cancellation in the touched helpers; it currently maps a cancelled port result to `source-unresolvable`. Test cancellation at adapter, helper, scan/resolver, and application boundaries, both with an aborted signal and with a normalized cancellation error. Always clean up acquisition scratch directories through existing ownership rules.

### Frontmatter parsing prerequisite

Do not extend the current `parseSkillFrontmatter()` behavior blindly. It calls `gray-matter` without restricting engines; the installed library includes a JavaScript engine implemented with `eval`. New repository-wide scanning must not execute a document while reading its name.

Make the shared parser explicitly data-only before using it here:

1. Recognize the opening header using gray-matter's existing input conventions, including a single leading byte-order mark, whitespace, LF/CRLF, and YAML/YML aliases. Preserve plain YAML and supported JSON. Reject every unsupported tag before invoking gray-matter, including empty blocks with executable or unknown tags.
2. Rewrite an allowed opening header to the untagged delimiter and select the canonical YAML or JSON parser explicitly. Supply fixed engines on every call: `js-yaml.safeLoad` with `DEFAULT_SAFE_SCHEMA` for YAML and `JSON.parse` for JSON. Declare `js-yaml` version `3.15.2`, already resolved transitively by this checkout, as a direct core dependency; include compatible type declarations and lockfile changes. Document text must not choose an executable engine. Do not import an undeclared dependency or rely on an `eval: false` option.
3. Always pass explicit options. Gray-matter's no-options cache can retain a partially parsed record after a failure and return success on a repeated call. Explicit options bypass both cache retrieval and insertion. Do not mutate global engine tables or cache state.
4. Keep the public parser result shape. Valid scalar/null documents and missing/non-string names produce empty or ineligible metadata. Return stable parse errors without raw document excerpts.

Retain existing delimiter extraction behavior explicitly, including an unterminated frontmatter block ending at end-of-file and gray-matter's closing-delimiter-prefix handling. Here, malformed frontmatter means a parser failure, not a newly introduced strict Markdown-envelope validator. Test these compatibility cases rather than accidentally changing them while securing engine dispatch.

Add a harmless synthetic expression fixture whose only effect, if evaluated, would set an in-memory marker, and assert that no evaluation occurs. Cover BOM/whitespace/CRLF executable aliases, unknown empty blocks, ordinary YAML/JSON controls, repeated malformed YAML/JSON, and prepopulated cache entries. This is a narrow prerequisite for both new selection and existing parser consumers, not a general parser replacement.

## 4. Persistence and compatibility

Persist the selected directory path, full commit SHA, and content hash with the existing schemas. Root identity remains manifest `source.path: null` and lock `sourcePath: "."`; nested paths remain exact. Keep the directory-derived installed name even when frontmatter selected the skill.

Later lifecycle operations must resolve that saved path, not repeat the user's lookup. They must work with skills.sh unavailable and with changed or duplicate declared names at a newer revision. If the saved path disappears, fail according to existing source/update rules; never redirect to a different path with the same name.

There is an existing root-path hazard to reproduce: `reconcile/resolve.ts` and `reconcile/apply-execution.ts` rebuild root declarations as name selectors, while `update/observe.ts` parses the root source as a whole-repository scan. A nested skill sharing the repository basename can make that lookup ambiguous. Worse, if root `SKILL.md` disappears while that nested skill survives, plan resolution can pin the nested bytes with a root `sourcePath: "."`. Establish failing controls first, then use internal exact-path selection `{ kind: 'path', path: '' }` for persisted root paths in these consumers. Require exact path equality after resolution for root and nested cases. Do not change public source grammar or reinterpret persisted `null` as an unknown path; existing lock validation equates `null` with `"."`.

Keep `install@2` unchanged. Its closed `requested` record must not gain undeclared selector fields. Resolved source/path/SHA remain the report's source of truth. Keep `search@1`, manifest/lock versions, and `InstallSourceTransport` result envelopes unchanged. Add public type exports for the optional bounded capability and update exact live port inventories deliberately.

## 5. Ordered implementation tasks

Each task is complete only after its acceptance checks pass. Tests establish behavioral failures and inverse controls, rather than mirror the implementation. Section 8 records implementation evidence separately from the original planning review.

### INSTALL-01 — Establish failing behavior and compatibility fixtures

**Depends on:** reviewed plan. **Files:** new `packages/core/tests/acquire/declared-name.test.ts` and `packages/cli/tests/commands/install-selector-roundtrip.test.ts`; relevant existing resolve/source/CLI contracts.

Create dedicated local bare repositories using the pattern in `packages/core/tests/fixtures/acquire/remote.ts`; do not change shared fixture candidate counts. Record current failures for the new options and root saved-path reconstruction. Build directory/frontmatter conflicts, repeated basenames, duplicate declarations, root plus nested skills, hidden paths, and two revisions with changed declarations. Include positive controls for existing name/path/ref installs and negative controls proving metadata reads and pickers are not called on a directory winner or directory ambiguity.

**Acceptance:** each proposed fix has a reproducible failing case; existing supported forms pass. A root-only repository is the control for root plus nested/same-basename cases. No tests depend on external providers or real installations.

### INSTALL-02 — Make frontmatter reads data-only and bounded

**Depends on:** INSTALL-01. **Files:** `packages/core/src/skills/frontmatter.ts`; core `package.json` and `bun.lock` for the declared parser dependency; `ports/types.ts`, `ports/git.ts`, `acquire/fetch.ts`, public exports; corresponding parser/Git/default-port/type tests.

Implement the parser prerequisite and optional bounded Git method. Cover default adapter composition. Add the method to the live exact-key assertions in `tests/ergonomics/fixtures/p1-ts08/read-only-capability.ts` and the operation inventory in `EWP-P1-TS08.test.ts`; preserve old fake assignability. Tighten tree parsing and replacement-object handling needed for complete inventory.

**Acceptance:** oversized blobs cause zero binary payload reads; the checked object ID is the one read; replacement refs cannot substitute another object; literal pathspec punctuation does not expand; inherited pathspec settings cannot alter or break the command; exact boundaries succeed. Reject malformed/multiple/truncated/wrong-path/non-blob probe records, unsupported file modes, bad sizes/object IDs, length mismatches, and invalid UTF-8. A symbolic-link metadata fixture with a matching target fails as incomplete instead of disappearing from the scan. Cancellation between probe and read starts no payload read and remains cancellation through helper/result translation. YAML and supported JSON remain data; executable frontmatter never runs; repeated malformed input remains an error; cached input cannot bypass validation. Error output contains no raw document or synthetic marker. Run existing parser-consumer tests as well as new cases.

### INSTALL-03 — Implement deterministic selection at one commit

**Depends on:** INSTALL-02. **Files:** new `packages/core/src/acquire/selector-request.ts` and `declared-name.ts`; `acquire/resolve.ts`, `acquire/fetch.ts`, additive request types, and the shared validator's public core export.

Implement the pure validator and matching tier logic, full metadata scan, budgets, and direct ambiguity outcome. Pass the resolved SHA through enumeration and materialization. Bypass cached-store elision for explicit selectors, including `--no-save`, regardless of whether an old ledger entry matches the request. Keep normal installs without these options on their existing selection/picker path.

**Acceptance:** every row in section 2 is covered. A late invalid document invalidates an earlier apparent unique match. Duplicate names at either tier refuse with a picker that throws if called. For the cache regression, populate one cached entry using an exact-path install at a SHA that already contains competing candidates; then run `--skill ... --no-save` at that same SHA. Require full selection and ambiguity refusal, and assert that the elision `transport.resolveRef` probe was not called. A fixture that changes the SHA is insufficient: existing elision already misses stale revisions. Preserve an ordinary no-selector `--no-save` install as the positive elision control. Mutable `FETCH_HEAD` cannot change the selected or installed bytes after the SHA is resolved. The missing bounded capability fails only when frontmatter scanning is necessary.

### INSTALL-04 — Wire production CLI and application preflight

**Depends on:** INSTALL-03. **Files:** `packages/core/src/acquire/types.ts`, `acquire/run.ts`, `application/lifecycle-services.ts`; CLI `program.ts`, `runtime/preflight.ts`, `contracts/commander-current-state-v0.json`, `contracts/cli-migration-ledger.ts`, `spec/options.ts`, `spec/registry.ts`, and supported compatibility command code.

Register two singular long options, their descriptions/help families, and relations. Add additive migration ownership rather than rewriting historical registry baselines. Validate raw tokens in preflight and the normalized request before `createCurrentApplicationContext()` in production dispatch. Repeat shared pure validation before application `resolveContext()` and before I/O in the core. Forward normalized fields through the production lifecycle path. Adapt no-match/ambiguity labels for the new request without widening closed wire contracts.

**Acceptance:** `install` and `i`, separate and attached skill values, option ordering, `--`, `--json`, and existing destination/ref/pin modes behave consistently. Leading-dash lookup values fail in both forms, including tokens spelling `--no-save`, `--skills-match-frontmatter`, and `--`; positive ordinary-name controls work in both forms. Prove the shared metadata validator also excludes leading-dash declarations, while directory/exact-path selection still works. Missing/repeated/incompatible options fail with poisoned context and I/O fakes. Include a production-dispatch test that replaces the context/coordinator factory with a throwing fake, proving rejection happens before the factory is called; testing only the application service is insufficient. Existing `owner/repo/name`, exact nested paths, `-s`, and `--path` retain their behavior. Installed names and `install@2` keys remain stable.

### INSTALL-05 — Preserve exact saved paths across lifecycle commands

**Depends on:** INSTALL-03 and INSTALL-04. **Files:** `packages/core/src/reconcile/resolve.ts`, `reconcile/apply-execution.ts`, `update/observe.ts`; new round-trip tests and focused existing lifecycle tests.

After reproducing the root hazard, make persisted-root reconstruction exact and apply the same path-equality checks to root and nested sources. Keep existing pin, content hash, requested-ref, stale-plan, and store verification requirements. Do not change artifact schemas, coordinator/recovery protocols, or update approval semantics.

**Acceptance:** run install → saved manifest/lock → fresh `plan` with a missing lock → uncached `apply` → `update`, using isolated state and no search provider. Exercise a root-only control, root plus unrelated nested skill, root plus a nested repository-basename skill, and a nested frontmatter-selected skill. Explicitly remove root `SKILL.md` in the next revision while retaining `skills/<repository-basename>/SKILL.md`: plan/update must fail the missing root, never pin or install the nested bytes as root. Include the corresponding missing nested-path case. A renamed/duplicated declaration cannot redirect later operations. Root payload still excludes `.git`, retains intended tracked files, and keeps source/content identity stable. Distinguish hash stability at the same revision from expected hash changes when tracked root contents change.

### INSTALL-06 — Document the new contract and close live inventories

**Depends on:** INSTALL-04 and INSTALL-05. **Files:** `README.md`, `packages/cli/src/help/topics.ts`, registry help examples, `runtime/current-renderers.ts`, generated `docs/commands.md`; current option/help/completion/search contract tests and ergonomics inventories.

Add the before/after example from section 1 and the directory-first/override explanation near existing install usage. Explain that lookup names do not rename installations, list the metadata scan limits and exact-path remedy, and document the root ambiguity limitation. Update ambiguity output without inventing a root command or dropping host/ref. Keep completion local: no repository or network lookup for `--skill`.

Live option count increases from 288 to 290; the canonical command inventory remains unchanged. Recompute the live inventory hash and declare the parser dependency additions in `EWP-P1-TS11.test.ts`. Replace the search-PR-only assertion in `packages/cli/tests/contracts/search.test.ts` that prohibits `install --skill` with positive selector assertions. Keep historical release/P17 snapshots unchanged. Regenerate command docs from the registry, then check that generation is clean.

**Acceptance:** source help, alias help, generated docs, README, completion inventory, strict JSON, and rendered retry guidance agree with the final interface, including the leading-dash lookup restriction. Every nested retry command parses back to the exact host/transport/path/ref and omits both selector options; root candidates never get a misleading executable retry. CLI Standard 1.4.14 scoped note covers long kebab-case options (R3.3), both value forms for every accepted lookup value (R3.5), and default-false presence booleans (R3.6); existing whole-CLI deviations remain recorded in the parent plan. No new MUST deviation or SHOULD waiver is introduced by this selector design.

### INSTALL-07 — Review and validate implementation

**Depends on:** INSTALL-02 through INSTALL-06. Run implementation iterations with the relevant focused selectors and `bun run test:smoke`. Add `bun run test:smoke:p2-ts04:recovery` only if coordinator/recovery behavior is actually touched. Do not repeat the full crash/permission matrix during ordinary iterations.

Have three independent reviewers inspect the implemented diff against this plan: one for matching and CLI compatibility, one for Git/frontmatter reads, and one for cache and saved-state behavior. Each finding must identify a concrete counterexample, source location, and impact. Verify findings against live behavior, fix confirmed defects, and have the relevant reviewer recheck the repair. Record refuted findings with evidence and keep unresolved findings visible. This implementation review is distinct from the completed plan review in section 6.

After focused checks and smoke pass, commit the implementation candidate, including every new regression suite, and verify a clean worktree before the terminal gate. `scripts/run-test-files-serial.ts` first requires a clean repository and then discovers tests through `git ls-files -z`; staging alone is insufficient. Verify every new suite appears in the captured discovery list or per-file execution log. The final JSON receipt has counts and a manifest hash, not a list of filenames. The candidate commit is not a claim that the terminal gate passed. Any repair after that gate needs focused verification, a new clean candidate commit, and gate evidence for the new head.

Use pinned Bun 1.3.14. On this macOS checkout, set `TMPDIR=/private/tmp` so filesystem fixtures use a canonical temporary path. From the worktree root, the principal focused checks are:

```sh
bun test packages/core/tests/skills/frontmatter.test.ts packages/core/tests/ports/git.test.ts packages/core/tests/ports/default.test.ts packages/core/tests/ports/types.test.ts
bun test packages/core/tests/acquire/declared-name.test.ts packages/core/tests/acquire/selector-request.test.ts packages/core/tests/acquire/source.test.ts packages/core/tests/acquire/resolve.test.ts
bun test packages/cli/tests/commands/install-selector-roundtrip.test.ts packages/cli/tests/contracts/install-selector.test.ts packages/core/tests/ports/git-bounded.test.ts
bun test packages/core/tests/application/lifecycle-services.test.ts --test-name-pattern 'install'
bun test packages/cli/tests/contracts/install.test.ts packages/cli/tests/contracts/options.test.ts packages/cli/tests/contracts/help.test.ts packages/cli/tests/contracts/search.test.ts
bun test packages/cli/tests/contracts/completion.test.ts tests/ergonomics/phase/EWP-P6-TS04.test.ts
bun test tests/ergonomics/phase/EWP-P1-TS08.test.ts
bun test tests/ergonomics/phase/EWP-P1-TS11.test.ts --test-name-pattern 'family 8'
bun test tests/ergonomics/phase/EWP-P2-TS07.test.ts --test-name-pattern 'canonical acquisition DTO|shared authority at observation and public type'
bun scripts/generate-command-reference.ts --check
bun run test:smoke
```

Verify test-name selectors against the live titles before use; a zero-test run is not evidence. Include focused reconcile/update and completion/documentation checks when those files change. Run lint, boundary lint, typecheck, and the canonical `bun run check` terminal gate once at the implementation milestone. If a failure also occurs on unchanged baseline, record the reproduction and obtain the appropriate CI evidence; do not label an unrun or failing check as passed. Build a native binary and verify help, invalid-option preflight, and a hermetic local-repository install to cover compiled dispatch.

**Acceptance:** all three implementation reviews are complete, confirmed defects are repaired, and no unresolved finding is hidden by a passing test suite. Retain commands, commit SHA, counts/skips, and relevant platform limitations in the second PR evidence. Search PR test receipts do not validate this new branch. A final diff audit confirms no schema drift or unrelated recovery changes.

### INSTALL-08 — Deliver the selector PR separately

**Depends on:** INSTALL-07. Deliver the clean candidate already committed and validated in INSTALL-07. Complete implementation review before the final gate when possible; if later review requires a repair, repeat the relevant checks and the clean-candidate gate before claiming readiness. Open the second PR with only the selector, its narrow prerequisites, tests, and docs. While #100 is unmerged, use `feat/search-discovery` as the stacked PR base; after #100 merges, rebase/retarget to `main` and check the resulting diff. Refresh live PR state before deciding the base. Do not merge, tag, or release as part of this task.

**Acceptance:** the PR description states existing behavior, new behavior, compatibility limits, and validation. It does not claim an executable search-to-install hint exists. The saved-state and metadata-selection cases are traceable to tests, and adversarial implementation findings are resolved or explicitly reported.

## 6. Adversarial review record

Three independent reviewers challenged the plan against source baseline `8189acb`. Each performed source inspection and bounded local probes, proposed concrete counterexamples, and re-read the repaired sections. Reviewers made no source changes and ran no large suites or real installations.

| Reviewer | Scope | Final verdict |
| --- | --- | --- |
| `selector_review_cli` | Matching rules, production CLI boundary, source grammar, public/wire contracts, option inventory, and scoped CLI conformance | Ready at plan level; CLI-01 through CLI-03 resolved. |
| `selector_review_git` | Metadata parsing, bounded Git reads, immutable source selection, process environment, and cancellation | Ready at plan level; GIT-01 through GIT-04 resolved. |
| `selector_review_state` | Cache behavior, root/nested identity, plan/apply/update persistence, and validation closure | Ready at plan level; STATE-01 through STATE-03 resolved. |

The finding IDs below identify review notes within this document, not project or backlog IDs. Important findings have concrete consequences. Clarifications define tests or policies without claiming that unimplemented code already has a runtime defect.

| Finding | Evidence and consequence | Plan repair and disposition |
| --- | --- | --- |
| CLI-01 — important; following bad precedent | `program.ts:467` constructs context before the application service; `runtime/context.ts:88` initializes an artifact coordinator whose `node-coordinator.ts:659` ensures a private directory. Application-only preflight can write state before refusing invalid input. | Shared pure validation before production context composition, repeated at application/core boundaries; poisoned-factory test. Resolved in section 2 and INSTALL-04. |
| CLI-02 — policy clarification; existing parser behavior | Commander and the relation interpreter consume option-shaped required values. Treating that conventional behavior as inherently defective was too broad; an attached-only workaround would conflict with R3.5. | Explicit lookup domain excludes leading ASCII `-` in both forms and metadata; accepted values retain both forms. New policy documented and tested in section 2, INSTALL-04, and INSTALL-06. No attached-only exception or new parser. |
| CLI-03 — important; new pattern | `acquire/source.ts:57–59` rejects inline refs containing `/`; converting accepted SSH input to host shorthand changes transport to HTTPS. A naive ambiguity retry can fail or address the wrong transport. | Render from transport-preserving `cloneUrl` with exact nested path and separate quoted `--ref`; parser round-trip matrix. Resolved in section 2 and INSTALL-06. |
| GIT-01 — important; following bad precedent | The shared parser's gray-matter engine table includes JavaScript evaluation. Its no-options cache stores a record before parsing, so a failed parse can succeed on retry. | Data-only dispatch, fixed parsers, explicit options/cache bypass, declared dependency, preserved delimiter compatibility, and excerpt-free errors. Resolved in section 3 and INSTALL-02. |
| GIT-02 — important; following bad precedent | `ports/git.ts` does not scrub pathspec environment switches; inherited glob/case settings make explicit literal mode fail in real Git. | Scrub all four switches and test poisoned environments. Resolved in section 3 and INSTALL-02. |
| GIT-03 — important; new pattern | `lsTreeSkills()` accepts symlink blobs, while a raw Git read returns link text rather than the target document. Treating it as unnamed can hide a competing declaration. | Require regular-file modes for the new bounded read; unsupported metadata mode makes scanning incomplete. Existing directory/path installs remain compatible. Resolved in section 3 and INSTALL-02. |
| GIT-04 — important; following bad precedent | `acquire/fetch.ts:30–37` translates a normalized port cancellation to a source failure. A helper probe reproduced this; a corresponding top-level CLI misclassification was not established. | Preserve cancellation in touched helper translations and test adapter/helper/resolver/application boundaries. Resolved in section 3 and INSTALL-02/03. |
| STATE-01 — important; deliberately changing precedent | `tryElide()` already misses entries from older SHAs; a revision-changing fixture would not detect a missing selector bypass. | Seed a cached exact-path entry at the same SHA containing competitors; require full scan and no elision probe, with an ordinary-install inverse control. Resolved in INSTALL-03. |
| STATE-02 — important; completing good validation precedent | The terminal runner discovers only tracked tests and first refuses any dirty worktree. The review's initial staging-only recommendation was incomplete. Its JSON receipt does not enumerate filenames. | Focused/smoke checks, committed clean candidate, then terminal gate; inspect discovery/per-file logs for new suites. Follow-up review confirmed this correction in INSTALL-07/08. |
| STATE-03 — clarification of an important existing hazard; following bad precedent | Root declarations rebuild name selectors. A local probe showed a missing root plus surviving nested repository-basename skill can produce a root pin from nested bytes. | Internal exact-root selection and explicit disappearing-root regression, with root-only/unrelated-nested controls. Resolved in section 4 and INSTALL-05. |

The reviewers also confirmed good precedent worth preserving: directory-derived installed names, persisted exact source facts, strict wire schemas, declarative command registration, and the existing artifact coordinator boundary. The new optional Git capability follows the existing port design. Intentional departures are explicit-selector ambiguity without a picker, full repository validation despite a cached installation, and refusal to execute frontmatter. None requires a manifest/lock migration or a coordinator/recovery redesign.

Planning evidence is separate from implementation acceptance:

- A disposable Bun process confirmed ordinary YAML parsing and that a synthetic JavaScript frontmatter expression could set an in-memory marker in the baseline parser. No files or network were used by that expression.
- A temporary Git repository confirmed a 21-byte original blob stayed 21 bytes through the proposed replacement-disabled probe/read sequence; ordinary replacement-aware reading returned a synthetic 65,536-byte replacement. This validates the Git mechanism, not an adapter implementation.
- Reviewer probes confirmed repeated malformed frontmatter could change from failure to success through gray-matter's default cache, inherited pathspec settings could fail literal-mode commands, and cancellation was misclassified by the existing helper.
- Root-selection probes compared root-only, root plus unrelated nested skill, root plus same-basename nested skill, and missing-root layouts. The proposed exact-path selector matched the intended root or refused its absence.

**Final disposition:** all reviewed plan findings are resolved. No owner decision remains open for this implementation plan. This closes the plan review only. Implementation acceptance is recorded separately below.


## 8. Implementation evidence and review

Implementation began from `d14ac19`, which contains this reviewed plan and its task roadmap.
The initial parser, selector, and saved-root fixtures ran against unchanged runtime code:
22 tests passed and 21 failed. The failing cases included new selector behavior, executable
frontmatter/cache handling, and incorrect saved-root resolution. These are distinct from later
implementation checks.

Three independent adversarial reviewers examined core metadata/Git behavior, CLI contracts,
and persistence. The user subsequently requested subagent-driven development, and those agents
became the owners of bounded core, CLI, and lifecycle completion tasks. The parent integrates
changes and owns repository-wide validation and PR delivery.

| Implementation finding | Resolution and evidence |
| --- | --- |
| Multiple byte-order marks could expose a JavaScript engine after header validation. | Only validated opening headers reach gray-matter; body-only input returns directly. Parser and byte-decoding scanner tests use an inert in-memory marker. |
| Thrown transport cancellation lost its classification. | Preserve cancellation/permission before generic wrapping; check the abort signal between acquisition phases. Tests cover thrown/returned failures and successful results after cancellation. |
| Selector preflight omitted explicit refs and masked short-SHA source failures. | Pass `ref` through the shared validator and preserve existing source parse errors. Poisoned-context tests prove invalid inputs cause no context access. |
| Ambiguity lacked its matching mode, and some generated retry operands did not parse. | Diagnostics name the matching mode. Nested retry operands must round-trip host, transport, path, and separate ref. Otherwise display a location without an executable command. |
| Root update history copied the ledger's empty path into a portable source that requires `"."`. | Normalize retained source history, plan ownership, apply observation, and update provenance at their boundaries. Real Git root and nested lifecycle tests pass, including zero-drift checks after apply and update. |
| The first lifecycle fixture retained its lock and therefore missed fresh manifest resolution. | Remove the lock, ledger, cache, and live placement before saved planning/apply. Assert the reconstructed path, SHA, and content hash equal the installed source. |
| A custom transport could supply a candidate name different from its directory basename. | Derive nested names from their paths, reject inconsistent supplied names, and preserve directory-derived installed identity. |
| CLI help expanded beyond its three-workflow contract. | Retain one established install example and two selector examples; preserve other source forms in source help and README. |
| UTF-8 decoding and frontmatter parsing each removed a byte-order mark. | Preserve decoded byte-order marks for the shared parser to handle once; direct parsing and scanning must agree for zero through three marks with YAML and JSON. |

All new lifecycle fixture state, including artifact coordination, lives below the owned temporary
root. The CLI fixture uses the production command graph and application services with the test
artifact coordinator. Production coordination deliberately ignores HOME/XDG and is not redirected
by product behavior.

A separate existing behavior was reproduced with an exact nested source and no new selector:
removing a managed live placement while retaining its ledger record makes saved apply refuse
`reconcile-execution-stale`. The physical absent-state guard requires both the placement and ledger
pair to be absent. That retained-ledger repair behavior is outside this selector change; the fresh
manifest roundtrip removes the ledger to test the specified reconstruction workflow.

Read-only cross-review also reproduced existing root rehome and prune refusals in
`reconcile/observe.ts` and `reconcile/plan.ts`: those ownership comparisons still compare the
ledger's empty root path with portable `"."`. Identical nested-path controls remain correct.
These conservative refusals do not permit wrong-source mutation and are outside the selector's
install, reconstructed plan, saved apply, and update acceptance scope.

Candidate validation used Bun 1.3.14 and canonical `TMPDIR=/private/tmp`:

| Check | Observed result |
| --- | --- |
| Integrated 13-file selector/CLI/lifecycle/registry run | 261 passed; one live dependency-inventory assertion failed because it omitted the new declared parser packages. The inventory was corrected and its focused family then passed. |
| Final parser and declared-name checks | 49 passed, including eight YAML/JSON controls for zero through three byte-order marks; two new controls reproduced failure before the decoder repair. |
| Independent CLI/request review | 74 focused tests and 715 assertions passed; six additional argv probes confirmed preflight and terminator behavior. |
| Lifecycle owner checks | 18 passed; final affected root/nested roundtrips passed with 47 assertions after strengthening `.git` exclusion. |
| Default smoke | Five passed, 3,737 assertions. |
| Recovery smoke | Four passed, 453 assertions. |
| Static and generated checks | Biome, ESLint boundaries, TypeScript, generated references, actionlint, and `check:p17` passed. Frozen dependency installation passed. |

Compatibility checks also exercised installation, reconcile planning/apply, update planning, and
Git ports. Two default filesystem tests fail in this local sandbox: temporary-directory group
ownership differs from the effective process group, and Unix-domain socket creation is denied.
Unchanged baseline controls reproduce both. Their assertions remain intact; final acceptance
requires the canonical Ubuntu CI gate for this candidate, not the earlier search PR's receipt.

The PR records the clean candidate SHA, compiled CLI evidence, terminal gate result, final CI
receipt, and delivery status. Earlier search-PR CI results are not selector validation evidence.
