# kilo-code agent

Detection, install-paths, frontmatter, and install-hint for Kilo Code (new `@kilocode/cli` platform).

- Binary name: `kilo`
- User skill root: `~/.kilo/skills/`
- Project skill root: `<project>/.kilo/skills/`
- Legacy VS Code extension uses `~/.kilocode/skills/`; not detectable via binary in MVP-1.
- No documented relocation env var; symlinks are the documented workaround.

See `research/skillsmith-skill-install-paths.md` for full details.
