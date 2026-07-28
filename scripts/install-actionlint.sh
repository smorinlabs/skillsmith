#!/usr/bin/env bash
set -euo pipefail

# Exact release-tool installer for supported macOS/Linux x64/arm64 runners.

ACTIONLINT_VERSION="1.7.12"

if command -v actionlint >/dev/null 2>&1; then
    actual_version="$(actionlint -version 2>/dev/null | head -n 1 || true)"
    if [ "$actual_version" != "$ACTIONLINT_VERSION" ]; then
        echo "actionlint $ACTIONLINT_VERSION is required; found ${actual_version:-unknown}" >&2
        exit 1
    fi
    echo "actionlint $ACTIONLINT_VERSION is already installed"
    exit 0
fi

case "$(uname -s)" in
    Darwin) tool_os=darwin ;;
    Linux) tool_os=linux ;;
    *)
        echo "Unsupported OS: $(uname -s)" >&2
        echo "Install actionlint manually: https://github.com/rhysd/actionlint/releases" >&2
        exit 1
        ;;
esac

case "$(uname -m)" in
    x86_64|amd64) tool_arch=amd64; platform_arch=x64 ;;
    arm64|aarch64) tool_arch=arm64; platform_arch=arm64 ;;
    *)
        echo "Unsupported arch: $(uname -m)" >&2
        echo "Install actionlint manually: https://github.com/rhysd/actionlint/releases" >&2
        exit 1
        ;;
esac

case "${tool_os}-${platform_arch}" in
    darwin-x64) expected_sha256=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644 ;;
    darwin-arm64) expected_sha256=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
    linux-x64) expected_sha256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
    linux-arm64) expected_sha256=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;;
    *) echo "Unsupported actionlint platform" >&2; exit 1 ;;
esac

tool_tmp="$(mktemp -d)"
trap 'rm -rf "$tool_tmp"' EXIT
archive="$tool_tmp/actionlint.tar.gz"
url="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_${tool_os}_${tool_arch}.tar.gz"
echo "Downloading actionlint ${ACTIONLINT_VERSION} (${tool_os}/${platform_arch})..."
curl --fail --show-error --silent --location "$url" --output "$archive"

if command -v sha256sum >/dev/null 2>&1; then
    actual_sha256="$(sha256sum "$archive" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
    actual_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
else
    echo "sha256sum or shasum is required" >&2
    exit 1
fi
if [ "$actual_sha256" != "$expected_sha256" ]; then
    echo "actionlint archive SHA-256 mismatch" >&2
    exit 1
fi

tar -xzf "$archive" -C "$tool_tmp"
test -f "$tool_tmp/actionlint"

dest="${SKILLSMITH_TOOL_BIN_DIR:-${HOME}/.local/bin}"
mkdir -p "$dest"
install -m 0755 "$tool_tmp/actionlint" "$dest/actionlint"
installed_version="$($dest/actionlint -version 2>/dev/null | head -n 1 || true)"
if [ "$installed_version" != "$ACTIONLINT_VERSION" ]; then
    echo "installed actionlint version mismatch: ${installed_version:-unknown}" >&2
    exit 1
fi
echo "Installed actionlint to $dest/actionlint"

case ":$PATH:" in
    *":$dest:"*) ;;
    *) echo "NOTE: add $dest to your PATH" ;;
esac
