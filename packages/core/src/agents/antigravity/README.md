# antigravity agent

Detection, skill roots, collision precedence, placement, verification, and
install-hint for Google's Antigravity CLI (`agy` binary).

- Binary name: `agy` (native binary, commonly installed at `~/.local/bin/agy`)
- User skill roots (native + compat): `~/.gemini/config/skills/`,
  `~/.agents/skills/`
- Project skill roots (CWD): `<cwd>/.agents/skills/`, `<cwd>/.agent/skills/`,
  `<cwd>/_agents/skills/`, `<cwd>/_agent/skills/` (walk-up, `skills.json`, and
  plugin bundles under `~/.gemini/config/plugins/` / `.agents/plugins/` are
  deferred to v2)
- Precedence: project (`.agents` > `.agent` > `_agents` > `_agent`) >
  user-native (`~/.gemini/config/skills`) > user-compat (`~/.agents/skills`)
- Placement (user + custom scopes): native `~/.gemini/config/skills/` root;
  `~/.agents/skills/` stays inventory-visible only; project-scope mutations are
  deferred under issue #99 (shared `<project>/.agents/skills` destination with
  Codex)
- Verification: `agy plugin validate [--strict] --json <dir>` (static;
  ephemerally wraps bare skills and non-Antigravity plugin `skills/` trees with
  `.antigravity-plugin/plugin.json`), `agy acp --disable-telemetry` over stdio
  JSON-RPC (`initialize` → `authenticate(gemini-api-key)` → `session/new` →
  `available_commands_update`, presence-only deep check); every invocation runs
  offline with an isolated `HOME`/`XDG_*` layout and scrubbed Google auth env
  vars

Antigravity behavior was probed against `agy 1.5.16` on 2026-11-24; verified
behavior is recorded in this directory (`skill-roots.ts`, `index.ts`,
`placement.ts`, `verify.ts`).
