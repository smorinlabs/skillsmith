#!/usr/bin/env bash
set -euo pipefail

# Exact release-tool installer for supported macOS/Linux x64/arm64 runners.

GITLEAKS_VERSION="8.30.1"

if command -v gitleaks >/dev/null 2>&1; then
    actual_version="$(gitleaks version 2>/dev/null || true)"
    if [ "$actual_version" != "$GITLEAKS_VERSION" ]; then
        echo "gitleaks $GITLEAKS_VERSION is required; found ${actual_version:-unknown}" >&2
        exit 1
    fi
    echo "gitleaks $GITLEAKS_VERSION is already installed"
    exit 0
fi

case "$(uname -s)" in
    Darwin) tool_os=darwin ;;
    Linux) tool_os=linux ;;
    *)
        echo "Unsupported OS: $(uname -s)" >&2
        echo "Install gitleaks manually: https://github.com/gitleaks/gitleaks/releases" >&2
        exit 1
        ;;
esac

case "$(uname -m)" in
    x86_64|amd64) tool_arch=x64 ;;
    arm64|aarch64) tool_arch=arm64 ;;
    *)
        echo "Unsupported arch: $(uname -m)" >&2
        echo "Install gitleaks manually: https://github.com/gitleaks/gitleaks/releases" >&2
        exit 1
        ;;
esac

case "${tool_os}-${tool_arch}" in
    darwin-x64) expected_sha256=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
    darwin-arm64) expected_sha256=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
    linux-x64) expected_sha256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
    linux-arm64) expected_sha256=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
    *) echo "Unsupported gitleaks platform" >&2; exit 1 ;;
esac

tool_tmp="$(mktemp -d)"
trap 'rm -rf "$tool_tmp"' EXIT
archive="$tool_tmp/gitleaks.tar.gz"
url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${tool_os}_${tool_arch}.tar.gz"
echo "Downloading gitleaks ${GITLEAKS_VERSION} (${tool_os}/${tool_arch})..."
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
    echo "gitleaks archive SHA-256 mismatch" >&2
    exit 1
fi

tar -xzf "$archive" -C "$tool_tmp"
test -f "$tool_tmp/gitleaks"

dest="${SKILLSMITH_TOOL_BIN_DIR:-${HOME}/.local/bin}"
mkdir -p "$dest"
install -m 0755 "$tool_tmp/gitleaks" "$dest/gitleaks"
installed_version="$("$dest/gitleaks" version 2>/dev/null || true)"
if [ "$installed_version" != "$GITLEAKS_VERSION" ]; then
    echo "installed gitleaks version mismatch: ${installed_version:-unknown}" >&2
    exit 1
fi
echo "Installed gitleaks to $dest/gitleaks"

case ":$PATH:" in
    *":$dest:"*) ;;
    *) echo "NOTE: add $dest to your PATH" ;;
esac
