#!/usr/bin/env bash
# Verify installed git hooks, the lefthook binary, and the lefthook config.
# Exit 0 only when a commit or push would actually execute the fail-closed
# wrapper. First gap fails loudly with its fix command.
set -euo pipefail

MARKER='SKILLSMITH-FAILCLOSED-HOOK v1'
HOOKS=(pre-push pre-commit commit-msg)

fail() {
  echo "error: verify-hooks: $1" >&2
  echo "fix: $2" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail 'git is not on PATH.' "install git, then rerun verify-hooks."
repo_top="$(git rev-parse --show-toplevel 2>/dev/null)" \
  || fail 'not inside a git checkout.' 'run verify-hooks inside the repository.'
common_dir="$(git rev-parse --git-common-dir 2>/dev/null)" \
  || fail 'git refused to resolve the repository directory.' 'check git access to this checkout.'
case "$common_dir" in
  /*) hooks_dir="$common_dir/hooks" ;;
  *) hooks_dir="$repo_top/$common_dir/hooks" ;;
esac
configured="$(git config core.hooksPath || true)"
[ -z "$configured" ] || [ "$configured" = "$hooks_dir" ] \
  || fail "core.hooksPath is set to '$configured'; managed hooks would not execute." \
    "'git config --unset core.hooksPath' (or point it at '$hooks_dir'), then rerun install-hooks."

template="$repo_top/scripts/hooks/hook-wrapper.sh"
[ -f "$template" ] || fail "wrapper template missing at $template." "'bun install' from a current checkout, then rerun install-hooks."
resolver="$repo_top/scripts/hooks/resolve-lefthook.sh"
[ -f "$resolver" ] || fail "resolver snippet missing at $resolver." "'bun install' from a current checkout, then rerun install-hooks."

if command -v sha256sum >/dev/null 2>&1; then
  checksum='sha256sum'
elif command -v shasum >/dev/null 2>&1; then
  checksum='shasum -a 256'
else
  fail 'neither sha256sum nor shasum is available.' 'install core checksum tooling, then rerun verify-hooks.'
fi
expected="$($checksum "$template" | awk '{print $1}')"
for hook in "${HOOKS[@]}"; do
  target="$hooks_dir/$hook"
  [ -f "$target" ] || fail "hook '$hook' is missing from $hooks_dir." "'just install-hooks' (or ./scripts/install-hooks.sh)."
  [ -x "$target" ] || fail "hook '$hook' is not executable; git would skip it." "'just install-hooks' (or ./scripts/install-hooks.sh)."
  grep -qF "$MARKER" "$target" 2>/dev/null \
    || fail "hook '$hook' is not the fail-closed wrapper (marker absent; an older install may have clobbered it)." "'just install-hooks' (or ./scripts/install-hooks.sh)."
  actual="$($checksum "$target" | awk '{print $1}')"
  [ "$actual" = "$expected" ] \
    || fail "hook '$hook' content does not match the committed wrapper template." "'just install-hooks' (or ./scripts/install-hooks.sh)."
done

# shellcheck disable=SC1090
. "$resolver"
lefthook_bin="$(resolve_lefthook 2>/dev/null)" \
  || fail 'lefthook binary not found (checked $LEFTHOOK_BIN, PATH, node_modules).' "'bun install' (full install; lefthook is a devDependency), then rerun verify-hooks."
pinned="$(bun -e 'console.log(require("./package.json").devDependencies.lefthook)' 2>/dev/null || true)"
installed_version="$("$lefthook_bin" version 2>/dev/null || true)"
if [ -n "$pinned" ] && [ -n "$installed_version" ] && [ "$installed_version" != "$pinned" ]; then
  echo "warning: verify-hooks: lefthook $installed_version resolves, but package.json pins $pinned." >&2
fi

[ -f "$repo_top/lefthook.yml" ] || fail 'lefthook.yml is missing from the checkout.' "'bun install' from a current checkout."
"$lefthook_bin" dump >/dev/null 2>&1 \
  || fail 'lefthook.yml does not parse.' 'fix lefthook.yml, then rerun verify-hooks.'

echo "verify-hooks: OK (3 fail-closed hooks; lefthook resolves; lefthook.yml parses)."
