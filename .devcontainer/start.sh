#!/usr/bin/env bash
# Setiap codespace menyala: jalankan runner di latar belakang (lepas dari proses postStartCommand).
set -u
export SNUGCODE_HOME="${SNUGCODE_HOME:-/workspaces/.snugcode}"
mkdir -p "$SNUGCODE_HOME"
command -v snugcode >/dev/null 2>&1 || bash "$(dirname "$0")/install.sh"
LOG="$SNUGCODE_HOME/cloud.log"
# Log dibatasi ±5 MB: sisakan bagian akhirnya saja.
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 5000000 ]; then tail -c 1000000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
if [ -z "${SNUGCODE_MACHINE_TOKEN:-}" ] && [ ! -f "$SNUGCODE_HOME/secrets.json" ]; then
  echo "snugcode: SNUGCODE_MACHINE_TOKEN belum ada. Buat runner dari aplikasi snugcode di HP (Pakai cloud)." | tee -a "$LOG"
  exit 0
fi
nohup setsid snugcode cloud >> "$LOG" 2>&1 < /dev/null &
echo "snugcode runner berjalan di latar belakang. Log: $LOG"
