#!/usr/bin/env bash
# One-shot setup for the Pi dashboard (Spotify page) on Raspberry Pi OS.
# Run as your normal user (not root):   bash install.sh
# Re-running is safe: it updates files and keeps your keys.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$HOME/.config/pi-dashboard"
ENVF="$CONF/env"
BIN="$HOME/.local/bin"
UNITS="$HOME/.config/systemd/user"
mkdir -p "$CONF" "$BIN" "$UNITS" "$HOME/.local/share/soloist"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -ne 0 ] || { echo "Run as your normal user, not root."; exit 1; }

say "Checking system packages"
need=()
command -v node >/dev/null || need+=(nodejs)
command -v npm >/dev/null || need+=(npm)
command -v curl >/dev/null || need+=(curl)
command -v wpctl >/dev/null || need+=(pipewire pipewire-pulse wireplumber)
if [ ${#need[@]} -gt 0 ]; then sudo apt-get update -y && sudo apt-get install -y "${need[@]}"; fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then echo "Node $NODE_MAJOR is too old (need 18+). Install Node 20+ (e.g. via NodeSource) and re-run."; exit 1; fi

say "Installing dashboard dependencies"
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund)

say "Keys and settings ($ENVF)"
touch "$ENVF"; chmod 600 "$ENVF"
getv() { grep -E "^$1=" "$ENVF" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
setv() { grep -vE "^$1=" "$ENVF" > "$ENVF.tmp" || true; printf '%s=%s\n' "$1" "$2" >> "$ENVF.tmp"; mv "$ENVF.tmp" "$ENVF"; chmod 600 "$ENVF"; }
ask() { # name prompt [secret]
  local cur; cur="$(getv "$1")"
  if [ -z "$cur" ] && [ -n "${!1:-}" ]; then setv "$1" "${!1}"; return; fi
  if [ -z "$cur" ] && [ -t 0 ]; then local v; read -r -p "$2 (Enter to skip): " v || true; [ -n "$v" ] && setv "$1" "$v"; fi
  return 0
}
[ -n "$(getv DEVICE_NAME)" ] || setv DEVICE_NAME "Pi"
[ -n "$(getv PORT)" ] || setv PORT "8080"
ask SOLOIST_API_KEY    "Soloist API key (developer.spotify.com > Soloist)"
ask SPOTIFY_CLIENT_ID  "Spotify Web API Client ID (for search/playlists)"
ask YOUTUBE_API_KEY    "YouTube Data API key (for music videos, optional)"
setv SOLOIST_WS "ws://127.0.0.1:9090"

say "Installing Spotify Soloist (official lossless Connect client)"
case "$(uname -m)" in aarch64) ARCH=arm64;; armv7l) ARCH=arm32;; x86_64) ARCH=x86_64;; *) echo "Unsupported CPU $(uname -m)"; exit 1;; esac
cat > "$BIN/soloist-update" <<EOF
#!/usr/bin/env bash
# Soloist builds expire 90 days after build date, so this runs weekly (soloist-update.timer).
set -euo pipefail
tmp=\$(mktemp -d); trap 'rm -rf "\$tmp"' EXIT
curl --fail --silent --show-error --location -o "\$tmp/soloist.tar.gz" "https://soloist-builds.spotifycdn.com/soloist_release_${ARCH}.tar.gz"
tar -xzf "\$tmp/soloist.tar.gz" -C "\$tmp"
test -x "\$tmp/soloist"
install -m 755 "\$tmp/soloist" "$BIN/soloist.new" && mv -f "$BIN/soloist.new" "$BIN/soloist"
if [ "\${1:-}" != "--no-restart" ]; then systemctl --user try-restart soloist.service || true; fi
echo "soloist updated: \$($BIN/soloist --version 2>&1 | head -1)"
EOF
chmod +x "$BIN/soloist-update"
"$BIN/soloist-update" --no-restart

