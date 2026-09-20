#!/bin/sh
# SKILLSMITH-FAILCLOSED-HOOK v1 — installed by scripts/install-hooks.sh as
# pre-push, pre-commit, and commit-msg. Resolves the lefthook binary and
# delegates; fails loudly when it cannot. Behavior matches the generated
# lefthook shim on the retained node resolution paths, except a missing
# binary is a loud error instead of a silent skip.
set -u

hook_name="$(basename "$0")"

if [ "${LEFTHOOK_VERBOSE:-}" = "1" ] || [ "${LEFTHOOK_VERBOSE:-}" = "true" ]; then
  set -x
fi

if [ "${LEFTHOOK:-}" = "0" ]; then
  echo "WARNING: skillsmith hooks bypassed via LEFTHOOK=0" >&2
  exit 0
fi

_repo_top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
_resolver=""
if [ -n "$_repo_top" ] && [ -f "$_repo_top/scripts/hooks/resolve-lefthook.sh" ]; then
  _resolver="$_repo_top/scripts/hooks/resolve-lefthook.sh"
fi
if [ -z "$_resolver" ]; then
  echo "error: skillsmith $hook_name hook cannot run: hook support files missing." >&2
  echo "fix: run 'bun install' (full install), then verify with:" >&2
  echo "  just verify-hooks   (or ./scripts/verify-hooks.sh without just)" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$_resolver"

if _lefthook_bin="$(resolve_lefthook)"; then
  exec "$_lefthook_bin" run "$hook_name" "$@"
fi

echo "error: skillsmith $hook_name hook cannot run: lefthook binary not found." >&2
echo "checked: \$LEFTHOOK_BIN override, PATH, and this checkout's node_modules." >&2
echo "fix: run 'bun install' (full install; lefthook is a devDependency), then verify with:" >&2
echo "  just verify-hooks   (or ./scripts/verify-hooks.sh without just)" >&2
exit 1
