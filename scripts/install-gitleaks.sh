#!/usr/bin/env bash
set -euo pipefail

# Exact release-tool installer for supported macOS/Linux x64/arm64 runners.

GITLEAKS_VERSION="8.21.2"

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
    darwin-x64) expected_sha256=5b42c6e4b1fd693eaeb2b5b7faa5f17a1434299d4deb2de63d4b2efd7c753128 ;;
    darwin-arm64) expected_sha256=cad3de5dc9a4d5447d967a70a4d49499c557f04db028274cc324f9ff983f6502 ;;
    linux-x64) expected_sha256=5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba ;;
    linux-arm64) expected_sha256=654c935542c89f565aabe7bf7c6c500830f116c114f0aeb509d2460c1ac2e6da ;;
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
installed_version="$($dest/gitleaks version 2>/dev/null || true)"
if [ "$installed_version" != "$GITLEAKS_VERSION" ]; then
    echo "installed gitleaks version mismatch: ${installed_version:-unknown}" >&2
    exit 1
fi
echo "Installed gitleaks to $dest/gitleaks"

case ":$PATH:" in
    *":$dest:"*) ;;
    *) echo "NOTE: add $dest to your PATH" ;;
esac
