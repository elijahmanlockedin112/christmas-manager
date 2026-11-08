#!/bin/sh
# Closes the full-screen North Pole TV and goes back to the Pi desktop.
# (The lights, Alexa and the iPad app keep running; only the TV screen closes.)
PROFILE="${HOME:-/tmp}/.config/christmas-kiosk"
mkdir -p "$PROFILE"
touch "$PROFILE/STOP"
pkill -f -- "--user-data-dir=$PROFILE" 2>/dev/null
exit 0
