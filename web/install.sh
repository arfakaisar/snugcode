#!/bin/sh
# snugcode installer for macOS & Linux:  curl -fsSL https://snugcode.dev/install.sh | sh
# Checks Node.js 22+ & git, installs snugcode from the official GitHub repo (latest release tag),
# then runs `snugcode setup`. Another relay: SNUGCODE_RELAY=https://your-relay.example sh install.sh
set -e
say() { printf '%s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git isn't installed. macOS: xcode-select --install · Debian/Ubuntu: sudo apt install git"
if ! command -v node >/dev/null 2>&1; then
  die "Node.js isn't installed. Install Node.js 22+ from https://nodejs.org (or: brew install node · nvm install 22), then run this command again."
fi
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || die "Node.js $(node -v) is too old; snugcode needs 22+. Upgrade (e.g. nvm install 22) and try again."

# Global npm into a root-owned folder needs sudo; point it at ~/.npm-global instead.
prefix=$(npm config get prefix)
if [ ! -w "$prefix/lib" ] 2>/dev/null && [ ! -w "$prefix" ]; then
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
  say "ℹ Global npm moved to ~/.npm-global (no sudo). Add it to PATH in your shell profile:"
  say "    export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
fi

# Always from the official GitHub repo: the latest release tag (or main before the first release). The npm registry is
# deliberately NOT asked "is there a package called snugcode?": anyone can register an unclaimed name, and this script
# would then install their code. SNUGCODE_PACKAGE overrides the source (e.g. a fork or a pinned tag).
spec="${SNUGCODE_PACKAGE:-github:arfakaisar/snugcode#semver:*}"
say "→ Installing snugcode ($spec)…"
npm i -g "$spec" --no-audit --no-fund --loglevel=error || { [ -z "$SNUGCODE_PACKAGE" ] && npm i -g github:arfakaisar/snugcode --no-audit --no-fund --loglevel=error; } || die "Install failed (see the npm messages above)."

say "✓ snugcode installed. Running setup…"
# Run from `curl | sh`: stdin is a pipe, so setup prompts read from the terminal.
if [ -n "$SNUGCODE_RELAY" ]; then snugcode setup --relay "$SNUGCODE_RELAY" </dev/tty
else snugcode setup </dev/tty; fi
