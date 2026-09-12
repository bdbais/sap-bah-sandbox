#!/usr/bin/env bash
#
# Installs the sandbox as a systemd service on a Debian/Ubuntu or RHEL host.
# Run from the repository root:  sudo ./deploy/install.sh
#
set -euo pipefail

APP_DIR=/opt/sap-bah-sandbox
APP_USER=sapbah
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

# --- Node ------------------------------------------------------------------
# node:sqlite is built in from Node 22.5; there is no native module to compile.
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node 22.5+ (24 LTS recommended) first:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs" >&2
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 5) )); then
  echo "Node $(node -v) is too old — node:sqlite needs 22.5 or newer." >&2
  exit 1
fi
echo "Using Node $(node -v)"

# --- User and directory ----------------------------------------------------
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
  echo "Created service user $APP_USER"
fi

mkdir -p "$APP_DIR"
# Deliberately not --delete: it would wipe data/ and .env on every upgrade.
for item in src public scripts package.json tsconfig.json .env.example README.md deploy; do
  [[ -e "$SRC_DIR/$item" ]] && cp -r "$SRC_DIR/$item" "$APP_DIR/"
done
mkdir -p "$APP_DIR/data"

# --- Configuration ---------------------------------------------------------
if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  # Generate an admin key so the API is not left open by default.
  KEY=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
  sed -i "s|^ADMIN_KEY=.*|ADMIN_KEY=${KEY}|" "$APP_DIR/.env"
  echo "Wrote $APP_DIR/.env with a generated ADMIN_KEY: ${KEY}"
  echo "  (paste it into the 'key' box in the UI)"
else
  echo "Kept the existing $APP_DIR/.env"
fi
# It holds the admin key and any Hub or Anthropic credentials; the chown below
# hands it to the service user.
chmod 600 "$APP_DIR/.env"

# --- Build -----------------------------------------------------------------
cd "$APP_DIR"
echo "Installing dependencies…"
npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund
echo "Compiling…"
npm run build
echo "Dropping build-only dependencies…"
npm prune --omit=dev

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# --- systemd ---------------------------------------------------------------
# The units say /usr/bin/node; point them at the node that passed the version
# check above, wherever it lives.
NODE_BIN="$(command -v node)"
case "$NODE_BIN" in
  /root/*|/home/*) echo "Warning: $NODE_BIN is under a home directory, which the service (ProtectHome=true) cannot read." >&2 ;;
esac
for unit in sapbah-sandbox.service sapbah-sync.service sapbah-sync.timer; do
  sed "s|/usr/bin/node|$NODE_BIN|g" "$APP_DIR/deploy/$unit" > "/etc/systemd/system/$unit"
  chmod 644 "/etc/systemd/system/$unit"
done

systemctl daemon-reload
systemctl enable --now sapbah-sandbox.service
systemctl enable --now sapbah-sync.timer

PORT=$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 || echo 8080)
IP=$(hostname -I 2>/dev/null | awk '{print $1}')

cat <<EOF

Done.

  UI       http://${IP:-<host>}:${PORT}/
  Mocks    http://${IP:-<host>}:${PORT}/mock/<slug>
  Logs     journalctl -u sapbah-sandbox -f
  Sync now systemctl start sapbah-sync
  Schedule systemctl list-timers sapbah-sync

If a firewall is active, open the port:
  sudo ufw allow ${PORT}/tcp            # Debian/Ubuntu
  sudo firewall-cmd --add-port=${PORT}/tcp --permanent && sudo firewall-cmd --reload
EOF
