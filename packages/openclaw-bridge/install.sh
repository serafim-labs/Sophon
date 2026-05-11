#!/usr/bin/env sh
# Sophon Bridge — one-shot installer for macOS.
#
# Source:  https://github.com/serafim-labs/sophon
# Served:  https://sophon.at/install
#
# Usage:
#   sh -c "$(curl -fsSL https://sophon.at/install)"
#
# What it does:
#   1. Verifies macOS + Node 20+ are present
#   2. Runs `npm install -g @sophonai/bridge@latest`
#   3. Hands off to `bridge service install` — which drives pairing
#      (browser opens, claim on iPhone) and registers the LaunchAgent
#      so the bridge runs under launchd. After this the terminal can
#      close and the bridge keeps running across logout / reboot.
#
# Read before piping into sh:
#   curl -fsSL https://sophon.at/install
#
# Override the package source (rarely needed — for testing):
#   SOPHON_BRIDGE_PKG=@sophonai/bridge@0.13.0 sh -c "$(curl ...)"

set -eu

# ─── pretty ──────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  CYAN="$(printf '\033[36m')"
  RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; RESET=""
fi

say()   { printf '%s\n' "$*"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
arrow() { printf '%s→%s %s\n' "$CYAN" "$RESET" "$*"; }
die()   { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

PKG="${SOPHON_BRIDGE_PKG:-@sophonai/bridge@latest}"

say ""
say "${BOLD}Sophon Bridge installer${RESET}"
say "${DIM}https://sophon.at — connect local agents to your iPhone${RESET}"
say ""

# ─── 1. platform ─────────────────────────────────────────────────────

OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
  Darwin) ok "macOS detected" ;;
  Linux)  die "Linux installer lands later. For now: install Node 20+, then \`npm i -g $PKG && bridge service install\` (service will say macOS-only — track issue for systemd --user)." ;;
  *)      die "Unsupported OS: $OS. macOS only for now." ;;
esac

# ─── 2. Node ─────────────────────────────────────────────────────────

if ! command -v node >/dev/null 2>&1; then
  say ""
  say "${RED}✗${RESET} ${BOLD}Node.js is not on PATH.${RESET}"
  say ""
  say "  Install Node 20+ first, then re-run this script:"
  say "    ${BOLD}brew install node${RESET}            ${DIM}# Homebrew${RESET}"
  say "    ${DIM}or via nvm: https://github.com/nvm-sh/nvm${RESET}"
  exit 1
fi

NODE_VERSION="$(node --version 2>/dev/null || echo unknown)"
# Strip leading "v" and take the major component.
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed -E 's/^v([0-9]+).*/\1/')"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "could not parse Node version: $NODE_VERSION" ;;
esac
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node 20+ required (detected: $NODE_VERSION). Upgrade with: brew upgrade node"
fi
ok "Node $NODE_VERSION"

if ! command -v npm >/dev/null 2>&1; then
  die "npm is not on PATH (unusual for a Node install). Reinstall Node."
fi
ok "npm $(npm --version)"

# ─── 3. global install ───────────────────────────────────────────────

say ""
arrow "${BOLD}npm install -g $PKG${RESET}"
say ""
if ! npm install -g "$PKG"; then
  say ""
  warn "npm install failed."
  say "  ${DIM}Common causes:${RESET}"
  say "  ${DIM}  • EACCES (permission denied): your global prefix needs write access.${RESET}"
  say "  ${DIM}    fix: \`npm config set prefix ~/.npm-global\` + add ~/.npm-global/bin to PATH${RESET}"
  say "  ${DIM}    or use nvm (https://github.com/nvm-sh/nvm) which avoids sudo entirely${RESET}"
  say "  ${DIM}  • offline / firewall: retry on a connected network${RESET}"
  exit 1
fi

# Re-hash so the just-installed `bridge` is found without opening a new shell.
hash -r 2>/dev/null || true

if ! command -v bridge >/dev/null 2>&1; then
  say ""
  warn "bridge installed but not on PATH yet."
  say "  ${DIM}npm global prefix: $(npm prefix -g 2>/dev/null || echo unknown)${RESET}"
  say "  ${DIM}Add \$(npm prefix -g)/bin to your shell's PATH and re-run:${RESET}"
  say "    ${BOLD}bridge service install${RESET}"
  exit 1
fi
ok "bridge $(bridge --version 2>/dev/null || echo installed)"

# ─── 4. service install (drives pairing + LaunchAgent) ───────────────

say ""
arrow "${BOLD}bridge service install${RESET}"
say "${DIM}  • opens a browser for pairing — claim \"Pair this computer\" on your iPhone${RESET}"
say "${DIM}  • writes ~/Library/LaunchAgents/at.sophon.bridge.plist${RESET}"
say "${DIM}  • launchctl bootstrap + kickstart — KeepAlive=true${RESET}"
say ""

# exec hands control to `bridge`; its stdin/stdout/stderr is our user's
# terminal, so prompts and the browser-flow output land where the user
# is looking. When it exits, our script is gone — no double "done".
exec bridge service install
