# muse agent

Detection, skill roots, activation, collision precedence, and install-hint
for Meta's Muse CLI (`muse` binary).

- Binary name: `muse` (version probes set `MUSE_NO_AUTO_UPDATE=1` so the
  launcher's hourly self-update check never runs during detection)
- User skill roots (native + compat): `$XDG_CONFIG_HOME/muse/skills/`,
  `~/.agents/skills/`
- Project skill roots: `<repo>/.agents/skills/`
- Precedence: project > user-native > user-compat; a disabled winner does
  not fall back to lower-priority duplicates
- Activation: `$XDG_CONFIG_HOME/muse/settings.json`
  (`skills.activation.<scope>[skillPath]` is `"on"` or `"off"`, keyed by
  document path with `$CONFIG_DIR`/`$HOME` prefixes); unrecorded skills
  default on
- No standalone command roots or installed-plugin discovery in this build
  (plugin commands require an authenticated session)
- Placement (user scope only): the native `$XDG_CONFIG_HOME/muse/skills/`
  root; the `~/.agents/skills` compat root stays inventory-visible and is
  never a placement target
- Verification: `muse skills validate <dir> --json` per skill directory
  (static), `muse skills list --source user|project --json` loader matching
  (deep); every invocation runs offline (`MUSE_NO_AUTO_UPDATE=1` plus an
  isolated HOME/XDG layout)

Muse paths were probed against Muse 1.3.0-R3401.1 on 2026-09-19; the verified behavior is
recorded in this directory (`skill-roots.ts`, `enablement.ts`, `index.ts`,
`placement.ts`, `verify.ts`).
