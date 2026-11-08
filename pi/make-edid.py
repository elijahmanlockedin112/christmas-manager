#!/usr/bin/env python3
"""Builds a 1080p60 'HDMI TV with stereo speakers' EDID (256 bytes) for screens whose own EDID can't be read
(cheap micro-HDMI adapters often drop the DDC line). Without an EDID the Pi falls back to 1024x768 (black bars)
and treats the screen as a monitor with no audio. Usage: python3 make-edid.py out.bin"""
import sys

def checksum(block):
    block[127] = (256 - sum(block[:127]) % 256) % 256
    return block

# ---- base block ----
b = bytearray(128)
b[0:8] = bytes([0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00])
mfg = (ord('N') - 64) << 10 | (ord('P') - 64) << 5 | (ord('C') - 64)   # "NPC"
b[8:10] = mfg.to_bytes(2, 'big')
b[10:12] = (1).to_bytes(2, 'little')          # product code
b[12:16] = (1).to_bytes(4, 'little')          # serial
b[16], b[17] = 1, 2026 - 1990                 # week, year
b[18], b[19] = 1, 3                           # EDID 1.3
b[20] = 0x80                                  # digital input
b[21], b[22] = 121, 68                        # 55" panel, cm
b[23] = 120                                   # gamma 2.2
b[24] = 0x0A                                  # RGB color, preferred timing = first DTD
b[25:35] = bytes([0xEE, 0x91, 0xA3, 0x54, 0x4C, 0x99, 0x26, 0x0F, 0x50, 0x54])  # sRGB-ish chromaticity
b[35:38] = bytes([0x21, 0x08, 0x00])          # 640x480@60, 800x600@60, 1024x768@60
std = [(0xD1, 0xC0), (0x81, 0xC0)] + [(0x01, 0x01)] * 6   # 1920x1080@60 16:9, 1280x720@60 16:9
b[38:54] = bytes([v for p in std for v in p])
DTD_1080P = bytes([0x02, 0x3A, 0x80, 0x18, 0x71, 0x38, 0x2D, 0x40, 0x58, 0x2C, 0x45, 0x00, 0xBA, 0xA8, 0x42, 0x00, 0x00, 0x1E])
b[54:72] = DTD_1080P
b[72:90] = bytes([0, 0, 0, 0xFD, 0, 24, 75, 15, 81, 23, 0x00, 0x0A, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20])  # range limits
name = b'NORTHPOLE TV'
b[90:108] = bytes([0, 0, 0, 0xFC, 0]) + (name + b'\x0A').ljust(13, b' ')
b[108:126] = bytes([0, 0, 0, 0x10, 0]) + bytes(13)
b[126] = 1                                    # one extension (CEA-861)
checksum(b)

# ---- CEA-861 extension: HDMI sink with 2-channel LPCM audio ----
e = bytearray(128)
e[0], e[1] = 0x02, 0x03
blocks = bytes([
    0x44, 0x90, 0x04, 0x03, 0x01,              # video: 1080p60 (native), 720p60, 480p, 640x480
    0x23, 0x09, 0x07, 0x07,                    # audio: LPCM 2ch, 32/44.1/48 kHz, 16/20/24 bit
    0x83, 0x01, 0x00, 0x00,                    # speakers: front left/right
    0x65, 0x03, 0x0C, 0x00, 0x10, 0x00,        # HDMI vendor block (OUI 00-0C-03, phys addr 1.0.0.0): marks it HDMI, enables audio
])
e[4:4 + len(blocks)] = blocks
e[2] = 4 + len(blocks)                         # where detailed timings start
e[3] = 0x41                                    # basic audio supported, 1 native timing
e[e[2]:e[2] + 18] = DTD_1080P
checksum(e)

edid = bytes(b + e)
assert len(edid) == 256 and sum(edid[:128]) % 256 == 0 and sum(edid[128:]) % 256 == 0
open(sys.argv[1] if len(sys.argv) > 1 else 'np-1080p.bin', 'wb').write(edid)
print('wrote', len(edid), 'bytes')
