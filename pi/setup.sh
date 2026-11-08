#!/bin/sh
# setup.sh - Christmas Manager installer for Raspberry Pi OS (bookworm/trixie).
# Idempotent. Run from the copied project folder:   sudo sh setup.sh
# (deploy.ps1 on the PC does this for you.)

set -u

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root:  sudo sh $0" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(dirname "$HERE")"
DST=/opt/christmas-manager
APP_USER="${SUDO_USER:-}"
[ -z "$APP_USER" ] || [ "$APP_USER" = root ] && APP_USER="$(logname 2>/dev/null || echo pi)"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
if [ -z "$APP_HOME" ] || [ ! -d "$APP_HOME" ]; then
  echo "Cannot find home directory for user '$APP_USER'" >&2
  exit 1
fi
APP_GROUP="$(id -gn "$APP_USER")"
REBOOT=0

say()  { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

# ---------------------------------------------------------------- detect ----
MODEL="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unknown)"
OS_CODENAME="$(. /etc/os-release 2>/dev/null; echo "${VERSION_CODENAME:-unknown}")"
say "Model: $MODEL | OS: $OS_CODENAME | user: $APP_USER"
case "$OS_CODENAME" in
  bookworm|trixie) ;;
  *) warn "Untested OS '$OS_CODENAME' (built for bookworm/trixie); continuing." ;;
esac

BOOT_DIR=/boot
[ -d /boot/firmware ] && BOOT_DIR=/boot/firmware
CMDLINE="$BOOT_DIR/cmdline.txt"
CONFIG="$BOOT_DIR/config.txt"

# ------------------------------------------------------------------ node ----
node_major() { node -v 2>/dev/null | sed 's/^v//; s/\..*//'; }

say "Updating package lists"
apt-get update || warn "apt-get update failed (offline?)"

if ! command -v node >/dev/null 2>&1; then
  apt-get install -y nodejs || warn "could not apt install nodejs"
fi
NM="$(node_major)"
if [ -z "$NM" ] || [ "$NM" -lt 18 ] 2>/dev/null; then
  echo "Node.js 18+ is required (found: ${NM:-none})."
  echo "Install a current Node, then re-run this script:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi
echo "Node $(node -v) OK"

# -------------------------------------------------------------- packages ----
say "Installing packages"
apt-get install -y python3-spidev rsync iw curl || warn "core packages failed"
# Optional extras: failure of one must not stop the install.
for pkg in cec-utils v4l-utils unclutter; do
  apt-get install -y "$pkg" || warn "could not install $pkg"
done
if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  apt-get install -y chromium || apt-get install -y chromium-browser \
    || warn "could not install Chromium; the TV kiosk will not work"
fi

# ------------------------------------------------------------- SPI + boot ----
say "Enabling SPI"
if command -v raspi-config >/dev/null 2>&1; then
  raspi-config nonint do_spi 0 || warn "raspi-config do_spi failed"
else
  warn "raspi-config not found; add dtparam=spi=on to $CONFIG yourself"
fi

say "Raising spidev buffer (spidev.bufsiz=65536)"
if [ -f "$CMDLINE" ]; then
  if grep -q 'spidev.bufsiz=' "$CMDLINE"; then
    echo "already set"
  else
    [ -f "$CMDLINE.xmbak" ] || cp "$CMDLINE" "$CMDLINE.xmbak"
    # cmdline.txt must stay ONE line: append to line 1 only.
    sed -i '1s/[[:space:]]*$/ spidev.bufsiz=65536/' "$CMDLINE"
    REBOOT=1
    echo "added to $CMDLINE"
  fi
else
  warn "$CMDLINE not found; add spidev.bufsiz=65536 to the kernel command line"
fi

add_config() {  # add_config key=value  (once, under [all])
  if [ -f "$CONFIG" ] && ! grep -q "^$1" "$CONFIG"; then
    [ -f "$CONFIG.xmbak" ] || cp "$CONFIG" "$CONFIG.xmbak"
    printf '\n[all]\n%s\n' "$2" >> "$CONFIG"
    REBOOT=1
    echo "added $2 to $CONFIG"
  fi
}
case "$MODEL" in
  *"Raspberry Pi 3"*)                 add_config "core_freq=" "core_freq=250" ;;
  *"Raspberry Pi 4"*|*"Raspberry Pi 400"*) add_config "core_freq_min=" "core_freq_min=500" ;;
  *) echo "No SPI clock tweak needed for this model" ;;
esac

# ----------------------------------------------------------- copy project ----
say "Copying project to $DST"
mkdir -p "$DST"
if [ "$SRC" != "$DST" ]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude .git --exclude data "$SRC"/ "$DST"/
  else
    (cd "$SRC" && tar --exclude=./.git --exclude=./data -cf - .) | (cd "$DST" && tar -xf -)
  fi
