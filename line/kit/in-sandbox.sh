#!/bin/sh
# in-sandbox.sh — run one command behind the wall, with a scrubbed environment.
# Usage: in-sandbox.sh <worktree> <bridge-port> <proxy-port> <command> [args…]
# Needs: LINE_TOOLS (the tools directory). Optional: LINE_NODE (the node to use), LINE_SOCK_DIR (the bridge's
# unix sockets, for a wall with its own network namespace), LINE_SANDBOX (force a wall, or 'none').
#
# The wall itself is chosen and built by kit/sandbox.mjs (sandbox-exec on macOS, bubblewrap or a container
# with no network on Linux). With no wall available nothing is run: the exit code is 3.
# HOME, TMPDIR and every XDG directory are inside the worktree's .oc/ (never committed), so nothing has a
# reason to write elsewhere. TMPPREFIX too: zsh writes a here-document's temporary file there, not to TMPDIR.
set -eu
KIT=$(cd "$(dirname "$0")" && pwd -P)
WT=$(cd "$1" && pwd -P); BRIDGE_PORT=$2; PROXY_PORT=$3; shift 3
TOOLS=$(cd "${LINE_TOOLS:?LINE_TOOLS (the tools directory) is required}" && pwd -P)
NODE=${LINE_NODE:-$(command -v node)}
NODE_DIR=$(dirname "$NODE")
# the repository behind a linked worktree (read-only inside); a plain clone has its .git inside the worktree already
GITDIR=$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$WT/.git")
GITDIR=$(cd "$GITDIR" && pwd -P)
mkdir -p "$WT/.oc/tmp" "$WT/.oc/home"
cd "$WT"
P="http://127.0.0.1:$PROXY_PORT"
exec /usr/bin/env -i \
  PATH="$TOOLS/node_modules/.bin:$NODE_DIR:${PATH:-/usr/bin:/bin}" \
  HOME="$WT/.oc/home" TMPDIR="$WT/.oc/tmp" TMPPREFIX="$WT/.oc/tmp/zsh" \
  XDG_CONFIG_HOME="$WT/.oc/home/.config" XDG_DATA_HOME="$WT/.oc/home/.local/share" \
  XDG_CACHE_HOME="$WT/.oc/home/.cache" XDG_STATE_HOME="$WT/.oc/home/.local/state" \
  npm_config_cache="$WT/.oc/npm-cache" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
  HTTPS_PROXY="$P" HTTP_PROXY="$P" https_proxy="$P" http_proxy="$P" NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  GIT_CONFIG_NOSYSTEM=1 GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 \
  OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_LSP_DOWNLOAD=1 OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
  ${OPENCODE_CONFIG_CONTENT:+OPENCODE_CONFIG_CONTENT="$OPENCODE_CONFIG_CONTENT"} \
  LINE_WALL_TOOLS="$TOOLS" LINE_WALL_GITDIR="$GITDIR" \
  ${LINE_SOCK_DIR:+LINE_WALL_SOCK_DIR="$LINE_SOCK_DIR"} ${LINE_SANDBOX:+LINE_SANDBOX="$LINE_SANDBOX"} \
  "$NODE" "$KIT/sandbox.mjs" run "$WT" "$BRIDGE_PORT" "$PROXY_PORT" -- "$@"
