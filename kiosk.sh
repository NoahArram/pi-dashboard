#!/usr/bin/env bash
# Launch the dashboard full-screen. Exit with the Exit button in the rail (bottom left),
# or Alt+F4 / Ctrl+W with a keyboard attached.
PORT="${PORT:-$(grep -E '^PORT=' "$HOME/.config/pi-dashboard/env" 2>/dev/null | cut -d= -f2)}"; PORT="${PORT:-8080}"
CHROMIUM=$(command -v chromium || command -v chromium-browser) || { echo "Chromium not found"; exit 1; }
# When started over SSH, point at the Pi's own screen.
if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  if [ -S "$XDG_RUNTIME_DIR/wayland-0" ]; then export WAYLAND_DISPLAY=wayland-0; else export DISPLAY=:0; fi
fi
systemctl --user start pi-dashboard.service 2>/dev/null
# Rendering flags for the Pi 5 GPU: hardware rasterisation, zero-copy buffers, all 4 cores for raster,
# native Wayland when available. (Check chrome://gpu: "Rasterization: Hardware accelerated".)
exec "$CHROMIUM" --ozone-platform-hint=auto --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy \
  --num-raster-threads=4 --disable-features=TranslateUI --disable-session-crashed-bubble --kiosk --noerrdialogs --disable-infobars --disable-pinch --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required --password-store=basic --user-data-dir="$HOME/.config/pi-dashboard/chromium" \
  "http://127.0.0.1:$PORT"
