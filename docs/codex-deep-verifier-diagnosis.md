# Codex deep verifier diagnosis

Recorded on September 7, 2026. **Status: reproduced; alternative loader protocol
prototyped; production fix not implemented.** This document records the failure,
evidence, and possible follow-up work. It does not change verification behavior.

## Finding and scope

Skillsmith's Codex deep verifier starts `codex exec ... "ok"` to infer whether
local skills loaded. It expects a clean exit, a scraped skill-load error, or the
literal stderr text `401 Unauthorized` as evidence that loading ran.

In the observed restricted environment, DNS resolution for `api.openai.com`
fails before authentication. Codex retries its WebSocket and HTTPS transports,
then exits 1. Skillsmith reports deep `exec-error` and discards the explanation.
A separate aggregation defect labels the report `pass`, despite the CLI exiting
4 because requested deep verification did not complete.

The same Codex executable successfully loaded Agent Fork through `skills/list`
under the same restrictions. This establishes a verifier failure rather than
an Agent Fork loading failure for the tested target.

## Environment and source provenance

| Item | Observed value |
| --- | --- |
| Installed Skillsmith executable | `skillsmith-0.7.1`, reached through the `skillsmith` symlink |
| Source checkout inspected | `0b94398395820ca58e3ff209d18d9ee222f5f814` |
| Remote main when recorded | `af115e16afbadd9184bbd5ce2ff3258055789b7f` |
| Codex selected by Skillsmith | `/opt/homebrew/bin/codex`, version `0.145.0` |
| Codex first on the caller's PATH | Version `0.153.4` through a mise shim |
| Codex version recorded in Skillsmith's verification baseline | `0.142.5` |
| Target | Agent Fork's `.agents/skills/agent-fork` at commit `7c5932db2ffc088234449640986e0e8bf74bcee7` |
| Host | macOS ARM64; restricted child network access |

The relevant Codex verifier, normalization, execution, and verification-run
source files matched the local `v0.7.1` tag. A live source-history check found no
later change to the Codex verifier beyond its original July 7, 2026 commit.
The installed version above is an executable observation, not a claim about the
latest published GitHub release.

Skillsmith's [binary scanner](../packages/core/src/detect/scanners.ts) searches
Homebrew before the caller's PATH, explaining the version discrepancy. The
successful alternative probe used that same `0.145.0` executable, so changing
Codex versions is not what made the probe succeed.

## Reproduction

