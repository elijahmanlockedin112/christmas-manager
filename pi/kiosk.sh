#!/bin/sh
# kiosk.sh - full-screen Chromium on the HDMI TV showing the Christmas Manager
# TV page. Started by the desktop session autostart (see setup.sh).
# Waits for the server, launches Chromium, and relaunches it if it ever exits.

URL="${XM_TV_URL:-http://localhost:47925/tv?kiosk=1}"
HEALTH="${XM_HEALTH_URL:-http://localhost:47925/}"

# Find a Chromium binary (package is "chromium" on bookworm+, older: chromium-browser).
CHROMIUM=""
for c in chromium chromium-browser; do
  if command -v "$c" >/dev/null 2>&1; then CHROMIUM="$c"; break; fi
done
if [ -z "$CHROMIUM" ]; then
  echo "kiosk: no chromium installed" >&2
  exit 1
fi

# Widescreen 1080p (fixes the stretched 4:3 picture on screens that don't report their size).
sh "$(dirname "$0")/display.sh" 2>/dev/null

# Hide the mouse pointer (works on X11; harmless elsewhere).
if command -v unclutter >/dev/null 2>&1; then
  unclutter -idle 0.5 -root >/dev/null 2>&1 &
fi

# Never let the TV go to sleep via the X screensaver (no-op on Wayland).
if [ -n "$DISPLAY" ] && command -v xset >/dev/null 2>&1; then
  xset s off 2>/dev/null
  xset s noblank 2>/dev/null
  xset -dpms 2>/dev/null
fi

# Wait until the server answers (it may still be starting at boot).
wait_for_server() {
  while :; do
    if command -v curl >/dev/null 2>&1; then
      curl -fsS -o /dev/null --max-time 2 "$HEALTH" 2>/dev/null && return 0
    elif command -v wget >/dev/null 2>&1; then
      wget -q -O /dev/null -T 2 "$HEALTH" 2>/dev/null && return 0
    else
      sleep 15; return 0
    fi
    sleep 2
  done
}

PROFILE="${HOME:-/tmp}/.config/christmas-kiosk"
mkdir -p "$PROFILE"
STOP="$PROFILE/STOP"
LOCK="$PROFILE/kiosk.pid"

# Only one kiosk at a time (the desktop icon and the autostart may both start it).
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
  echo "kiosk: already running" >&2
  exit 0
fi
echo $$ > "$LOCK"
rm -f "$STOP"

while :; do
  [ -f "$STOP" ] && break
  wait_for_server
  # Avoid the "Chromium didn't shut down correctly" bubble after power loss.
  if [ -f "$PROFILE/Default/Preferences" ]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"Crashed"/"exit_type":"Normal"/' \
      "$PROFILE/Default/Preferences" 2>/dev/null
  fi
  "$CHROMIUM" \
    --kiosk \
    --ignore-gpu-blocklist \
    --enable-gpu-rasterization \
    --enable-zero-copy \
    --user-data-dir="$PROFILE" \
    --noerrdialogs \
    --disable-infobars \
    --autoplay-policy=no-user-gesture-required \
    --check-for-update-interval=31536000 \
    --disable-features=Translate \
    --overscroll-history-navigation=0 \
    --password-store=basic \
    --no-first-run \
    "$URL"
  # closed with the "Close North Pole TV" icon: stay closed
  [ -f "$STOP" ] && break
  echo "kiosk: chromium exited, restarting in 3 s" >&2
  sleep 3
done
rm -f "$LOCK"
