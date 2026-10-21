"""Serve Blur on http://localhost:5173 with caching off, so edits show up on reload."""
import http.server
import os

PORT = 5173


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


os.chdir(os.path.dirname(os.path.abspath(__file__)))
print(f"Blur running at http://localhost:{PORT}")
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler).serve_forever()
