#!/usr/bin/env bash
# Sekali saat codespace/container dibuat: Chromium (screenshot preview) + snugcode dari paket terbaru.
# SNUGCODE_PACKAGE bisa diganti (mis. fork sendiri) untuk menguji perubahan daemon.
set -u
if ! command -v chromium >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends chromium >/dev/null \
    || echo "! Chromium gagal dipasang: screenshot preview tidak tersedia"
fi
npm i -g "${SNUGCODE_PACKAGE:-github:arfakaisar/snugcode}" --include=optional --no-audit --no-fund --loglevel=error
