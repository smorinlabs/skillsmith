# codex agent

Detection, install-paths, frontmatter, and install-hint for OpenAI's Codex CLI.

- Binary name: `codex`
- User skill root (current): `~/.agents/skills/`
- User skill root (deprecated, still read): `$CODEX_HOME/skills/`
- Relocation env var: `CODEX_HOME` (deprecated root only)

See `research/skillsmith-skill-install-paths.md` for full details.

## Verification

Static mode checks the plugin manifest. Deep mode starts an isolated local app-server,
waits for initialization, and requests `skills/list` with a fresh scan. It never starts a
model turn. Only exact canonical staged target paths establish loading; unrelated discovered
skills cannot satisfy a target. Unsupported protocols, disabled/missing targets and incomplete
execution are inconclusive, while structured invalid-skill findings remain failures.

The exchange retains the existing timeout, caps stdout at 1 MiB and stderr at 16 KiB, and cleans
up its subprocess and temporary directories. User-facing execution diagnostics are sanitized
and capped at 2,048 characters. No authentication-failure response is used as loading evidence.
See the [official protocol](https://learn.chatgpt.com/docs/app-server#skills) and
[P19 evidence](../../../../../projects/p19/EVIDENCE.md) for tested versions and controls.
