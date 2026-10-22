#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mock_provider.py - سرور شبیه‌ساز OpenAI برای تست modeltest.py
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import urllib.parse

PORT = 8888
API_KEY = "test-key"

class Handler(BaseHTTPRequestHandler):
    def _set(self, code=200, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def _auth_ok(self):
        auth = self.headers.get("Authorization", "")
        if auth != f"Bearer {API_KEY}":
            self._set(401)
            self.wfile.write(json.dumps({"error":{"message":"invalid api key","type":"authentication_error"}}).encode())
            return False
        return True

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.endswith("/models"):
            if not self._auth_ok():
                return
            data = {
                "object": "list",
                "data": [
                    {"id": "mock-gpt-4o", "object": "model", "owned_by": "mock"},
                    {"id": "mock-gpt-4o-mini", "object": "model", "owned_by": "mock"},
                    {"id": "mock-embed-small", "object": "model", "owned_by": "mock"},  # should be filtered
                    {"id": "mock-whisper", "object": "model", "owned_by": "mock"},      # should be filtered
                    {"id": "mock-quota-model", "object": "model", "owned_by": "mock"},   # returns quota
                    {"id": "mock-rate-model", "object": "model", "owned_by": "mock"},    # returns rate limit
                    {"id": "mock-broken-model", "object": "model", "owned_by": "mock"},   # bad request
                ]
            }
            self._set(200)
            self.wfile.write(json.dumps(data).encode())
            return
        self._set(404)
        self.wfile.write(b'{"error":{"message":"not found"}}')

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.endswith("/chat/completions"):
            if not self._auth_ok():
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                data = json.loads(body)
                model = data.get("model", "")
            except Exception as e:
                self._set(400)
                self.wfile.write(json.dumps({"error":{"message":str(e)}}).encode())
                return

            if model == "mock-quota-model":
                self._set(429)
                self.wfile.write(json.dumps({"error":{"message":"You have insufficient balance","type":"quota_error"}}).encode())
                return
            if model == "mock-rate-model":
                self._set(429)
                self.wfile.write(json.dumps({"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}).encode())
                return
            if model == "mock-broken-model":
                self._set(400)
                self.wfile.write(json.dumps({"error":{"message":"Invalid model parameters","type":"invalid_request_error"}}).encode())
                return

            resp = {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}
            }
            self._set(200)
            self.wfile.write(json.dumps(resp).encode())
            return
        self._set(404)
        self.wfile.write(b'{"error":{"message":"not found"}}')

    def log_message(self, *args):
        pass

if __name__ == "__main__":
    print(f"Mock OpenAI server on http://127.0.0.1:{PORT}/v1  (key: {API_KEY})")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