Prerequisites: the observed Skillsmith `0.7.1` executable and Codex `0.145.0`,
an [Agent Fork checkout at the tested commit](https://github.com/smorinlabs/agent-fork/tree/7c5932db2ffc088234449640986e0e8bf74bcee7),
and the restricted network environment described above. Run from that Agent
Fork checkout's root. `command -v` records which installed executable will run:

```sh
command -v skillsmith
skillsmith --version
skillsmith verify .agents/skills/agent-fork --tool codex --deep --strict --json > skillsmith-codex-report.json
verify_status=$?
printf 'exit code: %s\n' "$verify_status"
cat skillsmith-codex-report.json
```

The original run resolved `skillsmith` to the user's `~/.local/bin/skillsmith`
symlink and exited **4**. The following is an excerpt of that actual JSON report;
unrelated top-level metadata and command labels are omitted:

```json
{
  "requested": {
    "tools": [
      "codex"
    ],
    "modes": [
      "static",
      "deep"
    ],
    "strict": true,
    "explicitTools": true
  },
  "summary": {
    "verdict": "pass",
    "verified": [
      "codex"
    ],
    "failed": [],
    "skipped": [],
    "counts": {
      "error": 0,
      "warning": 0,
      "info": 2
    }
  },
  "tools": [
    {
      "tool": "codex",
      "toolVersion": "0.145.0",
      "verdict": "pass",
      "modes": [
        {
          "mode": "static",
          "status": "ran",
          "skipReason": null,
          "coverage": {
            "manifest": true,
            "skills": false
          },
          "verdict": "pass",
          "findings": [
            {
              "checkId": "codex.static-coverage",
              "toolSeverity": null,
              "normalizedSeverity": "info",
              "message": "codex static checked the manifest only; run --deep for skill validation",
              "file": null,
              "subject": "plugin"
            },
            {
              "checkId": "codex.version-drift",
              "toolSeverity": null,
              "normalizedSeverity": "info",
              "message": "codex 0.145.0 differs from verified 0.142.5; parsing may be less reliable",
              "file": null,
              "subject": "plugin"
            }
          ]
        },
        {
          "mode": "deep",
          "status": "error",
          "skipReason": "exec-error",
          "coverage": {
            "manifest": false,
            "skills": true
          },
          "verdict": null,
          "findings": []
        }
      ]
    }
  ]
}
```

The contradiction is explicit: static manifest verification ran and passed,
deep skill verification errored, yet both the tool and report verdicts are
`pass`. Static coverage says `skills: false`, so it cannot establish successful
skill loading.

This exact network failure is environment-dependent. With working network
access, the old implementation may reach its expected `401 Unauthorized`
response. That does not remove the verifier's dependency on a model-request
failure as its loading signal.

## Captured subprocess result

An execution wrapper around `defaultScanEnv().exec` captured the actual child
result without changing the verifier's arguments, temporary configuration,
result, or cleanup. The fourth child invocation was the deep probe:

```text
/opt/homebrew/bin/codex exec -C <staged-project> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "ok"
```

`<staged-project>` replaces only the random temporary directory. The adapter
supplied a fresh temporary `CODEX_HOME` to this child process. The command above
is a captured invocation, not a proposed verification recipe.

```json
{
  "binary": "/opt/homebrew/bin/codex",
  "elapsedMs": 30520,
  "code": 1,
  "timedOut": false,
  "stdout": ""
}
```

Selected stderr lines, with timestamps and repeated retry lines omitted:

```text
Reading additional input from stdin...
OpenAI Codex v0.145.0
user
ok
failed to connect to websocket: IO error: failed to lookup address information: nodename nor servname provided, or not known, url: wss://api.openai.com/v1/responses
ERROR: Reconnecting... 5/5
warning: Falling back from WebSockets to HTTPS transport. stream disconnected before completion: failed to lookup address information: nodename nor servname provided, or not known
ERROR: stream disconnected before completion: error sending request for url (https://api.openai.com/v1/responses)
```

The child took **30,520 milliseconds**, exited **1**, and did **not** hit the
verifier timeout. It never printed `401 Unauthorized`. A skill-description
budget warning also appeared; it was not the terminal failure.

## Why Skillsmith produces this result

Source line numbers below refer to the inspected snapshot. Links resolve to the
repository files so readers can inspect the surrounding implementation.

| Location | Behavior and consequence |
| --- | --- |
| [Codex deep adapter](../packages/core/src/agents/codex/verify.ts), lines 303–318 | Starts `exec` with the prompt `ok`, causing a model-request attempt. |
| Same file, lines 338–340 | Accepts exit 0, parsed skill findings, or literal `401 Unauthorized` as loading evidence. DNS failure satisfies none, so it returns `exec-error`. |
| Same file, lines 271–279 | `deepErrorResult` returns empty findings and drops the child stderr and exit code. |
| [Tool aggregation](../packages/core/src/verify/normalize.ts), lines 27–30 | Filters to `status === 'ran'`; the static pass hides the deep error. |
| Same file, lines 39–65 | The overall summary also ignores inconclusive tools when another tool passes. |
| [CLI exit handling](../packages/cli/src/commands/verify.ts), lines 33–44 | Separately detects missing requested deep coverage and returns 4. |
| Same file, lines 61–64 | Help describes deep mode as `isolated; no auth, no model call`, which the invocation does not satisfy. |

A direct call to the existing aggregation and exit functions using the captured
report returned:

```json
{
  "actual": {
    "modes": [
      {
        "mode": "static",
        "status": "ran",
        "verdict": "pass"
      },
      {
        "mode": "deep",
        "status": "error",
        "verdict": null
      }
    ],
    "toolVerdict": "pass",
    "summary": "pass",
    "exitCode": 4
  },
  "hypotheticalToolOnlyFix": {
    "description": "If only the per-tool verdict is fixed, another passing tool still hides the missing Codex deep result",
    "summary": "pass"
  }
}
```

The `hypotheticalToolOnlyFix` case is a synthetic control: it changes the Codex
tool verdict to `inconclusive` and adds a passing Claude tool before calling the
current summarizer. It proves that correcting only the per-tool verdict would
leave the whole-report defect in place.

## Alternative protocol: observed controls

The [Codex app-server `skills/list` interface](https://developers.openai.com/codex/app-server/#skills)
returns discovered skills and structured loading errors for requested working
directories. `forceReload: true` requests a fresh disk scan.

The diagnostic prototype intercepted only the adapter's deep subprocess call.
It reused the original executable selection, skill staging, and isolated child
configuration, then started:

```text
/opt/homebrew/bin/codex app-server --listen stdio://
```

It sent these protocol messages in sequence, waiting for initialization before
requesting the list. `<staged-project>` denotes the canonical path to the same
staged project used by the original adapter:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"skillsmith_diagnostic","version":"0.0.0"},"capabilities":{"experimentalApi":true}}}
{"method":"initialized"}
{"id":2,"method":"skills/list","params":{"cwds":["<staged-project>"],"forceReload":true}}
```

No `thread/start` or `turn/start` request was sent. The prototype enforced a
20-second protocol deadline and terminated the subprocess afterward. The
adapter's existing cleanup blocks still removed its temporary directories.

| Control | Result | Elapsed time |
| --- | --- | --- |
| Live Agent Fork skill | Expected staged skill returned enabled; no loading errors or missing targets | 625 milliseconds |
| Existing `dummytest` fixture | One valid skill loaded; all three deliberately invalid skills reported | 2,848 milliseconds |

Both ran with Codex **0.145.0** under the **same network restrictions**, without
additional network permission. Results below preserve the observed values;
random staged paths are reduced to their skill directory names, and unrelated
skill metadata is omitted:

```json
[
  {
    "control": "valid",
    "binary": "/opt/homebrew/bin/codex",
    "elapsed_ms": 625,
    "methods": [
      "initialize",
      "initialized",
      "skills/list"
    ],
    "loaded": [
      {
        "name": "agent-fork",
        "enabled": true
      }
    ],
    "errors": [],
    "missing": [],
    "other_skill_count": 68
  },
  {
    "control": "broken",
    "binary": "/opt/homebrew/bin/codex",
    "elapsed_ms": 2848,
    "methods": [
      "initialize",
      "initialized",
      "skills/list"
    ],
    "loaded": [
      {
        "name": "good-skill",
        "enabled": true
      }
    ],
    "errors": [
      {
        "skill": "bad-nodesc",
        "message": "missing field `description`"
      },
      {
        "skill": "bad-noframe",
        "message": "missing YAML frontmatter delimited by ---"
      },
      {
        "skill": "bad-yaml",
        "message": "invalid YAML: found unexpected end of stream at line 3 column 16, while scanning a quoted scalar at line 2 column 14"
      }
    ],
    "missing": [
      "bad-nodesc",
      "bad-noframe",
      "bad-yaml"
    ],
    "other_skill_count": 68
  }
]
```

The invalid fixture covers missing `description`, missing YAML frontmatter,
and malformed YAML. Its source is
[`packages/core/tests/fixtures/verify/dummytest`](../packages/core/tests/fixtures/verify/dummytest).
The three entries in `missing` are those same invalid skills, not three
additional failures.

The loader also returned **68 unrelated skills**. The probe matched exact
canonical staged paths, so those skills could not establish success for the
target. A temporary Codex configuration directory alone did not make the
returned discovery inventory exclusive to the fixture.

These are protocol-level positive and inverse controls. They establish that
this Codex loader interface can distinguish the tested valid and invalid skills
without a model turn. They are not a passing report from a patched Skillsmith
adapter, an implementation of report aggregation, or proof across every Codex
version. The prototype stopped before the old stderr parser could interpret the
different protocol.

## Existing test gaps

- [Codex deep adapter tests](../packages/core/tests/agents/codex/verify-deep.test.ts)
  use canned `401 Unauthorized` output and lock in the existing `exec` command.
  They do not reproduce the healthy-skill DNS failure observed here.
- [Aggregation tests](../packages/core/tests/verify/normalize.test.ts) omit the
  mixed static-pass/deep-error case.
- [CLI verification tests](../packages/cli/tests/commands/verify.test.ts) cover
  exit 4 for missing deep coverage, without establishing that the normalized
  summary agrees with that exit status.
- [Live CLI tests](../packages/core/tests/verify/live-e2e.test.ts) require
  `SKILLSMITH_E2E=1`; ordinary CI does not exercise this real subprocess path.

## Possible follow-up work — not implemented

1. Replace the deep `exec` and 401 inference with a bounded app-server
   `skills/list` exchange. Require every expected staged skill to be returned
   enabled, or report its structured error. Map paths back to the original
   target and handle missing targets explicitly.
2. Preserve bounded execution and protocol diagnostics, including the selected
   executable/version, failed phase, exit code, timeout, and sanitized stderr.
   Distinguish infrastructure failures from invalid-skill findings. Handle
   unsupported methods, malformed responses, early exit, and cancellation.
3. Correct both aggregation levels so missing required deep coverage is
   `inconclusive` with exit 4. A demonstrated artifact failure retains `fail`
   and exit 1. Preserve the distinction between optional absent tools and
   explicitly requested absent tools.
4. Add regression coverage for positive and invalid controls, exact target
   matching, disabled or missing targets, protocol failures, and mixed-mode and
   mixed-tool reporting. Assert that no model turn is started. Update help and
   documentation alongside any eventual implementation.

## Reproducing the execution trace from source

Save the following as `trace-skillsmith.ts` in a scratch directory. Supply the
absolute paths to the Skillsmith checkout, the Agent Fork skill directory, and
an output directory as its three arguments. Install the Skillsmith checkout's
locked dependencies first. The script records subprocess results without
changing their arguments or returning synthetic results:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repoArg, targetArg, outputArg] = Bun.argv.slice(2);
if (!repoArg || !targetArg || !outputArg) {
  throw new Error('Usage: bun trace-skillsmith.ts <skillsmith-root> <skill-dir> <output-dir>');
}
const repo = resolve(repoArg);
const target = resolve(targetArg);
const output = resolve(outputArg);
const { defaultScanEnv } = await import(
  pathToFileURL(join(repo, 'packages/core/src/env/default.ts')).href
);
const { verifyPlugin } = await import(
  pathToFileURL(join(repo, 'packages/core/src/verify/run.ts')).href
);
await mkdir(output, { recursive: true });
const scan = await defaultScanEnv();
const execute = scan.exec;
let call = 0;
scan.exec = async (binary, args, options) => {
  const started = Date.now();
  const result = await execute(binary, args, options);
  const trace = {
    binary, args,
    isolatedConfigDirectory: options?.env?.CODEX_HOME,
    elapsedMs: Date.now() - started,
    ...result,
  };
  await writeFile(join(output, `exec-${++call}.json`), JSON.stringify(trace, null, 2) + '\n');
  return result;
};
const result = await verifyPlugin(scan, {
  path: target, tools: ['codex'], deep: true, strict: true,
});
await writeFile(join(output, 'source-report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
```

The following example uses paths under the current user's home directory;
adjust them to the actual checkout and scratch locations:

```sh
bun "$HOME/diagnostics/trace-skillsmith.ts" \
  "$HOME/c/skillsmith" \
  "$HOME/c/agent-fork/.agents/skills/agent-fork" \
  "$HOME/diagnostics/skillsmith-codex-output"
```

This is the original trace wrapper with its machine-specific paths replaced by
arguments. Re-running it reproduces the old model-request attempt; the failure
wording depends on the network environment. Its source-library result is
separate from the installed CLI's exit status recorded above. All evidence
needed to assess this diagnosis is included in this document; temporary files
from the original session are not required.