say "PipeWire: let 44.1 kHz material play without resampling"
mkdir -p "$HOME/.config/pipewire/pipewire.conf.d"
cat > "$HOME/.config/pipewire/pipewire.conf.d/10-pi-dashboard-rates.conf" <<'EOF'
# Spotify Lossless is 44.1 kHz. Allow PipeWire to switch the device clock instead of
# resampling everything to 48 kHz.
context.properties = {
    default.clock.allowed-rates = [ 44100 48000 88200 96000 ]
}
EOF

say "Creating services"
cat > "$UNITS/soloist.service" <<EOF
[Unit]
Description=Spotify Soloist (Connect receiver, lossless)
After=pipewire.service wireplumber.service network-online.target
Wants=pipewire.service

[Service]
EnvironmentFile=$ENVF
ExecStart=/bin/sh -c 'exec $BIN/soloist --device-name "\$DEVICE_NAME" --api-key "\$SOLOIST_API_KEY" --data-dir $HOME/.local/share/soloist --cache-dir $HOME/.cache/soloist --ws 127.0.0.1:9090 \${SOLOIST_OUTPUT:+--pipewire-device "\$SOLOIST_OUTPUT"}'
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
cat > "$UNITS/pi-dashboard.service" <<EOF
[Unit]
Description=Pi dashboard (web UI)
After=network-online.target

[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENVF
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
cat > "$UNITS/soloist-update.service" <<EOF
[Unit]
Description=Refresh Spotify Soloist build (expires every 90 days)
[Service]
Type=oneshot
ExecStart=$BIN/soloist-update
EOF
cat > "$UNITS/soloist-update.timer" <<EOF
[Unit]
Description=Weekly Soloist build refresh
[Timer]
OnCalendar=weekly
Persistent=true
RandomizedDelaySec=1h
[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
sudo loginctl enable-linger "$USER"        # keep services (and PipeWire) up without a login
systemctl --user restart pipewire pipewire-pulse wireplumber 2>/dev/null || true
if [ -n "$(getv SOLOIST_API_KEY)" ]; then systemctl --user enable --now soloist.service; else echo "!! SOLOIST_API_KEY not set: add it to $ENVF then run: systemctl --user enable --now soloist.service"; fi
systemctl --user enable --now pi-dashboard.service soloist-update.timer
systemctl --user restart pi-dashboard.service

chmod +x "$APP_DIR/kiosk.sh" "$APP_DIR/tune.sh"
say "Smooth scrolling: CPU performance governor"; bash "$APP_DIR/tune.sh" || true
mkdir -p "$HOME/.local/share/applications"
printf '[Desktop Entry]\nType=Application\nName=Dashboard mode\nIcon=multimedia-player\nExec=%s\nTerminal=false\n' "$APP_DIR/kiosk.sh" > "$HOME/.local/share/applications/pi-dashboard.desktop"
if [ "${1:-}" = "--kiosk" ]; then
  say "Starting dashboard mode automatically on login"
  mkdir -p "$HOME/.config/autostart"
  printf '[Desktop Entry]\nType=Application\nName=Pi dashboard\nExec=%s\n' "$APP_DIR/kiosk.sh" > "$HOME/.config/autostart/pi-dashboard.desktop"
  if [ -d "$HOME/.config/labwc" ]; then grep -q 'pi-dashboard-kiosk' "$HOME/.config/labwc/autostart" 2>/dev/null || printf '%s & # pi-dashboard-kiosk\n' "$APP_DIR/kiosk.sh" >> "$HOME/.config/labwc/autostart"; fi
fi

cat <<EOF

Done. Next:
  1. Pair once: open the Spotify app on your phone, tap the device picker, choose "$(getv DEVICE_NAME)".
     In the Spotify app: Settings > Playback > Audio quality > pick Lossless for this device.
  2. Open http://127.0.0.1:$(getv PORT) on the Pi (or run ~/Documents/pi-dashboard/kiosk.sh for full screen).
  3. Search/playlists: in the dashboard's Library tab, tap "Sign in to Spotify" once.
     The redirect URI to register on your Spotify app is: http://127.0.0.1:$(getv PORT)/auth/callback
  Logs:  journalctl --user -u soloist -f      journalctl --user -u pi-dashboard -f
  Output device: run  wpctl status  then set SOLOIST_OUTPUT=<node name or id> in $ENVF and restart soloist.
EOF
