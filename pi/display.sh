#!/bin/sh
# Puts the screen in 1920x1080 widescreen.
# - A screen that doesn't report its size (VNC with no TV, some adapters) otherwise falls back to a
#   stretched 4:3 1024x768.
# - A 4K TV is held at 1080p so the Pi 4 stays smooth.
command -v wlr-randr >/dev/null 2>&1 || exit 0
[ -n "$WAYLAND_DISPLAY" ] || export WAYLAND_DISPLAY=wayland-0
[ -n "$XDG_RUNTIME_DIR" ] || export XDG_RUNTIME_DIR="/run/user/$(id -u)"
wlr-randr 2>/dev/null | awk '/^[A-Z]/{print $1}' | while read -r out; do
  modes="$(wlr-randr 2>/dev/null | awk -v o="$out" '$1==o{f=1;next} /^[A-Z]/{f=0} f')"
  if echo "$modes" | grep -q '1920x1080 px, 60'; then
    wlr-randr --output "$out" --mode 1920x1080@60 >/dev/null 2>&1 || wlr-randr --output "$out" --custom-mode 1920x1080@60Hz >/dev/null 2>&1
  else
    wlr-randr --output "$out" --custom-mode 1920x1080@60Hz >/dev/null 2>&1
  fi
done
exit 0
