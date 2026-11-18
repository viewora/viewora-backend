"""The worker's server must answer on IPv6 (Railway's private network) and IPv4."""
import socket
import sys
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dualstack import DualStackServer  # noqa: E402


class Ok(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


class DualStackTest(unittest.TestCase):
    def test_binds_any_address_and_answers_both_families(self):
        server = DualStackServer(("::", 0), Ok)
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            urls = [f"http://127.0.0.1:{port}/health"]
            if socket.has_ipv6:
                urls.append(f"http://[::1]:{port}/health")
            for url in urls:
                with urllib.request.urlopen(url, timeout=5) as r:
                    self.assertEqual(r.read(), b"ok", url)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
