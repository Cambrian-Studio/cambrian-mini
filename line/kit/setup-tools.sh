#!/bin/sh
# setup-tools.sh — install the agent runtime (OpenCode) into the line's tools directory.
# Usage: setup-tools.sh [tools-dir]      (default: <repository>/.line/tools, or $CAMBRIAN_LINE_HOME/tools)
# The tools directory is read-only inside the sandbox; nothing else is installed anywhere.
set -eu
KIT=$(cd "$(dirname "$0")" && pwd -P)
HOME_DIR=${CAMBRIAN_LINE_HOME:-"$KIT/../../.line"}
TOOLS=${1:-"$HOME_DIR/tools"}
mkdir -p "$TOOLS"
cd "$TOOLS"
[ -f package.json ] || printf '{ "name": "line-tools", "private": true }\n' > package.json
npm install --no-audit --no-fund --save-exact "opencode-ai@${OPENCODE_VERSION:-latest}"
"$TOOLS/node_modules/.bin/opencode" --version
echo "setup-tools: the agent runtime is at $TOOLS/node_modules/.bin/opencode"
