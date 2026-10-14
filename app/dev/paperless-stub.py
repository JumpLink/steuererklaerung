#!/usr/bin/env python3
"""Paperless stand-in for demo screenshots: answers every request with an empty list.

Demo mode keeps its receipts locally, but the EÜR/Buchungen views still ask Paperless; without an
answer they show "PAPERLESS_BASE_URL not set" instead of the demo data. Prints its port, then serves.
"""
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"count": 0, "next": None, "previous": None, "results": []}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    do_POST = do_GET
    def log_message(self, *a): pass
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
print(srv.server_address[1], flush=True)
srv.serve_forever()
