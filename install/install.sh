#!/usr/bin/env bash
#
# Stand-alone installer for macOS and Linux.
#
# Downloads a private Node runtime, builds the app against it, installs
# everything into one self-contained directory, and (optionally) registers
# autostart. The system Node — if there even is one — is never touched.
#
#   ./install/install.sh                     install + register autostart
#   ./install/install.sh --dir ~/sandbox     choose the location
#   ./install/install.sh --no-service        skip autostart registration
#   ./install/install.sh --offline           use a runtime already in ./.cache
#
set -euo pipefail

NODE_VERSION="v24.18.0"           # Node 24 LTS "Krypton"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# "sapbah update" points SAPBAH_CACHE into the install folder, so the runtime
# download survives from one update to the next.
CACHE="${SAPBAH_CACHE:-$SRC_DIR/.cache}"

TARGET=""
REGISTER_SERVICE=1
OFFLINE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)        TARGET="$2"; shift 2 ;;
    --no-service) REGISTER_SERVICE=0; shift ;;
    --offline)    OFFLINE=1; shift ;;
    -h|--help)    sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# --- Platform --------------------------------------------------------------

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="darwin"; DEFAULT_DIR="$HOME/Applications/SapBahSandbox" ;;
  Linux)  PLATFORM="linux";  DEFAULT_DIR="$HOME/.local/share/sap-bah-sandbox" ;;
  *) die "Unsupported operating system: $OS (this installer covers macOS and Linux; use install.ps1 on Windows)" ;;
esac

case "$ARCH" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  arm64|aarch64) NODE_ARCH="arm64" ;;
  *) die "Unsupported CPU architecture: $ARCH" ;;
esac

TARGET="${TARGET:-$DEFAULT_DIR}"
# Later steps cd around, so a relative --dir must be pinned down now.
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"
EXT="tar.gz"; [[ "$PLATFORM" == "linux" ]] && EXT="tar.xz"
NODE_PKG="node-${NODE_VERSION}-${PLATFORM}-${NODE_ARCH}"
NODE_ARCHIVE="${NODE_PKG}.${EXT}"

say "SAP BAH Sandbox — stand-alone install"
echo "  platform : $PLATFORM-$NODE_ARCH"
echo "  runtime  : Node $NODE_VERSION (bundled, not installed system-wide)"
echo "  target   : $TARGET"
echo

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || die "Required tool not found: $tool"
done

# The Linux runtime ships as .tar.xz, which tar can only unpack when xz is present.
if [[ "$PLATFORM" == "linux" ]] && ! command -v xz >/dev/null 2>&1; then
  die "xz is required to unpack the Linux runtime. Install it first:
  Debian/Ubuntu : sudo apt install -y xz-utils
  RHEL/Fedora   : sudo dnf install -y xz"
fi

# --- Download and verify the runtime ---------------------------------------

mkdir -p "$CACHE"
if [[ ! -f "$CACHE/$NODE_ARCHIVE" ]]; then
  [[ $OFFLINE -eq 1 ]] && die "Offline mode, but $CACHE/$NODE_ARCHIVE is missing."
  say "Downloading the Node runtime (~$( [[ $PLATFORM == linux ]] && echo 31 || echo 52 ) MB)…"
  curl -fL --progress-bar -o "$CACHE/$NODE_ARCHIVE" \
    "https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}" \
    || die "Download failed."
fi

if [[ $OFFLINE -eq 0 ]]; then
  say "Verifying checksum…"
  curl -fsSL -o "$CACHE/SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" \
    || die "Could not fetch SHASUMS256.txt."
  EXPECTED="$(grep " ${NODE_ARCHIVE}\$" "$CACHE/SHASUMS256.txt" | awk '{print $1}')"
  [[ -n "$EXPECTED" ]] || die "No checksum published for $NODE_ARCHIVE."
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$CACHE/$NODE_ARCHIVE" | awk '{print $1}')"
  else
    ACTUAL="$(shasum -a 256 "$CACHE/$NODE_ARCHIVE" | awk '{print $1}')"
  fi
  [[ "$ACTUAL" == "$EXPECTED" ]] || die "Checksum mismatch — refusing to install. Delete $CACHE/$NODE_ARCHIVE and retry."
  echo "  ok  ${EXPECTED:0:16}…"
fi

# --- Lay out the install directory -----------------------------------------

