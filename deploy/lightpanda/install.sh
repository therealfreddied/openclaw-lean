#!/usr/bin/env bash
set -euo pipefail

# Sideloads Lightpanda (ultra-lightweight CDP browser for low-RAM hosts)
ARCH=$(uname -m)
DEST_DIR="${1:-.bin}"
mkdir -p "$DEST_DIR"

if [ "$ARCH" = "x86_64" ]; then
  URL="https://github.com/lightpanda-io/browser/releases/download/0.4.1/lightpanda-x86_64-linux"
elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
  URL="https://github.com/lightpanda-io/browser/releases/download/0.4.1/lightpanda-aarch64-linux"
else
  echo "Unsupported architecture: $ARCH" >&2
  exit 1
fi

echo "Downloading Lightpanda for $ARCH to $DEST_DIR/lightpanda..."
curl -fsSL "$URL" -o "$DEST_DIR/lightpanda"
chmod +x "$DEST_DIR/lightpanda"
echo "Lightpanda ready."
