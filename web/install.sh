#!/bin/sh
# Pemasang snugcode untuk macOS & Linux:  curl -fsSL https://snugcode.dev/install.sh | sh
# Memeriksa Node.js 22+ & git, memasang snugcode (npm bila sudah terbit, selain itu rilis GitHub terbaru),
# lalu menjalankan `snugcode setup`. Relay lain: SNUGCODE_RELAY=https://relay-mu.example sh install.sh
set -e
say() { printf '%s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git belum terpasang. macOS: xcode-select --install · Debian/Ubuntu: sudo apt install git"
if ! command -v node >/dev/null 2>&1; then
  die "Node.js belum terpasang. Pasang Node.js 22+ dari https://nodejs.org (atau: brew install node · nvm install 22), lalu jalankan perintah ini lagi."
fi
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || die "Node.js $(node -v) terlalu lama; snugcode butuh 22+. Perbarui (mis. nvm install 22) lalu ulangi."

# npm global ke folder milik root butuh sudo; arahkan ke ~/.npm-global agar tidak perlu.
prefix=$(npm config get prefix)
if [ ! -w "$prefix/lib" ] 2>/dev/null && [ ! -w "$prefix" ]; then
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
  say "ℹ npm global dipindah ke ~/.npm-global (tanpa sudo). Tambahkan ke PATH di profil shell-mu:"
  say "    export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
fi

if npm view snugcode version >/dev/null 2>&1; then spec=snugcode
else spec="github:arfakaisar/snugcode#semver:*"; fi
say "→ Memasang snugcode ($spec)…"
npm i -g "$spec" --no-audit --no-fund --loglevel=error || npm i -g github:arfakaisar/snugcode --no-audit --no-fund --loglevel=error

say "✓ snugcode terpasang. Menjalankan setup…"
# Dijalankan dari `curl | sh`: stdin adalah pipa, jadi pertanyaan setup dibaca dari terminal.
if [ -n "$SNUGCODE_RELAY" ]; then snugcode setup --relay "$SNUGCODE_RELAY" </dev/tty
else snugcode setup </dev/tty; fi
