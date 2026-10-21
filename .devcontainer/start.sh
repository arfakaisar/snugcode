#!/usr/bin/env bash
# Every time the codespace starts: run the runner in the background (detached from the postStartCommand process).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"
# Cap the log at ~5 MB: keep only its tail.
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 5000000 ]; then tail -c 1000000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
if [ -z "${SNUGCODE_MACHINE_TOKEN:-}" ] && [ ! -f "$SNUGCODE_HOME/secrets.json" ]; then
  log "snugcode: SNUGCODE_MACHINE_TOKEN is missing from the codespace environment (the Codespaces secret isn't set for this repo). Recreate the runner from the snugcode app on your phone."
  exit 0
fi
report starting "Starting snugcode…" start
SNUG="$(find_snug)" || { bash "$DIR/install.sh"; SNUG="$(find_snug)"; } || SNUG=""
CMD=()
if [ -n "$SNUG" ]; then
  CMD=("$SNUG" cloud)
else
  # The global package couldn't be installed: run from this repo's code (the codespace is created from the snugcode repo).
  ROOT="$(cd "$DIR/.." && pwd)"
  report installing "Global package failed; using the code from the repo ($ROOT)…" install
  if (cd "$ROOT" && npm ci --omit=dev --include=optional --no-audit --no-fund --loglevel=error >> "$SNUGCODE_HOME/install.log" 2>&1); then
    CMD=(node "$ROOT/daemon/cli.js" cloud)
  else
    report error "Couldn't install snugcode: $(tail -n 4 "$SNUGCODE_HOME/install.log" | tr '\n' ' ')"
    exit 0
  fi
fi
log "running: ${CMD[*]}"
nohup setsid "${CMD[@]}" >> "$LOG" 2>&1 < /dev/null &
PID=$!
# A daemon that dies right away (bad config, crash): report the last lines of its log.
sleep 8
if ! kill -0 "$PID" 2>/dev/null && ! pgrep -f "cli.js (cloud|start)" >/dev/null; then
  report error "snugcode stopped during start: $(tail -n 3 "$LOG" | tr '\n' ' ')"
  exit 0
fi
echo "snugcode runner is running in the background. Log: $LOG"
