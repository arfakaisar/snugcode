#!/usr/bin/env bash
# Setiap codespace menyala: jalankan runner di latar belakang (lepas dari proses postStartCommand).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"
# Log dibatasi ±5 MB: sisakan bagian akhirnya saja.
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 5000000 ]; then tail -c 1000000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
if [ -z "${SNUGCODE_MACHINE_TOKEN:-}" ] && [ ! -f "$SNUGCODE_HOME/secrets.json" ]; then
  log "snugcode: SNUGCODE_MACHINE_TOKEN tidak ada di environment codespace (Codespaces secret belum terpasang untuk repo ini). Buat ulang runner dari aplikasi snugcode di HP."
  exit 0
fi
report starting "Menyalakan snugcode…" start
SNUG="$(find_snug)" || { bash "$DIR/install.sh"; SNUG="$(find_snug)"; } || SNUG=""
CMD=()
if [ -n "$SNUG" ]; then
  CMD=("$SNUG" cloud)
else
  # Paket global tidak bisa dipasang: jalankan dari kode repo ini (codespace dibuat dari repo snugcode).
  ROOT="$(cd "$DIR/.." && pwd)"
  report installing "Paket global gagal; memakai kode dari repo ($ROOT)…" install
  if (cd "$ROOT" && npm ci --omit=dev --include=optional --no-audit --no-fund --loglevel=error >> "$SNUGCODE_HOME/install.log" 2>&1); then
    CMD=(node "$ROOT/daemon/cli.js" cloud)
  else
    report error "Tidak bisa memasang snugcode: $(tail -n 4 "$SNUGCODE_HOME/install.log" | tr '\n' ' ')"
    exit 0
  fi
fi
log "menjalankan: ${CMD[*]}"
nohup setsid "${CMD[@]}" >> "$LOG" 2>&1 < /dev/null &
PID=$!
# Daemon yang langsung mati (konfigurasi salah, crash): laporkan baris terakhir log-nya.
sleep 8
if ! kill -0 "$PID" 2>/dev/null && ! pgrep -f "cli.js (cloud|start)" >/dev/null; then
  report error "snugcode berhenti saat start: $(tail -n 3 "$LOG" | tr '\n' ' ')"
  exit 0
fi
echo "snugcode runner berjalan di latar belakang. Log: $LOG"
