# Christmas Manager: Hardware Guide

Short version: a Raspberry Pi next to the tree runs the app, talks to the TV over HDMI, and (optionally) drives the lights. Pick ONE light option below. Prices are rough "about" ranges; check recent reviews and the exact listing (voltage!) before you buy.

| Option | What you get | Effort |
|---|---|---|
| A. Pixel string lights | Full colors + animations | Medium (a little wiring) |
| B. Your existing USB lights | Dim / pulse / beat only, no colors | Low |
| C. WLED controller | Full colors + animations, no wiring to the Pi | Low |

---

## Option A: addressable pixel lights (best)

### Shopping list (about, check reviews)
- **5V WS2811 12 mm "bullet" pixel strings.** Make sure the listing says **5V** (many are 12V, which will NOT work with this wiring). 2 strings of 50 = **100 LEDs** for a 6-7 ft tree; **150-200** for a bigger one. About $15-35 per 50-pixel string.
- **5V 10A power supply with screw terminals.** About $15-30. Buy from a seller with good reviews; this one runs hot for hours.
- **74AHCT125 level shifter chip** (DIP-14 or a small breakout board). About $1-4. (Or use the "sacrificial first pixel" trick below.)
- **330 ohm resistor** (1/4 W) for the data line. Pennies.
- **1000 uF, 6.3V or higher electrolytic capacitor.** About $1-2.
- Hookup wire (18-22 AWG for power, thin for data), a small breadboard or perf board, a fuse (7.5-10 A) on the +5V line if you can.

### Wiring (Pi physical pin numbers)

```
 RASPBERRY PI (40-pin header)            74AHCT125
 ---------------------------             ---------
 pin 19  GPIO10 (SPI MOSI) ------------> pin 2  (1A)
 pin 6   GND ---+                        pin 1  (1OE)  -> GND
                |                        pin 7  (GND)  -> GND
                |                        pin 14 (VCC)  -> +5V (from the PSU)
                |                        pin 3  (1Y) ---[ 330 ohm ]---> LED DATA (DIN)
                |                        (tie unused inputs 4, 9, 12 to GND)
                |
                +-------------- common GND --------------+
                                                         |
 5V 10A POWER SUPPLY                                     |
 -------------------                                     |
  +5V  ----+-----------> LED string +5V (red)            |
           |   +-----------> 74AHCT125 pin 14            |
           |   |                                         |
        [ 1000 uF cap, + to +5V, stripe/- to GND ]       |
           |                                             |
  GND  ----+-----------> LED string GND (white/blue) ----+
                         + Pi pin 6 GND + chip pin 7
```

Rules that matter:
1. **Never power the LEDs from the Pi's 5V pin.** The Pi can only spare a fraction of an amp; 100 pixels can pull several amps. The Pi gets its own USB-C supply.
2. **Common ground:** the Pi GND (pin 6), the power supply GND and the LED GND must all be connected.
3. **Data goes through the resistor:** Pi pin 19 -> level shifter -> 330 ohm -> first pixel DIN. Keep that wire short (under ~30 cm).
4. **Capacitor across the supply** right where the power enters the lights, correct polarity.
5. **Power injection every ~100 LEDs:** connect +5V and GND from the supply to the start of each 100-LED run (and the far end of long runs), not just the first string. Otherwise the far end turns orange/dim.
6. **Power on order:** supply first (or together), then the Pi. Never connect data with the LEDs unpowered for long.

**No level shifter? Sacrificial first pixel:** power the *first* pixel from a separate source about 0.7 V lower (e.g., through a 1N4001 diode from 5V), so its output is happy with 3.3V logic, and ignore it (it just becomes pixel 0). It is a hack and less reliable than the 74AHCT125; use the chip if you can.

### Software settings
`/etc/default/christmas-ledd` on the Pi (edit with `sudoedit`, then `sudo systemctl restart christmas-ledd`):

```
LEDD_ARGS="--count 100 --order RGB --amps 8"
```

- `--count`: how many LEDs you have.
- `--order`: **WS2811 bullet pixels are often RGB; WS2812 strips are usually GRB (the default).** If the test shows green where it should be red, flip it.
- `--amps`: what your supply can safely deliver, with headroom (10 A supply -> 8). The driver scales brightness down automatically if a frame would exceed this (estimates 20 mA per color channel at full).

### How to test (before decorating)
```
sudo systemctl stop christmas-ledd
sudo python3 /opt/christmas-manager/pi/ledd.py --test
```
You will see a rainbow chase, then the LEDs light up one by one in **red**, every 10th one **white**. Count the whites to check your length and that nothing past the break is dark. Press Ctrl+C to stop, then `sudo systemctl start christmas-ledd`.

Troubleshooting: nothing lights -> reboot once after install (SPI + buffer setting), check GND is shared and the chip has 5V; flickering at the start -> shorten the data wire, check the resistor; wrong colors -> `--order`; far end dim -> add power injection.

---

## Option B: lights you already have (USB string lights)

Use the existing beat-lights rig: Arduino + transistor driving plain USB string lights, controlled by the Pi relay (project: `C:\Users\elija\Downloads\Coding Projects\beat-lights`).

- The Pi relay listens on **UDP 47961** and takes lines like `0-255\n` (brightness).
- The app can **dim, pulse and beat-sync** them. **No colors**, one brightness for the whole string.
- Fine for a first Christmas; upgrade to A or C later without changing the TV or app setup.

## Option C: WLED controller

- Get an **ESP32 board running WLED firmware** (a prebuilt WLED controller is easiest; or flash a plain ESP32 from install.wled.me). About $10-40 depending on prebuilt vs DIY. Pixel lights and the 5V supply wire the same way as Option A, but the data line comes from the ESP32 instead of the Pi.
- Join it to your Wi-Fi and note its IP address.
- The app drives it over Wi-Fi with **DRGB UDP on port 21324** (real-time protocol). Make sure WLED's "Receive UDP realtime" is enabled (Sync Interfaces settings).
- The WLED app/web page still works for your own presets.
- Other tools (xLights etc.) can also send DRGB straight to the Pi driver on port 21324 for Option A.

---

## The TV

1. Plug the Pi into the TV's **HDMI** port (on a Pi 4/5, use the micro-HDMI port closest to the USB-C power port).
2. Turn on **HDMI-CEC** in the TV settings so the app can switch the TV on and select the Pi input. The name depends on the brand:
   - Samsung: **Anynet+ (HDMI-CEC)**
   - Sony: **Bravia Sync** (HDMI control)
   - LG: **SIMPLINK (HDMI-CEC)**
   - Panasonic: **VIERA Link / HDAVI Control**
   - Philips: **EasyLink**
   - Sharp: **Aquos Link**; Toshiba: **CE-Link / Regza Link**
   - Vizio, TCL, Hisense, others: look for **CEC** or "HDMI control"
3. Check from the Pi: `echo scan | cec-client -s -d 1` should list the TV.
4. The TV page opens by itself at boot: `http://<pi-ip>:47925/tv`.

## Install on the Pi

Flash Raspberry Pi OS **with desktop** (needed for the TV page) and enable SSH in Raspberry Pi Imager. Then from the PC:

```
powershell -ExecutionPolicy Bypass -File "C:\Users\elija\Downloads\Coding Projects\christmas-manager\pi\deploy.ps1" -PiHost raspberrypi.local -User pi
```

It prints the app URL (`http://<pi-ip>:47925`) at the end. Reboot once when it says so.
