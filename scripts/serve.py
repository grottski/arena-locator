"""Serve Arena Locator on your local network with caching turned off, so phones
always pick up the latest changes on reload.

Run:  python3 scripts/serve.py [port]
Then open http://<your-mac's-ip>:<port> on any device on the same Wi-Fi.
"""
import functools
import http.server
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def lan_ip():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))  # no packet is sent; just picks the LAN interface
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("0.0.0.0", PORT), handler) as httpd:
        print(f"Arena Locator running:\n  this Mac:  http://localhost:{PORT}\n  phone:     http://{lan_ip()}:{PORT}", flush=True)
        httpd.serve_forever()
