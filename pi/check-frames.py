#!/usr/bin/env python3
"""Counts LED frames the server sends to the pixel driver's port for 2 seconds.
Use with the driver stopped:  sudo systemctl stop christmas-ledd; python3 check-frames.py; sudo systemctl start christmas-ledd"""
import socket, time
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("0.0.0.0", 47926))
s.settimeout(0.5)
n, last, end = 0, b"", time.time() + 2
while time.time() < end:
    try:
        last, _ = s.recvfrom(4096)
        n += 1
    except socket.timeout:
        pass
count = (last[3] << 8 | last[4]) if len(last) > 5 else 0
print(f"frames in 2 s: {n}, magic {last[:2]!r}, LEDs per frame {count}, brightness sum {sum(last[5:])}")
