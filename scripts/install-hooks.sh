#!/usr/bin/env bash
# Install the fail-closed lefthook wrapper hooks into the effective git hooks
# directory. Idempotent: rerunning replaces same-content hooks atomically.
set -euo pipefail

MARKER='SKILLSMITH-FAILCLOSED-HOOK v1'
HOOKS=(pre-push pre-commit commit-msg)

if ! command -v git >/dev/null 2>&1; then
  echo 'error: install-hooks requires git on PATH.' >&2
  exit 1
fi
if ! repo_top="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo 'SKIP: install-hooks: not inside a git checkout; nothing to wire.'
  exit 0
fi
# Absolute common dir; fall back for git predating --path-format (2.38),
# resolving relative output from the repo top where it is anchored.
common_dir="$(git -C "$repo_top" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
  || common_dir="$(git -C "$repo_top" rev-parse --git-common-dir 2>/dev/null)" \
  || { echo 'error: install-hooks: git refused to resolve the repository directory.' >&2; exit 1; }
case "$common_dir" in
  /*) hooks_dir="$common_dir/hooks" ;;
  *) hooks_dir="$repo_top/$common_dir/hooks" ;;
esac
configured="$(git config core.hooksPath || true)"
if [ -n "$configured" ] && [ "$configured" != "$hooks_dir" ]; then
  echo "error: install-hooks: core.hooksPath is set to '$configured'; only the default hooks dir is managed." >&2
  echo "fix: 'git config --unset core.hooksPath' (or point it at '$hooks_dir'), then rerun install-hooks." >&2
  exit 1
fi

template="$repo_top/scripts/hooks/hook-wrapper.sh"
if [ ! -f "$template" ]; then
  echo "error: install-hooks: wrapper template missing at $template." >&2
  exit 1
fi
if ! mkdir -p "$hooks_dir" 2>/dev/null || [ ! -w "$hooks_dir" ]; then
  echo "error: install-hooks: hooks dir '$hooks_dir' is not writable." >&2
  exit 1
fi

for hook in "${HOOKS[@]}"; do
  target="$hooks_dir/$hook"
  if [ -e "$target" ] && ! grep -qF "$MARKER" "$target" 2>/dev/null; then
    cp "$target" "$target.pre-failclosed-bak"
    echo "install-hooks: backed up pre-existing $hook to $target.pre-failclosed-bak"
  fi
  tmp="$(mktemp "$hooks_dir/.$hook.XXXXXX")"
  cp "$template" "$tmp"
  chmod 755 "$tmp"
  mv "$tmp" "$target"
  echo "install-hooks: installed $hook"
done

exec "$repo_top/scripts/verify-hooks.sh"
