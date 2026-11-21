#!/usr/bin/env bash
# Run once: keeps the Pi 5 CPU at full speed so scrolling doesn't stutter while clocks ramp up.
set -e
sudo tee /etc/systemd/system/pi-performance.service >/dev/null <<'UNIT'
[Unit]
Description=CPU performance governor for the dashboard
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'for g in /sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_governor; do echo performance > "$g"; done'
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now pi-performance.service
echo "governor: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)  clock: $(( $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq) / 1000 )) MHz"
echo "Display mode (4K is much heavier than 1080p):"; (wlr-randr 2>/dev/null || xrandr 2>/dev/null || true) | head -8
