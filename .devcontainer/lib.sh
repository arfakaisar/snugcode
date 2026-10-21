#!/usr/bin/env bash
# Used by install.sh & start.sh: data location, log, and stage reports to the relay (shown in the phone app
# while the runner is not connected yet, so codespace failures are visible without opening a terminal).
export SNUGCODE_HOME="${SNUGCODE_HOME:-/workspaces/.snugcode}"
# /workspaces may be owned by root: create the folder with sudo; if still not writable, use ~/.snugcode.
if ! { mkdir -p "$SNUGCODE_HOME" 2>/dev/null && [ -w "$SNUGCODE_HOME" ]; }; then
  sudo mkdir -p "$SNUGCODE_HOME" 2>/dev/null && sudo chown "$(id -u):$(id -g)" "$SNUGCODE_HOME" 2>/dev/null
  if [ ! -w "$SNUGCODE_HOME" ]; then export SNUGCODE_HOME="$HOME/.snugcode"; mkdir -p "$SNUGCODE_HOME"; fi
fi
LOG="$SNUGCODE_HOME/cloud.log"
RELAY="${SNUGCODE_RELAY:-https://snugcode.dev}"
log() { echo "[$(date -u +%H:%M:%S)] $*" >> "$LOG"; echo "$*"; }
# report <stage> <message> [step]: stage = installing | starting | error; step (for the progress bar
# on the phone) = chromium | install | start
report() {
  log "$1: $2"
  [ -n "${SNUGCODE_MACHINE_TOKEN:-}" ] || return 0
  local body
  body=$(STAGE="$1" MSG="$2" STEP="${3:-}" node -e 'process.stdout.write(JSON.stringify({ stage: process.env.STAGE, msg: process.env.MSG.slice(-400), step: process.env.STEP }))' 2>/dev/null) || return 0
  curl -s -m 10 -X POST -H "authorization: Bearer $SNUGCODE_MACHINE_TOKEN" -H 'content-type: application/json' --data "$body" "$RELAY/api/runner/status" >/dev/null 2>&1 || true
}
# snugcode path: PATH, the devcontainer image's global npm folder, or the current npm prefix.
find_snug() {
  command -v snugcode 2>/dev/null && return 0
  local d
  for d in /usr/local/share/npm-global/bin "$(npm prefix -g 2>/dev/null)/bin" "$HOME/.npm-global/bin"; do
    [ -x "$d/snugcode" ] && echo "$d/snugcode" && return 0
  done
  return 1
}
