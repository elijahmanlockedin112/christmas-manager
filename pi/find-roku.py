#!/usr/bin/env python3
"""Finds Roku TVs on the network (SSDP 'roku:ecp') and prints model + what input is showing. Read-only."""
import socket, re, urllib.request, time
msg = ('M-SEARCH * HTTP/1.1\r\nHost: 239.255.255.250:1900\r\nMan: "ssdp:discover"\r\nST: roku:ecp\r\nMX: 2\r\n\r\n').encode()
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
s.settimeout(3)
s.sendto(msg, ("239.255.255.250", 1900))
found, end = set(), time.time() + 3
while time.time() < end:
    try:
        data, addr = s.recvfrom(2048)
    except socket.timeout:
        break
    m = re.search(rb"LOCATION:\s*(http://[^\r\n]+)", data, re.I)
    if m:
        found.add(m.group(1).decode().strip().rstrip("/"))
if not found:
    print("no Roku found")
for loc in found:
    def get(p):
        try:
            return urllib.request.urlopen(loc + p, timeout=3).read().decode(errors="replace")
        except Exception as e:
            return f"ERR {e}"
    info = get("/query/device-info")
    pick = lambda tag: (re.search(f"<{tag}>([^<]*)</{tag}>", info) or [None, "?"])[1]
    app = get("/query/active-app")
    act = re.search(r'<app[^>]*id="([^"]*)"[^>]*>([^<]*)</app>', app)
    print(f"{loc}  {pick('vendor-name')} {pick('model-name')}  power={pick('power-mode')}  tv={pick('is-tv')}  mobile-control={pick('supports-ecs-textedit') and pick('developer-enabled')}  showing={act.group(1) + ' ' + act.group(2) if act else app[:80]}")