fi
mkdir -p "$DST/data"
# Scripts edited on Windows may have CRLF line endings; strip them.
find "$DST/pi" "$DST/server" -name '*.sh' -exec sed -i 's/\r$//' {} + 2>/dev/null
chown -R "$APP_USER:$APP_GROUP" "$DST"

# If the server has npm dependencies, install them (node_modules is not deployed).
for pj in "$DST/package.json" "$DST/server/package.json"; do
  if [ -f "$pj" ] && grep -q '"dependencies"' "$pj"; then
    pdir="$(dirname "$pj")"
    command -v npm >/dev/null 2>&1 || apt-get install -y npm || warn "could not install npm"
    echo "npm install in $pdir"
    su "$APP_USER" -s /bin/sh -c "cd '$pdir' && npm install --omit=dev" || warn "npm install failed in $pdir"
  fi
done

# ----------------------------------------------------------------- groups ----
say "Adding $APP_USER to spi, gpio, video groups"
for g in spi gpio video; do
  if getent group "$g" >/dev/null; then
    usermod -aG "$g" "$APP_USER"
  else
    warn "group $g does not exist"
  fi
done

# -------------------------------------------------------------- services ----
say "Writing systemd units"
if [ ! -f /etc/default/christmas-ledd ]; then
  cat > /etc/default/christmas-ledd <<'EOF'
# Options for ledd.py (see: python3 /opt/christmas-manager/pi/ledd.py --help)
#   --count N        number of LEDs (default 300)
#   --order RGB|GRB  WS2811 bullet pixels are often RGB, WS2812 strips GRB
#   --amps 4         power-supply amps budget (10 A supply -> use 8)
#   --gamma 2.2
# Example:  LEDD_ARGS="--count 100 --order RGB --amps 8"
LEDD_ARGS=""
EOF
fi

cat > /etc/systemd/system/christmas-manager.service <<EOF
[Unit]
Description=Christmas Manager server
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$DST
Environment=PORT=47925
Environment=XM_PIXELS=127.0.0.1:47926
Environment=XM_ON_PI=1
Environment=XM_HUE_PORT=80
# lets the server answer Alexa's smart-light discovery on port 80 without running as root
AmbientCapabilities=CAP_NET_BIND_SERVICE
Environment=TZ=America/New_York
ExecStart=/usr/bin/node $DST/server/index.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/christmas-ledd.service <<EOF
[Unit]
Description=Christmas Manager LED driver (SPI)
After=network.target

[Service]
User=$APP_USER
EnvironmentFile=-/etc/default/christmas-ledd
ExecStart=/usr/bin/python3 $DST/pi/ledd.py \$LEDD_ARGS
Restart=always
RestartSec=5
# Blank the strip on stop (ledd handles SIGTERM)
KillSignal=SIGTERM
TimeoutStopSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/christmas-wifi-powersave.service <<'EOF'
[Unit]
Description=Turn Wi-Fi power save off (stops lag spikes)
After=network-online.target sys-subsystem-net-devices-wlan0.device
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iw dev wlan0 set power_save off || true'

[Install]
WantedBy=multi-user.target
EOF

# NetworkManager (bookworm+) can turn power save back on; pin it off too.
if [ -d /etc/NetworkManager/conf.d ]; then
  printf '[connection]\nwifi.powersave = 2\n' > /etc/NetworkManager/conf.d/99-christmas-wifi.conf
fi

systemctl daemon-reload
for s in christmas-wifi-powersave christmas-manager christmas-ledd; do
  systemctl enable "$s.service" >/dev/null 2>&1
  systemctl restart "$s.service" || warn "$s failed to start (check: journalctl -u $s -n 30)"
done

# ------------------------------------------------------------ TV kiosk ----
say "TV kiosk"
chmod +x "$DST/pi/kiosk.sh" 2>/dev/null
KIOSK_CMD="$DST/pi/kiosk.sh"
KIOSK_DONE=""
as_user() { su "$APP_USER" -s /bin/sh -c "$1"; }

have_labwc=0;   command -v labwc >/dev/null 2>&1 && have_labwc=1
have_wayfire=0; command -v wayfire >/dev/null 2>&1 && have_wayfire=1
have_x11=0;     { command -v lxsession >/dev/null 2>&1 || [ -d /etc/xdg/lxsession/LXDE-pi ]; } && have_x11=1

if [ "$have_labwc$have_wayfire$have_x11" = "000" ]; then
  echo "No desktop installed (Lite image): skipping the TV kiosk."
  echo "To use the TV, install Raspberry Pi OS with desktop, or open http://<ip>:47925/tv on another device."
