#!/usr/bin/env bash
# Once, when the codespace/container is created: Chromium (preview screenshots) + snugcode from the latest package.
# SNUGCODE_PACKAGE can be changed (e.g. your own fork) to test daemon changes.
set -u
. "$(dirname "$0")/lib.sh"
if ! command -v chromium >/dev/null 2>&1; then
  report installing "Installing Chromium for preview screenshots…" chromium
  { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends chromium; } >> "$SNUGCODE_HOME/install.log" 2>&1 \
    || log "! Chromium install failed: preview screenshots unavailable (see install.log)"
fi
# OS sandbox for agent commands under auto-approve (see daemon/sandbox.js).
if ! command -v bwrap >/dev/null 2>&1 || ! command -v socat >/dev/null 2>&1; then
  { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends bubblewrap socat; } >> "$SNUGCODE_HOME/install.log" 2>&1 \
    || log "! bubblewrap/socat install failed: auto-approved commands run without an OS sandbox"
fi
report installing "Installing snugcode (once, ~1–3 min)…" install
if ! npm i -g "${SNUGCODE_PACKAGE:-github:arfakaisar/snugcode}" --include=optional --no-audit --no-fund --loglevel=error >> "$SNUGCODE_HOME/install.log" 2>&1; then
  report error "npm failed to install snugcode: $(tail -n 4 "$SNUGCODE_HOME/install.log" | tr '\n' ' ')"
  exit 0 # start.sh retries / uses the code from this repo
fi
log "snugcode installed: $(find_snug || echo '?')"
