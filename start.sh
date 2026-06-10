#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os" in
  darwin) node_os="darwin" ;;
  linux) node_os="linux" ;;
  *) echo "[ERROR] Unsupported OS for portable Node bootstrap: $os" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) node_arch="arm64" ;;
  x86_64|amd64) node_arch="x64" ;;
  *) echo "[ERROR] Unsupported CPU architecture for portable Node bootstrap: $arch" >&2; exit 1 ;;
esac

NODE_VERSION="22.16.0"
NODE_DIR="$PROJECT_ROOT/bin/node-$node_os-$node_arch"
NODE_BIN="$NODE_DIR/bin/node"

echo "==================================================="
echo "  Odysseus Portable Launcher"
echo "==================================================="

download_file() {
  local url="$1"
  local dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -L --fail --output "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$dest" "$url"
  else
    echo "[ERROR] Need curl or wget to bootstrap portable Node.js." >&2
    exit 1
  fi
}

if [ ! -x "$NODE_BIN" ]; then
  echo "[Bootstrap] Portable Node.js not found. Downloading Node.js $NODE_VERSION ($node_os-$node_arch)..."
  tmp="$PROJECT_ROOT/data/bootstrap/node"
  archive="$tmp/node-v$NODE_VERSION-$node_os-$node_arch.tar.xz"
  url="https://nodejs.org/dist/v$NODE_VERSION/$(basename "$archive")"
  rm -rf "$tmp"
  mkdir -p "$tmp" "$NODE_DIR"
  download_file "$url" "$archive"
  # FAT32/exFAT drives do not support symbolic links. We ignore extraction warnings and verify the actual binary.
  tar -xJf "$archive" --strip-components=1 -C "$NODE_DIR" || true
  if [ ! -x "$NODE_BIN" ]; then
    echo "[ERROR] Failed to extract Node.js binary to $NODE_BIN" >&2
    exit 1
  fi
  if [ "$os" = "darwin" ]; then
    xattr -r -d com.apple.quarantine "$NODE_DIR" 2>/dev/null || true
  fi
  chmod +x "$NODE_BIN"
  rm -rf "$tmp"
fi

echo "Starting orchestrator..."
set +e
"$NODE_BIN" src/start.js "$@"
exit_code=$?
set -e

if [ $exit_code -ne 0 ]; then
  echo
  echo "==================================================="
  echo "  [ERROR] Orchestrator exited with code $exit_code"
  echo "  Please check the logs above or in the 'logs/' folder."
  echo "==================================================="
  exit $exit_code
fi
