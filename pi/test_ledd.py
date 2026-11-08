"""Unit tests for ledd.py. Run: py -I pi/test_ledd.py  (no hardware needed)."""
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Fake spidev module so SpiOut can be exercised on Windows.
class FakeSpiDev:
    instances = []

    def __init__(self):
        self.mode = None
        self.max_speed_hz = None
        self.opened = None
        self.written = []
        FakeSpiDev.instances.append(self)

    def open(self, bus, dev):
        self.opened = (bus, dev)

    def writebytes2(self, data):
        self.written.append(bytes(data))

    def close(self):
        pass

sys.modules["spidev"] = types.SimpleNamespace(SpiDev=FakeSpiDev)

import ledd  # noqa: E402

B0, B1 = ledd.BIT0, ledd.BIT1


class TestEncoding(unittest.TestCase):
    def test_known_byte_0xA5(self):
        # 0xA5 = 1010 0101
        out = ledd.encode_spi(bytes([0xA5]))
        self.assertEqual(list(out[1:9]), [B1, B0, B1, B0, B0, B1, B0, B1])

    def test_framing(self):
        out = ledd.encode_spi(bytes(3))
        self.assertEqual(out[0], 0)                       # leading zero
        self.assertEqual(len(out), 1 + 3 * 8 + 240)
        self.assertTrue(all(b == 0 for b in out[-240:]))  # >=300us reset
        self.assertGreaterEqual(240 * 8 / 6.4e6, 300e-6 - 1e-9)

    def test_bit_constants(self):
        self.assertEqual(B0, 0b11000000)
        self.assertEqual(B1, 0b11111000)

    def test_spi_settings(self):
        out = ledd.SpiOut()
        s = FakeSpiDev.instances[-1]
        self.assertEqual((s.mode, s.max_speed_hz, s.opened), (0, 6400000, (0, 0)))
        out.write(bytes([255, 0, 0]))
        self.assertEqual(len(s.written[0]), 1 + 24 + 240)


class TestOrderGamma(unittest.TestCase):
    def setUp(self):
        self.lin = list(range(256))

    def test_grb(self):
        out = ledd.apply_gamma_order(bytes([10, 20, 30]), self.lin, ledd.parse_order("GRB"))
        self.assertEqual(list(out), [20, 10, 30])

    def test_rgb_and_brg(self):
        self.assertEqual(list(ledd.apply_gamma_order(bytes([1, 2, 3]), self.lin,
                                                     ledd.parse_order("rgb"))), [1, 2, 3])
        self.assertEqual(list(ledd.apply_gamma_order(bytes([1, 2, 3]), self.lin,
                                                     ledd.parse_order("BRG"))), [3, 1, 2])

    def test_bad_order(self):
        with self.assertRaises(ValueError):
            ledd.parse_order("RRG")

    def test_gamma_endpoints(self):
        t = ledd.build_gamma_table(2.2)
        self.assertEqual(len(t), 256)
        self.assertEqual(t[0], 0)
        self.assertEqual(t[255], 255)
        self.assertLess(t[128], 80)                       # darker midtones
        self.assertEqual(t, sorted(t))                    # monotonic

    def test_gamma_one_is_identity(self):
        self.assertEqual(ledd.build_gamma_table(1.0), list(range(256)))


class TestPower(unittest.TestCase):
    def test_under_budget_untouched(self):
        buf = bytearray([255] * 30)                       # 10 white LEDs = 600 mA
        out, scale, _ = ledd.limit_power(buf, 5, 4)
        self.assertEqual(scale, 1.0)
        self.assertEqual(out, buf)

    def test_over_budget_scales_whole_frame(self):
        buf = bytearray([255] * 3 * 400)                  # 400 white = 24 A
        out, scale, est = ledd.limit_power(buf, 5, 4)
        self.assertAlmostEqual(est, 24000.0)
        self.assertAlmostEqual(scale, 4 / 24.0, places=4)
        self.assertLessEqual(ledd.estimate_current_ma(out), 4000.0 + 1e-6)
        self.assertEqual(len(set(out)), 1)                # uniform scale

    def test_ratio_preserved(self):
        buf = bytearray([255, 128, 0] * 200)
        out, scale, _ = ledd.limit_power(buf, 5, 1)
        self.assertLess(scale, 1.0)
        self.assertLessEqual(ledd.estimate_current_ma(out), 1000.0)
        self.assertGreater(out[0], out[1])

    def test_pipeline_end_to_end(self):
        class Sink:
            buf = None
            def write(self, b): Sink.buf = b
        p = ledd.Pipeline(Sink(), 1.0, "GRB", 5, 4, 300)
        p.render(bytes([255, 0, 0] * 10))
        self.assertEqual(list(Sink.buf[:3]), [0, 255, 0])
        p.render(bytes([255, 255, 255] * 300))
        self.assertLess(p.last_scale, 1.0)
        self.assertLessEqual(ledd.estimate_current_ma(Sink.buf), 4000.0 + 1e-6)

    def test_pipeline_clamps_count(self):
        class Sink:
            buf = None
            def write(self, b): Sink.buf = b
        p = ledd.Pipeline(Sink(), 1.0, "RGB", 5, 99, 5)
        p.render(bytes(30))
        self.assertEqual(len(Sink.buf), 15)


class TestParsing(unittest.TestCase):
    def pkt(self, count, payload=None, ver=1, magic=b"XM"):
        payload = bytes(count * 3) if payload is None else payload
        return magic + bytes([ver]) + count.to_bytes(2, "big") + payload

    def test_good(self):
        rgb = bytes(range(9))
        self.assertEqual(ledd.parse_native(self.pkt(3, rgb), 300), rgb)

    def test_big_endian_count(self):
        data = self.pkt(258)                              # 0x0102
        self.assertEqual(data[3:5], b"\x01\x02")
        self.assertEqual(len(ledd.parse_native(data, 1000)), 258 * 3)

    def test_clamped_to_max(self):
        self.assertEqual(len(ledd.parse_native(self.pkt(10), 4)), 12)

    def test_short(self):
        self.assertIsNone(ledd.parse_native(b"XM\x01", 300))
        self.assertIsNone(ledd.parse_native(self.pkt(3, bytes(5)), 300))

    def test_bad_magic_or_version(self):
        self.assertIsNone(ledd.parse_native(self.pkt(1, magic=b"XN"), 300))
        self.assertIsNone(ledd.parse_native(self.pkt(1, ver=2), 300))
        self.assertIsNone(ledd.parse_native(b"", 300))

    def test_drgb(self):
        data = bytes([2, 5, 1, 2, 3, 4, 5, 6])
        self.assertEqual(ledd.parse_drgb(data, 300), bytes([1, 2, 3, 4, 5, 6]))

    def test_drgb_trailing_and_clamp(self):
        self.assertEqual(ledd.parse_drgb(bytes([2, 1, 1, 2, 3, 9]), 300), bytes([1, 2, 3]))
        self.assertEqual(ledd.parse_drgb(bytes([2, 1] + [7] * 30), 2), bytes([7] * 6))

    def test_drgb_bad(self):
        self.assertIsNone(ledd.parse_drgb(bytes([4, 1, 1, 2, 3]), 300))
        self.assertIsNone(ledd.parse_drgb(b"\x02", 300))


if __name__ == "__main__":
    unittest.main(verbosity=2)
