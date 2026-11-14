#!/bin/sh
# line-probe.sh — the wall probe. It runs INSIDE the wall (through in-sandbox.sh) before every attempt and
# prints one line per arm: what was tried, what happened, and whether that is what the wall should do.
# Both directions: the allowed things must work, the forbidden things must fail. One failed arm stops the
# run before any model call.
# Usage (inside the worktree):
#   line-probe.sh <bridge-port> <proxy-port> <scratch-run-dir> <records-dir> <work-dir> <real-home>
#                 <secrets-dir|-> <other-loopback-port> <registry: online|offline|closed>
# <other-loopback-port> is a port the build machine really listens on, outside the wall, for this probe.
# An arm whose target does not exist on this machine is reported as SKIP with the reason, never as PASS.
BRIDGE=$1; PROXY=$2; OUT=$3; RECORDS=$4; WORK=$5; REALHOME=$6; SECRETS=$7; OTHER=$8; REGISTRY=${9:-online}
NET="$(dirname "$0")/probe-net.mjs"; pass=0; fail=0; skip=0
arm() { # name, expect (ok|refused), actual exit code, detail
  v=FAIL
  if [ "$2" = ok ]; then if [ "$3" -eq 0 ]; then v=PASS; fi; fi
  if [ "$2" = refused ]; then if [ "$3" -ne 0 ]; then v=PASS; fi; fi
  if [ "$v" = PASS ]; then pass=$((pass+1)); else fail=$((fail+1)); fi
  printf '%s  %-44s expect %-7s exit %-3s %s\n' "$v" "$1" "$2" "$3" "$4"
}
try() {
  name=$1; expect=$2; shift 2; out=$("$@" 2>&1); rc=$?
  arm "$name" "$expect" "$rc" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-110)"
}
skipped() { skip=$((skip+1)); printf 'SKIP  %-44s %s\n' "$1" "$2"; }

try 'write inside the worktree'             ok      sh -c 'mkdir -p .oc/tmp && echo probe > .oc/tmp/probe-inside'
try 'write a sibling of the worktree'       refused sh -c "echo x > '$OUT/probe-outside'"
try 'write /tmp'                            refused sh -c 'echo x > /tmp/line-probe-outside'
try 'write the user home directory'         refused sh -c "echo x > '$REALHOME/line-probe-outside'"
try 'write the repository behind the tree'  refused sh -c "echo x > '$OUT/repo/.git/probe-outside'"
try 'repoint the worktree link (.git)'      refused sh -c 'echo x >> .git'
try 'write the run records'                 refused sh -c "echo x > '$RECORDS/probe-outside'"
try 'write the run artefacts'               refused sh -c "echo x > '$WORK/probe-outside'"
if [ "$SECRETS" = - ]; then skipped 'read the secrets directory' 'no secrets directory on this machine'
else try 'read the secrets directory'       refused ls "$SECRETS"; fi
if [ -e "$REALHOME/.ssh" ]; then try 'read ~/.ssh' refused ls "$REALHOME/.ssh"
else skipped 'read ~/.ssh' 'no ~/.ssh visible from inside the wall'; fi
try 'bridge port (loopback)'                ok      node "$NET" http "$BRIDGE"
if [ "$REGISTRY" = online ]; then try 'registry.npmjs.org through the tunnel' ok node "$NET" tunnel "$PROXY" registry.npmjs.org:443
elif [ "$REGISTRY" = closed ]; then try 'registry.npmjs.org through the tunnel (shut: the brief asks for no network)' refused node "$NET" tunnel "$PROXY" registry.npmjs.org:443
else skipped 'registry.npmjs.org through the tunnel' 'the build machine itself is offline'; fi
try 'example.com through the tunnel'        refused node "$NET" tunnel "$PROXY" example.com:443
try 'github.com through the tunnel'         refused node "$NET" tunnel "$PROXY" github.com:443
try 'api.vercel.com through the tunnel'     refused node "$NET" tunnel "$PROXY" api.vercel.com:443
try 'example.com direct, no proxy'          refused node "$NET" tcp example.com 443
try 'a public address direct, no DNS needed' refused node "$NET" tcp 1.1.1.1 443
try 'another loopback port'                 refused node "$NET" tcp 127.0.0.1 "$OTHER"
try 'node fetch example.com'                refused node "$NET" fetch https://example.com/
echo "sandbox probe: $pass passed, $fail failed, $skip skipped"
[ "$fail" -eq 0 ]
