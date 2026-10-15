#!/usr/bin/env bash
# Dipakai install.sh & start.sh: lokasi data, log, dan laporan tahap ke relay (tampil di aplikasi HP
# selama runner belum tersambung, jadi kegagalan di codespace terlihat tanpa membuka terminal).
export SNUGCODE_HOME="${SNUGCODE_HOME:-/workspaces/.snugcode}"
# /workspaces bisa milik root: buat foldernya dengan sudo; bila tetap tidak bisa ditulis, pakai ~/.snugcode.
if ! { mkdir -p "$SNUGCODE_HOME" 2>/dev/null && [ -w "$SNUGCODE_HOME" ]; }; then
  sudo mkdir -p "$SNUGCODE_HOME" 2>/dev/null && sudo chown "$(id -u):$(id -g)" "$SNUGCODE_HOME" 2>/dev/null
  if [ ! -w "$SNUGCODE_HOME" ]; then export SNUGCODE_HOME="$HOME/.snugcode"; mkdir -p "$SNUGCODE_HOME"; fi
fi
LOG="$SNUGCODE_HOME/cloud.log"
RELAY="${SNUGCODE_RELAY:-https://snugcode.arfak.workers.dev}"
log() { echo "[$(date -u +%H:%M:%S)] $*" >> "$LOG"; echo "$*"; }
# report <tahap> <pesan>: tahap = installing | starting | error
report() {
  log "$1: $2"
  [ -n "${SNUGCODE_MACHINE_TOKEN:-}" ] || return 0
  local body
  body=$(STAGE="$1" MSG="$2" node -e 'process.stdout.write(JSON.stringify({ stage: process.env.STAGE, msg: process.env.MSG.slice(-400) }))' 2>/dev/null) || return 0
  curl -s -m 10 -X POST -H "authorization: Bearer $SNUGCODE_MACHINE_TOKEN" -H 'content-type: application/json' --data "$body" "$RELAY/api/runner/status" >/dev/null 2>&1 || true
}
# Path snugcode: PATH, folder global npm image devcontainer, atau prefix npm saat ini.
find_snug() {
  command -v snugcode 2>/dev/null && return 0
  local d
  for d in /usr/local/share/npm-global/bin "$(npm prefix -g 2>/dev/null)/bin" "$HOME/.npm-global/bin"; do
    [ -x "$d/snugcode" ] && echo "$d/snugcode" && return 0
  done
  return 1
}
