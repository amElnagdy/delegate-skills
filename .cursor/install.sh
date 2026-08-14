#!/usr/bin/env bash
#
# Cloud Agent install for delegate-skills.
#
# This package is Node built-ins only — no package.json, no dependencies, so
# there is nothing to `npm install`. The one thing that matters is the Node
# version the project gates run under: CI pins `actions/setup-node@v7` with
# `node-version: 22` (the latest 22.x), and two timeout/abort smoke checks are
# sensitive to a signal-delivery fix that landed in a later 22.x patch. Older
# 22.x (e.g. 22.14) drops a SIGTERM delivered during the relays' synchronous
# `--version` preflight and mis-reports "timeout" instead of "aborted".
#
# The Cloud Agent VM injects its own `node` early on PATH, ahead of nvm, so a
# bare `node` can resolve to that older build. The only PATH entry ahead of the
# injected one is /usr/local/cargo/bin, so we install the pinned Node with nvm
# and expose it there. The script is idempotent: re-running it re-points the
# same symlinks at whatever `nvm install 22` resolves to.
set -euo pipefail

NODE_MAJOR=22
SHIM_DIR="/usr/local/cargo/bin"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "install: nvm not found at $NVM_DIR; cannot provision Node ${NODE_MAJOR}" >&2
  exit 1
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

nvm install "$NODE_MAJOR"
nvm alias default "$NODE_MAJOR" >/dev/null

NODE_BIN_DIR="$(dirname "$(nvm which "$NODE_MAJOR")")"

if [ ! -d "$SHIM_DIR" ] || [ ! -w "$SHIM_DIR" ]; then
  echo "install: $SHIM_DIR is missing or not writable; cannot install Node shims" >&2
  exit 1
fi

for bin in node npm npx corepack; do
  if [ ! -x "$NODE_BIN_DIR/$bin" ]; then
    echo "install: required executable $NODE_BIN_DIR/$bin is missing or not executable" >&2
    exit 1
  fi
  if [ -e "$SHIM_DIR/$bin" ] && [ ! -L "$SHIM_DIR/$bin" ]; then
    echo "install: refusing to overwrite non-symlink $SHIM_DIR/$bin" >&2
    exit 1
  fi
done

for bin in node npm npx corepack; do
  ln -sfn "$NODE_BIN_DIR/$bin" "$SHIM_DIR/$bin"
  if [ ! -L "$SHIM_DIR/$bin" ] || [ "$(readlink "$SHIM_DIR/$bin")" != "$NODE_BIN_DIR/$bin" ]; then
    echo "install: failed to link $SHIM_DIR/$bin to $NODE_BIN_DIR/$bin" >&2
    exit 1
  fi
done

SHIM_NODE_VERSION="$("$SHIM_DIR/node" --version)"
echo "install: node $SHIM_NODE_VERSION resolved from $SHIM_DIR/node"
printf '%s\n' "$SHIM_NODE_VERSION" | grep -q "^v${NODE_MAJOR}\." || {
  echo "install: expected Node ${NODE_MAJOR}.x at $SHIM_DIR/node but found $SHIM_NODE_VERSION" >&2
  exit 1
}
