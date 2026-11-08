#!/bin/sh
# Puts "North Pole TV" and "Close North Pole TV" icons on the Pi desktop and in the app menu.
# Run as the desktop user (setup.sh does this):  sh /opt/christmas-manager/pi/icons.sh
DST=/opt/christmas-manager
ICON="$DST/web/icon-180.png"
APPS="$HOME/.local/share/applications"
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
mkdir -p "$APPS" "$DESK"

cat > "$APPS/north-pole-tv.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=North Pole TV
Comment=Open the Christmas TV screen full screen
Exec=sh $DST/pi/kiosk.sh
Icon=$ICON
Terminal=false
Categories=AudioVideo;
EOF

cat > "$APPS/north-pole-tv-close.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Close North Pole TV
Comment=Close the full-screen TV and show the desktop (lights keep running)
Exec=sh $DST/pi/tv-close.sh
Icon=$ICON
Terminal=false
Categories=AudioVideo;
EOF

cp "$APPS/north-pole-tv.desktop" "$APPS/north-pole-tv-close.desktop" "$DESK/"
chmod +x "$DESK/north-pole-tv.desktop" "$DESK/north-pole-tv-close.desktop" "$APPS"/north-pole-tv*.desktop
# pcmanfm (the Pi desktop) asks before running desktop files unless they're trusted; skip that prompt.
for f in "$DESK/north-pole-tv.desktop" "$DESK/north-pole-tv-close.desktop"; do
  gio set "$f" metadata::trusted true 2>/dev/null || true
done
mkdir -p "$HOME/.config/libfm"
if [ -f "$HOME/.config/libfm/libfm.conf" ]; then
  grep -q '^quick_exec=1' "$HOME/.config/libfm/libfm.conf" || sed -i 's/^\[config\]/[config]\nquick_exec=1/' "$HOME/.config/libfm/libfm.conf"
else
  printf '[config]\nquick_exec=1\n' > "$HOME/.config/libfm/libfm.conf"
fi
echo "Icons: $DESK/north-pole-tv.desktop, $DESK/north-pole-tv-close.desktop"