else
  # Which session is configured? Look at lightdm; fall back to what is installed.
  SESS="$(grep -rhsE '^(autologin-session|user-session)=' /etc/lightdm/lightdm.conf /etc/lightdm/lightdm.conf.d 2>/dev/null | tail -n 1 | cut -d= -f2)"
  WANT=""
  case "$SESS" in
    *labwc*)   WANT=labwc ;;
    *wayfire*) WANT=wayfire ;;
    *LXDE*|*lxde*|*rpd-x*) WANT=x11 ;;
  esac
  if [ -z "$WANT" ]; then
    if [ $have_labwc = 1 ]; then WANT=labwc
    elif [ $have_wayfire = 1 ]; then WANT=wayfire
    else WANT=x11; fi
  fi
  echo "Desktop session: $WANT"

  case "$WANT" in
    labwc)
      D="$APP_HOME/.config/labwc"; F="$D/autostart"
      as_user "mkdir -p '$D'"
      # Raspberry Pi OS runs the system autostart AND this one, so add only our line
      # (copying the system file in here started the panel and desktop twice).
      touch "$F"
      if grep -q 'wf-panel-pi' "$F" 2>/dev/null && grep -q 'wf-panel-pi' /etc/xdg/labwc/autostart 2>/dev/null; then
        grep -v -e 'pcmanfm --desktop' -e 'wf-panel-pi' -e '/usr/bin/kanshi' -e 'lxsession-xdg-autostart' "$F" > "$F.tmp"; mv "$F.tmp" "$F"
      fi
      grep -q 'christmas-manager/pi/kiosk.sh' "$F" || printf '\n%s &\n' "$KIOSK_CMD" >> "$F"
      chown "$APP_USER:$APP_GROUP" "$F"; KIOSK_DONE="$F" ;;
    wayfire)
      F="$APP_HOME/.config/wayfire.ini"
      as_user "mkdir -p '$APP_HOME/.config'"
      if [ ! -f "$F" ] && [ -f /etc/wayfire/template.ini ]; then cp /etc/wayfire/template.ini "$F"; fi
      touch "$F"
      if ! grep -q 'christmas-manager/pi/kiosk.sh' "$F"; then
        if grep -q '^\[autostart\]' "$F"; then
          sed -i "/^\[autostart\]/a christmas_kiosk = $KIOSK_CMD" "$F"
        else
          printf '\n[autostart]\nchristmas_kiosk = %s\n' "$KIOSK_CMD" >> "$F"
        fi
      fi
      chown "$APP_USER:$APP_GROUP" "$F"; KIOSK_DONE="$F" ;;
    x11)
      D="$APP_HOME/.config/lxsession/LXDE-pi"; F="$D/autostart"
      as_user "mkdir -p '$D'"
      if [ ! -f "$F" ] && [ -f /etc/xdg/lxsession/LXDE-pi/autostart ]; then
        cp /etc/xdg/lxsession/LXDE-pi/autostart "$F"
      fi
      touch "$F"
      grep -q 'christmas-manager/pi/kiosk.sh' "$F" || printf '\n@%s\n' "$KIOSK_CMD" >> "$F"
      chown "$APP_USER:$APP_GROUP" "$F"; KIOSK_DONE="$F" ;;
  esac

  # Boot to desktop with auto-login, and stop the screen blanking.
  if command -v raspi-config >/dev/null 2>&1; then
    raspi-config nonint do_boot_behaviour B4 || warn "could not set desktop autologin"
    raspi-config nonint do_blanking 1 || true
  fi
  echo "Kiosk wired into $KIOSK_DONE (starts on next desktop login/reboot)"
  as_user "sh '$DST/pi/icons.sh'" || warn "could not add desktop icons"
fi

# --------------------------------------------------------------- summary ----
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "$IP" ] && IP="<pi-ip>"
say "Done"
echo "  Control app : http://$IP:47925"
echo "  TV page     : http://$IP:47925/tv"
echo "  Strip test  : sudo systemctl stop christmas-ledd; sudo python3 $DST/pi/ledd.py --test"
echo "  LED options : sudoedit /etc/default/christmas-ledd   (then: sudo systemctl restart christmas-ledd)"
echo "  Logs        : journalctl -u christmas-manager -u christmas-ledd -f"
if ! command -v tailscale >/dev/null 2>&1; then
  echo "  Tailscale not installed. To reach the Pi from anywhere run:"
  echo "    curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up"
fi
if [ ! -e /dev/spidev0.0 ]; then
  echo "  /dev/spidev0.0 not present yet: SPI turns on after a reboot."
  REBOOT=1
fi
if [ "$REBOOT" = 1 ]; then
  echo
  echo "  REBOOT NEEDED (SPI / boot settings changed):  sudo reboot"
fi
