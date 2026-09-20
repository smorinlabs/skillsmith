# Shared lefthook binary resolution for the fail-closed hook wrapper and the
# hook verifier. Source this file, then call resolve_lefthook.
#
# Prints the resolved binary path on stdout; returns nonzero with no output
# when unresolvable. The caller owns the loud error. Resolution order mirrors
# the generated lefthook shim's node paths: explicit LEFTHOOK_BIN override
# first, then PATH, then this checkout's node_modules platform layouts. The
# shim's go/bundle/yarn/pnpm/swift/mint/uv/mise/devbox runner fallbacks are
# deliberately not retained (bun/node repo; several can download, which
# conflicts with the wrapper's no-download constraint).
resolve_lefthook() {
  if [ -n "${LEFTHOOK_BIN:-}" ]; then
    if "$LEFTHOOK_BIN" -h >/dev/null 2>&1; then
      printf '%s\n' "$LEFTHOOK_BIN"
      return 0
    fi
    return 1
  fi
  if command -v lefthook >/dev/null 2>&1; then
    command -v lefthook
    return 0
  fi
  _rl_top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$_rl_top" ]; then
    _rl_os="$(uname | tr '[:upper:]' '[:lower:]')"
    case "$(uname -m)" in
      x86_64 | amd64) _rl_arch=x64 ;;
      arm64 | aarch64) _rl_arch=arm64 ;;
      *) _rl_arch='' ;;
    esac
    if [ -n "$_rl_arch" ]; then
      for _rl_candidate in \
        "$_rl_top/node_modules/lefthook-${_rl_os}-${_rl_arch}/bin/lefthook" \
        "$_rl_top/node_modules/@evilmartians/lefthook/bin/lefthook-${_rl_os}-${_rl_arch}/lefthook" \
        "$_rl_top/node_modules/@evilmartians/lefthook-installer/bin/lefthook" \
        "$_rl_top/node_modules/lefthook/bin/index.js"; do
        if [ -f "$_rl_candidate" ]; then
          printf '%s\n' "$_rl_candidate"
          unset _rl_top _rl_os _rl_arch _rl_candidate
          return 0
        fi
      done
    fi
  fi
  unset _rl_top _rl_os _rl_arch _rl_candidate
  return 1
}
