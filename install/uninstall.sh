#!/usr/bin/env bash
#
# Removes the sandbox from macOS or Linux.
#
#   ./install/uninstall.sh                 remove the app, keep data/ and .env
#   ./install/uninstall.sh --purge         remove everything, including data
#   ./install/uninstall.sh --dir ~/sandbox
#
set -euo pipefail

case "$(uname -s)" in
  Darwin) DEFAULT_DIR="$HOME/Applications/SapBahSandbox" ;;
  Linux)  DEFAULT_DIR="$HOME/.local/share/sap-bah-sandbox" ;;
  *) echo "Unsupported operating system." >&2; exit 1 ;;
esac

TARGET="$DEFAULT_DIR"
PURGE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)   TARGET="$2"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ -d "$TARGET" ]] || { echo "Nothing installed at $TARGET"; exit 0; }

# --purge deletes the whole folder, so make sure it really is a sandbox install.
if [[ $PURGE -eq 1 && ! -e "$TARGET/sapbah" && ! -d "$TARGET/app" && ! -d "$TARGET/runtime" && ! -f "$TARGET/.env" ]]; then
  echo "$TARGET does not look like a SAP BAH Sandbox install — not deleting it." >&2
  exit 1
fi

if [[ -x "$TARGET/sapbah" ]]; then
  "$TARGET/sapbah" service uninstall 2>/dev/null || true
  "$TARGET/sapbah" stop 2>/dev/null || true
fi

# Belt and braces in case the control script was already deleted.
if [[ "$(uname -s)" == "Darwin" ]]; then
  plist="$HOME/Library/LaunchAgents/info.bais.sapbah-sandbox.plist"
  launchctl unload "$plist" 2>/dev/null || true
  rm -f "$plist"
else
  systemctl --user disable --now sapbah-sandbox.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/sapbah-sandbox.service"
  systemctl --user daemon-reload 2>/dev/null || true
fi

if [[ $PURGE -eq 1 ]]; then
  rm -rf "$TARGET"
  echo "Removed $TARGET (including data)."
else
  rm -rf "$TARGET/app" "$TARGET/runtime" "$TARGET/cache" "$TARGET/sapbah" "$TARGET/README.md" "$TARGET/LICENSE"
  echo "Removed the app and runtime."
  echo "Kept your database and settings in $TARGET"
  echo "  data/  .env       (delete them yourself, or re-run with --purge)"
fi
