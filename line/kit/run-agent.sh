#!/bin/sh
# run-agent.sh — one unattended OpenCode run behind the wall. The agent gets: the worktree, the bridge's
# port, a per-run secret the bridge accepts, and the ticket text. Its only model provider is the bridge
# (OpenAI-compatible, on loopback); it never sees the real key or anything outside its worktree.
# Usage: run-agent.sh <worktree> <bridge-port> <proxy-port> <secret-file> <prompt-file> <out-dir> [timeout-seconds]
# Needs: LINE_TOOLS, LINE_MODEL. Optional: LINE_NODE, LINE_MODEL_CONTEXT, LINE_MODEL_OUTPUT, LINE_SOCK_DIR, LINE_SANDBOX.
set -eu
KIT=$(cd "$(dirname "$0")" && pwd -P)
WT=$1; BP=$2; PP=$3; SECRET_FILE=$4; PROMPT_FILE=$5; OUT=$6; LIMIT=${7:-1500}
MODEL=${LINE_MODEL:?LINE_MODEL (the model id) is required}
NODE=${LINE_NODE:-$(command -v node)}
mkdir -p "$OUT"
OPENCODE_CONFIG_CONTENT=$("$NODE" -e '
const [secretFile, port, model, context, output] = process.argv.slice(1);
const secret = require("node:fs").readFileSync(secretFile, "utf8").trim();
process.stdout.write(JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  model: "line/" + model, small_model: "line/" + model,
  autoupdate: false, share: "disabled", snapshot: false,
  enabled_providers: ["line"],
  provider: { line: { npm: "@ai-sdk/openai-compatible", name: "the bridge",
    options: { baseURL: "http://127.0.0.1:" + port + "/v1", apiKey: secret },
    models: { [model]: { name: "build", limit: { context: Number(context), output: Number(output) } } } } },
  permission: { edit: "allow", bash: "allow", webfetch: "deny", websearch: "deny", external_directory: "deny" },
}));' "$SECRET_FILE" "$BP" "$MODEL" "${LINE_MODEL_CONTEXT:-128000}" "${LINE_MODEL_OUTPUT:-16000}")
export OPENCODE_CONFIG_CONTENT
START=$(date +%s)
set +e
# The time limit: an alarm ends the agent with SIGALRM (exit 142). stdin is closed because `opencode run`
# reads a piped stdin to its end before it starts.
/usr/bin/perl -e 'alarm shift; exec @ARGV' "$LIMIT" "$KIT/in-sandbox.sh" "$WT" "$BP" "$PP" \
  opencode run --model "line/$MODEL" --format json --auto --title "build ticket" "$(cat "$PROMPT_FILE")" \
  < /dev/null > "$OUT/opencode-events.jsonl" 2> "$OUT/opencode-stderr.txt"
RC=$?
set -e
END=$(date +%s)
printf '{"exit": %s, "seconds": %s, "timeout_seconds": %s, "model": "%s"}\n' \
  "$RC" "$((END-START))" "$LIMIT" "$MODEL" > "$OUT/agent-exit.json"
cat "$OUT/agent-exit.json"
