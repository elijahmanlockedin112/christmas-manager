#!/usr/bin/env python3
"""ledd.py - Christmas Manager LED pixel daemon (WS2811 / WS2812 over SPI).

Listens for UDP frames, applies gamma + colour order + a global power limit,
and clocks the result out of the Raspberry Pi SPI0 MOSI pin (GPIO10,
physical pin 19) using the "8 SPI bits per LED bit" trick at 6.4 MHz.

Inputs
  * Native  : UDP 0.0.0.0:47926  b'XM' + 0x01 + uint16 BE count + count*3 RGB
              (RGB is already perceptual sRGB 0-255; we apply gamma here)
  * WLED DRGB: UDP 0.0.0.0:21324 byte0=2, byte1=timeout secs, then RGB triples
              (so xLights etc. can drive the tree too)

Colour order: most WS2812 strips are GRB (default). Many 12 mm WS2811 bullet
pixels are RGB.  If red and green look swapped, you have the wrong one:
    --order RGB      (typical WS2811 bullet pixels)
    --order GRB      (typical WS2812 / WS2812B strips)
Run `--test` to check: the "count" mode shows RED LEDs; if they show green,
fix --order.

Power limit (safety): each channel is estimated at 20 mA at full brightness.
If a frame would draw more than --amps at --volts, the WHOLE frame is scaled
down proportionally. Set --amps to what your power supply can really deliver
(leave headroom: a 10 A supply -> --amps 8).

Other behaviour
  * No packet for 2 s -> keep the last frame (the strip latches by itself).
  * SIGTERM / SIGINT  -> blank the strip, then exit.
  * --test  : standalone rainbow chase, then a "count the LEDs" mode.
  * --dry   : no SPI, print stats instead (Windows development).

Python 3.9+, stdlib + spidev (apt install python3-spidev).
"""
import argparse
import colorsys
import select
import signal
import socket
import sys
import time

NATIVE_PORT = 47926
DRGB_PORT = 21324
MAGIC = b"XM"
PROTO_VERSION = 1
MA_PER_CHANNEL = 20.0      # estimated draw of one colour channel at 255
SPI_HZ = 6_400_000         # 6.4 MHz -> 1.25 us per LED bit (8 SPI bits)
BIT0 = 0b11000000          # ~0.3 us high  -> WS281x "0"
BIT1 = 0b11111000          # ~0.78 us high -> WS281x "1"
RESET_BYTES = 240          # 240 * 8 / 6.4 MHz = 300 us of low (>= 280 us reset)


# --------------------------------------------------------------------------
# Pure helpers (unit tested)
# --------------------------------------------------------------------------
def build_gamma_table(gamma):
    """256-entry table mapping perceptual 0-255 to linear PWM 0-255."""
    if gamma <= 0:
        raise ValueError("gamma must be > 0")
    return [int(round(((i / 255.0) ** gamma) * 255.0)) for i in range(256)]


def parse_order(order):
    """'GRB' -> (1, 0, 2): index into an RGB triple for each output channel."""
    o = order.upper()
    if sorted(o) != ["B", "G", "R"]:
        raise ValueError("order must be a permutation of R, G, B (got %r)" % order)
    return tuple("RGB".index(c) for c in o)


def apply_gamma_order(rgb, table, order_idx):
    """Gamma-correct and reorder a flat RGB bytes object. Returns bytearray."""
    out = bytearray(len(rgb) - len(rgb) % 3)
    i0, i1, i2 = order_idx
    for p in range(0, len(out), 3):
        out[p] = table[rgb[p + i0]]
        out[p + 1] = table[rgb[p + i1]]
        out[p + 2] = table[rgb[p + i2]]
    return out


def estimate_current_ma(buf):
    """Estimated supply current (mA) for a flat channel buffer."""
    return sum(buf) / 255.0 * MA_PER_CHANNEL


def limit_power(buf, volts, amps):
    """Scale the whole frame down if it exceeds the power budget.

    Power is estimated as current * volts; the budget is volts * amps. Returns
    (new_buf, scale, est_ma_before). scale == 1.0 means untouched.
    """
    est_ma = estimate_current_ma(buf)
    est_w = est_ma / 1000.0 * volts
    budget_w = volts * amps
    if est_w <= budget_w or est_w <= 0:
        return buf, 1.0, est_ma
    scale = budget_w / est_w
    # int() truncates, so the result never rounds up past the budget.
    return bytearray(int(b * scale) for b in buf), scale, est_ma


