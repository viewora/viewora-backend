"""An HTTP server that answers on IPv6 and IPv4 at once.

Railway's private network resolves to IPv6 (only IPv6 in older projects), and
the standard ThreadingHTTPServer is IPv4-only: giving it "::" crashes at start.
"""
from __future__ import annotations

import socket
from http.server import ThreadingHTTPServer


class DualStackServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True

    def server_bind(self):
        # 0 = also accept IPv4 (seen as ::ffff:a.b.c.d), whatever the system default.
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()
