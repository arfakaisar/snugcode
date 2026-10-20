#!/usr/bin/env bash
# Sekali saat codespace/container dibuat: Chromium (screenshot preview) + snugcode dari paket terbaru.
# SNUGCODE_PACKAGE bisa diganti (mis. fork sendiri) untuk menguji perubahan daemon.
set -u
. "$(dirname "$0")/lib.sh"
if ! command -v chromium >/dev/null 2>&1; then
  report installing "Memasang Chromium untuk screenshot preview…" chromium
  { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends chromium; } >> "$SNUGCODE_HOME/install.log" 2>&1 \
    || log "! Chromium gagal dipasang: screenshot preview tidak tersedia (lihat install.log)"
fi
# Sandbox OS untuk perintah agen saat auto-izin (lihat daemon/sandbox.js).
if ! command -v bwrap >/dev/null 2>&1 || ! command -v socat >/dev/null 2>&1; then
  { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends bubblewrap socat; } >> "$SNUGCODE_HOME/install.log" 2>&1 \
    || log "! bubblewrap/socat gagal dipasang: perintah auto-izin berjalan tanpa sandbox OS"
fi
report installing "Memasang snugcode (sekali, ±1–3 menit)…" install
if ! npm i -g "${SNUGCODE_PACKAGE:-github:arfakaisar/snugcode}" --include=optional --no-audit --no-fund --loglevel=error >> "$SNUGCODE_HOME/install.log" 2>&1; then
  report error "npm gagal memasang snugcode: $(tail -n 4 "$SNUGCODE_HOME/install.log" | tr '\n' ' ')"
  exit 0 # start.sh mencoba lagi / memakai kode dari repo ini
fi
log "snugcode terpasang: $(find_snug || echo '?')"