def encode_spi(buf):
    """Channel bytes -> SPI byte stream (leading 0x00, data, 240 zero reset)."""
    out = bytearray(1 + len(buf) * 8 + RESET_BYTES)   # zeros by default
    pos = 1
    for byte in buf:
        for bit in range(7, -1, -1):
            out[pos] = BIT1 if (byte >> bit) & 1 else BIT0
            pos += 1
    return out


def parse_native(data, max_leds):
    """Parse an XM packet. Returns RGB bytes (clamped to max_leds) or None."""
    if len(data) < 5 or data[0:2] != MAGIC or data[2] != PROTO_VERSION:
        return None
    count = (data[3] << 8) | data[4]
    if len(data) < 5 + count * 3:
        return None                      # truncated packet
    count = min(count, max_leds)
    return bytes(data[5:5 + count * 3])


def parse_drgb(data, max_leds):
    """Parse a WLED DRGB packet (byte0=2, byte1=timeout). RGB bytes or None."""
    if len(data) < 2 or data[0] != 2:
        return None
    body = data[2:]
    n = min(len(body) // 3, max_leds)
    return bytes(body[:n * 3])


# --------------------------------------------------------------------------
# Outputs
# --------------------------------------------------------------------------
class SpiOut:
    """Real SPI output on /dev/spidev<bus>.<dev>."""

    def __init__(self, bus=0, dev=0, speed=SPI_HZ):
        import spidev  # imported late so --dry works without it
        self.spi = spidev.SpiDev()
        self.spi.open(bus, dev)
        self.spi.mode = 0
        self.spi.max_speed_hz = speed

    def write(self, buf):
        data = encode_spi(buf)
        try:
            # Whole buffer in one transfer; needs spidev.bufsiz >= len(data)
            # (setup.sh sets 65536 on the kernel command line).
            self.spi.writebytes2(data)
        except AttributeError:           # very old python3-spidev
            for i in range(0, len(data), 4096):
                self.spi.writebytes(list(data[i:i + 4096]))

    def close(self):
        try:
            self.spi.close()
        except Exception:
            pass


class DryOut:
    """No hardware: print a stats line at most twice a second."""

    def __init__(self):
        self.last = 0.0
        self.frames = 0

    def write(self, buf):
        self.frames += 1
        now = time.time()
        if now - self.last >= 0.5:
            self.last = now
            print("[dry] frame %d: %d LEDs, %d SPI bytes, est %.0f mA after limit, "
                  "first px %s" % (self.frames, len(buf) // 3,
                                   1 + len(buf) * 8 + RESET_BYTES,
                                   estimate_current_ma(buf), tuple(buf[:3])))

    def close(self):
        pass


# --------------------------------------------------------------------------
# Pipeline
# --------------------------------------------------------------------------
class Pipeline:
    """RGB in -> gamma/order/power -> output."""

    def __init__(self, out, gamma, order, volts, amps, count):
        self.out = out
        self.table = build_gamma_table(gamma)
        self.order_idx = parse_order(order)
        self.volts = volts
        self.amps = amps
        self.count = count
        self.last_scale = 1.0
        self.warned = 0.0

    def render(self, rgb):
        buf = apply_gamma_order(rgb[:self.count * 3], self.table, self.order_idx)
        buf, scale, est = limit_power(buf, self.volts, self.amps)
        self.last_scale = scale
        if scale < 1.0 and time.time() - self.warned > 10:
            self.warned = time.time()
            print("power limit: frame wanted ~%.1f A, scaled to %.0f%%"
                  % (est / 1000.0, scale * 100), flush=True)
        self.out.write(buf)

    def blank(self):
        self.out.write(bytearray(self.count * 3))


# --------------------------------------------------------------------------
# Test patterns (no server needed)
# --------------------------------------------------------------------------
def rainbow_frame(count, t):
    out = bytearray()
    for i in range(count):
        h = ((i / 30.0) - t * 0.25) % 1.0
        r, g, b = colorsys.hsv_to_rgb(h, 1.0, 0.6)
        out += bytes((int(r * 255), int(g * 255), int(b * 255)))
    return bytes(out)


def count_frame(count, lit):
    """First `lit` LEDs red, every 10th one white. Count the whites!"""
    out = bytearray(count * 3)
    for i in range(min(lit, count)):
        px = (120, 120, 120) if (i + 1) % 10 == 0 else (255, 0, 0)
        out[i * 3:i * 3 + 3] = bytes(px)
    return bytes(out)


def run_test(pipe, stop):
    print("TEST: rainbow chase 8 s, then LEDs light up one by one (red; every "
          "10th white). The last lit LED is your strip length. Ctrl+C to quit.")
    while not stop["flag"]:
        t0 = time.time()
        while time.time() - t0 < 8 and not stop["flag"]:
            pipe.render(rainbow_frame(pipe.count, time.time() - t0))
            time.sleep(0.03)
        for lit in range(1, pipe.count + 1):
            if stop["flag"]:
                return
            pipe.render(count_frame(pipe.count, lit))
            time.sleep(0.04)
        end = time.time() + 4
        while time.time() < end and not stop["flag"]:
            time.sleep(0.1)


# --------------------------------------------------------------------------
# Server
# --------------------------------------------------------------------------
def make_socket(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", port))
    s.setblocking(False)
    return s


def run_server(pipe, args, stop):
    socks = {make_socket(args.port): parse_native,
             make_socket(args.drgb_port): parse_drgb}
    print("ledd listening on UDP %d (native) and %d (WLED DRGB); max %d LEDs, "
          "order %s, gamma %.2f, limit %.1f A @ %.1f V%s"
          % (args.port, args.drgb_port, args.count, args.order.upper(),
             args.gamma, args.amps, args.volts, "  [DRY RUN]" if args.dry else ""),
          flush=True)
    last_seen = time.time()
    warned_idle = False
    while not stop["flag"]:
        try:
            ready, _, _ = select.select(list(socks), [], [], 0.25)
        except (OSError, ValueError):
            if stop["flag"]:
                break
            raise
        latest = None
        for s in ready:
            # Drain everything queued; only the newest frame gets rendered.
            while True:
                try:
                    data, _ = s.recvfrom(65535)
                except (BlockingIOError, InterruptedError):
                    break
                except OSError:
                    break
                rgb = socks[s](data, args.count)
                if rgb is not None:
                    latest = rgb
        if latest is not None:
            last_seen = time.time()
            warned_idle = False
            pipe.render(latest)
        elif time.time() - last_seen > 2.0 and not warned_idle:
            warned_idle = True      # keep last frame; just note it once
            print("no packets for 2 s - holding last frame", flush=True)
    for s in socks:
        s.close()


def build_parser():
    p = argparse.ArgumentParser(
        description="Christmas Manager LED daemon (WS2811/WS2812 via SPI).")
    p.add_argument("--count", type=int, default=300, help="max LEDs (default 300)")
    p.add_argument("--gamma", type=float, default=2.2, help="gamma (default 2.2)")
    p.add_argument("--order", default="GRB",
                   help="colour order GRB (WS2812, default) or RGB (many WS2811)")
    p.add_argument("--volts", type=float, default=5.0, help="supply volts (default 5)")
    p.add_argument("--amps", type=float, default=4.0,
                   help="supply amps budget for the power limit (default 4)")
    p.add_argument("--port", type=int, default=NATIVE_PORT, help="native UDP port")
    p.add_argument("--drgb-port", type=int, default=DRGB_PORT, help="WLED DRGB UDP port")
    p.add_argument("--bus", type=int, default=0, help="SPI bus (default 0)")
    p.add_argument("--device", type=int, default=0, help="SPI device (default 0)")
    p.add_argument("--test", action="store_true",
                   help="rainbow chase + count-the-LEDs, no server needed")
    p.add_argument("--dry", action="store_true",
                   help="do not touch SPI; print stats (for Windows dev)")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        parse_order(args.order)
        build_gamma_table(args.gamma)
    except ValueError as e:
        print("error:", e, file=sys.stderr)
        return 2
    if args.count < 1 or args.amps <= 0 or args.volts <= 0:
        print("error: --count, --amps and --volts must be positive", file=sys.stderr)
        return 2

    if args.dry:
        out = DryOut()
    else:
        try:
            out = SpiOut(args.bus, args.device)
        except ImportError:
            print("error: python3-spidev missing (sudo apt install python3-spidev)",
                  file=sys.stderr)
            return 1
        except (OSError, PermissionError) as e:
            print("error: cannot open /dev/spidev%d.%d (%s). Enable SPI, reboot, "
                  "and run as root or a user in the 'spi' group."
                  % (args.bus, args.device, e), file=sys.stderr)
            return 1

    pipe = Pipeline(out, args.gamma, args.order, args.volts, args.amps, args.count)
    stop = {"flag": False}

    def on_signal(signum, frame):
        stop["flag"] = True

    signal.signal(signal.SIGINT, on_signal)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, on_signal)

    try:
        if args.test:
            run_test(pipe, stop)
        else:
            run_server(pipe, args, stop)
    finally:
        try:
            pipe.blank()
        except Exception:
            pass
        out.close()
        print("ledd stopped, strip blanked", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
