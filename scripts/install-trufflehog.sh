#!/usr/bin/env bash
set -euo pipefail

# Exact release-tool installer for supported macOS/Linux x64/arm64 runners.

TRUFFLEHOG_VERSION="3.97.5"

if command -v trufflehog >/dev/null 2>&1; then
    actual_version="$(trufflehog --version 2>&1 | awk '{print $2}')"
    if [ "$actual_version" != "$TRUFFLEHOG_VERSION" ]; then
        echo "trufflehog $TRUFFLEHOG_VERSION is required; found ${actual_version:-unknown}" >&2
        exit 1
    fi
    echo "trufflehog $TRUFFLEHOG_VERSION is already installed"
    exit 0
fi

case "$(uname -s)" in
    Darwin) tool_os=darwin ;;
    Linux) tool_os=linux ;;
    *)
        echo "Unsupported OS: $(uname -s)" >&2
        echo "Install trufflehog manually: https://github.com/trufflesecurity/trufflehog/releases" >&2
        exit 1
        ;;
esac

case "$(uname -m)" in
    x86_64|amd64) tool_arch=amd64 ;;
    arm64|aarch64) tool_arch=arm64 ;;
    *)
        echo "Unsupported arch: $(uname -m)" >&2
        echo "Install trufflehog manually: https://github.com/trufflesecurity/trufflehog/releases" >&2
        exit 1
        ;;
esac

case "${tool_os}-${tool_arch}" in
    darwin-amd64) expected_sha256=cc8b12f8120fe47d7de929928e9183285b7a39eba60b3ac01f085f522ec19e50 ;;
    darwin-arm64) expected_sha256=b4e5fd54aaea368342b226cbea228e7a33898b177598d1d8cd66edb14f87444e ;;
    linux-amd64) expected_sha256=e3d97199c565c37ca6152750197f667e08ae6a1edf5911fbdec168622b28620c ;;
    linux-arm64) expected_sha256=e5c8b2418b0a7c78cf4c47ac783c52c63f989e4e536cfe328b5271e819b6d52d ;;
    *) echo "Unsupported trufflehog platform" >&2; exit 1 ;;
esac

tool_tmp="$(mktemp -d)"
trap 'rm -rf "$tool_tmp"' EXIT
archive="$tool_tmp/trufflehog.tar.gz"
url="https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VERSION}/trufflehog_${TRUFFLEHOG_VERSION}_${tool_os}_${tool_arch}.tar.gz"
echo "Downloading trufflehog ${TRUFFLEHOG_VERSION} (${tool_os}/${tool_arch})..."
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
    echo "trufflehog archive SHA-256 mismatch" >&2
    exit 1
fi

tar -xzf "$archive" -C "$tool_tmp"
test -f "$tool_tmp/trufflehog"

dest="${SKILLSMITH_TOOL_BIN_DIR:-${HOME}/.local/bin}"
mkdir -p "$dest"
install -m 0755 "$tool_tmp/trufflehog" "$dest/trufflehog"
installed_version="$("$dest/trufflehog" --version 2>&1 | awk '{print $2}')"
if [ "$installed_version" != "$TRUFFLEHOG_VERSION" ]; then
    echo "installed trufflehog version mismatch: ${installed_version:-unknown}" >&2
    exit 1
fi
echo "Installed trufflehog to $dest/trufflehog"

case ":$PATH:" in
    *":$dest:"*) ;;
    *) echo "NOTE: add $dest to your PATH" ;;
esac