# Braces matter: macOS bash 3.2 reads the bytes of a UTF-8 "…" as part of a
# bare variable name, and set -u then aborts on "unbound variable".
say "Installing to ${TARGET}…"
mkdir -p "$TARGET/data"

# Stop the running instance first. Unix will happily unlink a running binary,
# so this is less destructive than on Windows, but leaving the old process
# alive means it keeps serving the previous build from memory.
if [[ -x "$TARGET/sapbah" ]]; then
  say "Stopping the running instance…"
  "$TARGET/sapbah" stop >/dev/null 2>&1 || true
fi

# Replace the runtime wholesale so a re-install upgrades it cleanly.
rm -rf "$TARGET/runtime"
[[ -e "$TARGET/runtime" ]] && die "Could not replace $TARGET/runtime — something is still using it."
mkdir -p "$TARGET/runtime"
tar -xf "$CACHE/$NODE_ARCHIVE" -C "$TARGET/runtime" --strip-components=1

NODE="$TARGET/runtime/bin/node"
NPM="$TARGET/runtime/bin/npm"
[[ -x "$NODE" ]] || die "Extraction failed — $NODE is not executable."
# node alone is not proof of a good extraction; npm lives beside it.
[[ -e "$NPM" ]] || die "Runtime extraction is incomplete — $NPM is missing.
Delete $TARGET/runtime and run the installer again."
echo "  bundled Node: $("$NODE" -v)"

# --- Build the app with the bundled runtime --------------------------------

say "Building…"
cd "$SRC_DIR"
# ci, not install: the exact dependency versions in package-lock.json.
PATH="$TARGET/runtime/bin:$PATH" "$NPM" ci --no-audit --no-fund --silent
PATH="$TARGET/runtime/bin:$PATH" "$NPM" run build --silent

say "Assembling…"
rm -rf "$TARGET/app"
mkdir -p "$TARGET/app"
cp -R "$SRC_DIR/dist"    "$TARGET/app/dist"
cp -R "$SRC_DIR/public"  "$TARGET/app/public"
cp    "$SRC_DIR/package.json" "$TARGET/app/package.json"
cp    "$SRC_DIR/package-lock.json" "$TARGET/app/package-lock.json"

# A fresh production-only install, so the bundle carries no build tooling.
cd "$TARGET/app"
PATH="$TARGET/runtime/bin:$PATH" "$NPM" ci --omit=dev --no-audit --no-fund --silent

# --- Configuration ---------------------------------------------------------

if [[ ! -f "$TARGET/.env" ]]; then
  cp "$SRC_DIR/.env.example" "$TARGET/.env"
  KEY="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  # BSD sed (macOS) and GNU sed disagree about -i, so write through a temp file.
  sed "s|^ADMIN_KEY=.*|ADMIN_KEY=${KEY}|" "$TARGET/.env" > "$TARGET/.env.tmp"
  mv "$TARGET/.env.tmp" "$TARGET/.env"
  echo "  wrote .env with a generated ADMIN_KEY: $KEY"
else
  echo "  kept the existing .env"
fi
# It holds the admin key and any Hub or Anthropic credentials.
chmod 600 "$TARGET/.env"

install -m 755 "$SRC_DIR/install/templates/sapbah" "$TARGET/sapbah"
cp "$SRC_DIR/README.md" "$TARGET/README.md" 2>/dev/null || true
cp "$SRC_DIR/LICENSE" "$TARGET/LICENSE" 2>/dev/null || true

# --- Autostart -------------------------------------------------------------

if [[ $REGISTER_SERVICE -eq 1 ]]; then
  say "Registering autostart…"
  "$TARGET/sapbah" service install
else
  "$TARGET/sapbah" start
fi

PORT="$(grep -E '^PORT=' "$TARGET/.env" | tail -1 | cut -d= -f2 | tr -d '\r' || echo 8080)"
IP="$( { hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || true; } | awk '{print $1}' )"

cat <<EOF

$(say "Done.")

  UI            http://127.0.0.1:${PORT}/
  From the LAN  http://${IP:-<this-host>}:${PORT}/
  Control       $TARGET/sapbah  start | stop | status | logs | open
  Config        $TARGET/.env
  Data          $TARGET/data

Add it to your PATH if you like:
  ln -sf "$TARGET/sapbah" /usr/local/bin/sapbah
EOF
