# verify

> P17 disposition: shipped command evidence, not future target authority; target: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#89-verify

> P19 correction: the historical Codex `exec`/stderr probe below is superseded by the
> [local app-server verifier](../../packages/core/src/agents/codex/README.md).
> Required incomplete coverage is inconclusive, not passed; see the
> [current generated command reference](../../docs/commands.md#skillsmith-verify).

`skillsmith verify` loads a plugin under each target tool's own verifier and reports a **per-tool
result matrix** — never one merged verdict. It is the artifact-facing sibling of `doctor`/`check`:
`doctor` diagnoses the environment, `verify` diagnoses a specific plugin **or bare skill**. Static
verification is the default; `--deep` opts into a session-backed load confirmation. Both modes are
auth-free and model-free — the `--deep` opt-in is about startup latency, not auth or cost.

Full design rationale, the JSON contract, and the empirical basis live in
`docs/superpowers/specs/2026-07-06-verify-design.md` and
`research/skill-plugin-load-verification-2026-07-06.md`. This page is the command surface.

## Argument order

```
skillsmith verify <path> [FLAGS]
```

One required positional: `<path>`, a **plugin directory** (contains `.claude-plugin/plugin.json` and/or
`.codex-plugin/plugin.json`, with skills under `skills/<name>/SKILL.md`) **or a bare skill directory**
(contains a `SKILL.md`). A bare skill is wrapped in an ephemeral generated plugin (minimal `plugin.json`
+ `skills/<name>/`) before verification. A missing path, a non-directory, or a directory with neither a
plugin manifest nor a `SKILL.md` is a usage error (exit 2).

## Commands

**`skillsmith verify <path> [--tool <name>]... [--static | --deep] [--strict] [--json]`** — P11.
Runs each requested tool's load verifier against `<path>` and prints one result per (tool, mode). No
`--tool` means "every tool SkillSmith detects on PATH among `{claude-code, codex}`." Default mode is
static — `claude plugin validate` for Claude, temp-`CODEX_HOME` marketplace/`plugin add` for Codex —
which needs no auth and spends no model call. `--deep` additionally runs a session-backed check
(Claude's `stream-json` `init` event; Codex's `codex exec` stderr scrape) that confirms load and, for
Codex, is the *only* surface that validates skills — and, like static, it runs isolated under empty
config dirs, so it too needs no auth and no model call (both tools enumerate at session init before any
API turn). Output is a human-readable matrix by default;
`--json` emits the versioned contract consumed by the smorin-harness `skill-verify` skill.

Rationale for the static/deep split: static is instant, deterministic, and hermetic, so it is the
correct CI default and the whole gate for Claude (manifest + skills). Deep is also auth-free and free of
model spend (it runs isolated; the `init` / skill-load surfaces fire before any API turn) — its only
extra cost is startup latency (~2-8 s/tool), so it is opt-in for speed. It is load-bearing for Codex,
whose static path checks the plugin manifest only; `verify` surfaces that coverage gap rather than hiding
it behind a green checkmark.

## Per-tool surfaces

What each (tool, mode) actually inspects (proven against Claude Code `2.1.201`, codex-cli `0.142.5`):

| Tool · mode | Auth / model | Manifest | Skills | Reasons | Underlying command |
|---|---|---|---|---|---|
| claude · static | none | ✓ | ✓ | ✓ | `claude plugin validate <dir> [--strict]` |
| claude · deep | none (isolated) | — | presence only | ✗ (silent drop) | `CLAUDE_CONFIG_DIR=$(mktemp -d) claude --print --verbose --output-format stream-json --setting-sources "" --plugin-dir <dir> "ok"` |
| codex · static | none | ✓ | ✗ | ✓ (manifest) | temp `CODEX_HOME`; `codex plugin marketplace add` + `codex plugin add` |
| codex · deep | none (isolated) | — | ✓ | ✓ | empty `CODEX_HOME`; `codex exec -C <proj> --skip-git-repo-check …`; grep `failed to load skill` |

**Severity is reported per tool, never merged.** The same defect can disagree across tools — a skill
missing `description` is a `warning` in Claude (loads unless `--strict`) and an `error` in Codex
(dropped). Each finding carries both the tool-native severity token and a normalized `error | warning |
info` axis, and findings stay nested under the tool that produced them, so the disagreement is preserved.

## Output and exit behavior

Default human output groups by tool, then by mode within tool, then lists findings with their
tool-native severity marker, the check id, the message, and the file. A coverage notice is printed when
a mode inspected less than the whole plugin (e.g. codex static, manifest-only). `--json` emits a single
`{schemaVersion: 1, kind: "skillsmith.verify", …}` document; CI consumers should prefer it over parsing
human output. The schema is versioned and evolved additively — the `skill-verify` skill depends on it.

`verify` is read-only. It never prompts (so `--no-prompt` is a no-op) and never writes to real
`~/.claude` / `~/.codex`; Codex work happens under a throwaway `CODEX_HOME`, Claude deep isolates with an
empty `CLAUDE_CONFIG_DIR` + `--setting-sources "" --plugin-dir` (so deep runs offline and auth-free).
Observed tool versions are compared to the verified-against matrix; drift emits an `info` notice but
never changes a verdict.

Exit codes give CI a three-way distinction between a clean run, a real defect, and a can't-check:

```
0    verified — every mode that ran passed (warnings allowed unless --strict)
1    verification failed — a mode produced an error-severity finding (a proven defect)
2    usage error — missing/invalid <path>, or --tool given an unknown value
4    could not verify — nothing ran, an explicitly --tool-named tool is absent,
     or --deep was requested and a required tool's deep mode could not run
     (timeout/exec-error — deep never fails for auth)
130  cancelled via SIGINT
```

A proven defect (1) outranks an environment gap (4): if one tool finds a real break while another could
not run, the exit code is 1. An auto-detected tool that is simply absent is a silent skip and never
forces 4 — only an explicitly requested tool (or explicit `--deep`) does.

## Feature table

| # | Feature | Phase | Why |
|---|---|---|---|
| 12.1 | **`skillsmith verify <path>`** — per-tool matrix, static default, `--tool` repeatable, `--json` contract | P11 | Cross-tool load verification with no single false verdict; the `skill-verify` skill's engine. |
| 12.2 | **`--deep`** — session-backed load confirmation (Claude `init` event, Codex `exec` stderr) | P11 | Confirms actual load; the only skill-validation surface for Codex. Auth-free and model-free (runs isolated); opt-in for startup latency only. |
| 12.3 | **`--strict`** — treat warnings as failures; passed through to `claude plugin validate --strict` | P11 | Publish-gate parity with `claude plugin validate --strict`; mirrors `doctor --strict`. |

## Flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--tool` | `-t` | enum/repeatable | all detected of `{claude-code, codex}` | `SKILLSMITH_TOOL` | Restrict to tool(s). A named-but-absent tool → exit 4. |
| `--static` | — | bool | true | — | Static mode only (no auth, no model call). Default; states it explicitly. |
| `--deep` | — | bool | false | — | Also run deep (session-backed, isolated). Implies static. No auth, no model call; adds startup latency (~2-8 s/tool). |
| `--strict` | — | bool | false | — | Treat warnings as failures (`⚠` → exit 1); passed to `claude plugin validate --strict`. |
| `--json` | — | bool | false | — | Emit the versioned JSON contract on stdout. |

Global inherited flags (`-C/--cd`, `--color`/`--no-color`, `-v/--verbose`, `-q/--quiet`, `--debug`)
apply per `skillsmith-cli-design.md §3.1`. `--static` and `--deep` are not a conflicting pair: passing
both equals `--deep`; passing neither equals `--static`.

## Help output

```
Verify that a plugin loads under each target tool.

USAGE
  skillsmith verify <path> [flags]

FLAGS
  -t, --tool <name>       Restrict to tool(s): claude-code | codex. Repeatable. Default: all detected.
      --static            Static verification only (no auth, no model call). Default.
      --deep              Also run session-backed load verification (isolated; no auth, no model call).
      --strict            Treat warnings as failures (exit 1 on any ⚠).
      --json              Emit the versioned JSON report on stdout.

INHERITED FLAGS
  (See 'skillsmith help' for details)

EXAMPLES
  # Fast static gate against every detected tool
  $ skillsmith verify ./my-plugin

  # Only Claude, publish-strict
  $ skillsmith verify ./my-plugin --tool claude-code --strict

  # Full cross-tool check including session-backed load (isolated; no auth needed)
  $ skillsmith verify ./my-plugin --deep

  # Machine-readable, isolate the failures
  $ skillsmith verify ./my-plugin --json | jq '.tools[] | select(.verdict == "fail")'

EXIT CODES
  0    verified
  1    verification failed (a proven defect)
  2    usage error
  4    could not verify (tool/prerequisite unavailable)
  130  cancelled (SIGINT)
```

## Error and prompt mockups

**`skillsmith verify ./my-plugin` — matrix, one tool passing, one failing (human output):**
```
Verifying /Users/alice/dev/my-plugin  (mode: static · tools: claude-code, codex)

claude-code 2.1.201                                                    verdict: fail
  static  manifest ✓  skills ✓
    ✘ claude.frontmatter   skills/bad-yaml/SKILL.md
        YAML frontmatter failed to parse: YAML Parse error: Unexpected character.
    ⚠ claude.description    skills/bad-nodesc/SKILL.md
        No description in frontmatter.

codex 0.142.5                                                         verdict: pass
  static  manifest ✓  skills —
    ℹ codex.static-coverage
        codex static checked the manifest only; run --deep for skill validation

1 tool failed, 1 passed.  (1 error, 1 warning, 1 notice)  Exit code: 1
```

**`skillsmith verify ./my-plugin --tool codex` — required tool not installed:**
```
error: cannot verify: target tool 'codex' is not installed on this system.

  'verify --tool codex' requires the Codex CLI. To install it:

    npm install -g @openai/codex

  Re-run once installed, or drop --tool codex to verify with detected tools only.
Exit code: 4
```

**`skillsmith verify ./my-plugin --deep` — deep runs isolated, no auth needed:**
```
Verifying /Users/alice/dev/my-plugin  (mode: static, deep · tools: claude-code)

claude-code 2.1.201                                                    verdict: pass
  static  manifest ✓  skills ✓        (no findings)
  deep    manifest —  skills ✓ (presence)
      Loaded isolated (empty CLAUDE_CONFIG_DIR) — all declared skills present.
      (session ended with the expected auth-failed tail after init; not a failure)

verified: claude-code.  Exit code: 0
```

**`skillsmith verify ./nope` — path is not a plugin directory:**
```
error: '/Users/alice/dev/nope' is not a plugin directory.

  Expected a directory containing a plugin manifest
  (.claude-plugin/plugin.json or .codex-plugin/plugin.json).
Exit code: 2
```

## Resolved questions

Both open questions were resolved on 2026-07-07 (proven live; folded into the sections above):

1. **Input shape — RESOLVED.** `verify` accepts a plugin dir **or** a bare skill dir; a lone `SKILL.md`
   is wrapped in an ephemeral generated plugin (minimal `plugin.json` + `skills/<name>/`) before
   verification. Proven for both `claude plugin validate` and `--plugin-dir` runtime loading, and the
   Codex marketplace layout.
2. **Deep skip detection — RESOLVED.** Deep is auth-free and model-free: it runs under empty config
   dirs, so there is no auth skip to detect. The frozen auth-failure signatures are used only to
   recognize the *expected* healthy tail after a successful init/enumeration, never to gate a run.
