#!/usr/bin/env python3
"""
Foster studio site — live assistant backend.
Runs on Darby (the Mac Mini). Shells to the flat-rate `claude` CLI so Foster
can ask questions about his studio and clarify the site's assumptions.

POST /ask  { "message": str, "mode": "ask" | "clarify" }  -> { "answer": str }

Security posture: single small endpoint, input capped, per-IP rate limit,
CORS locked to the Pages origin, no outbound-send capability. Every exchange
is appended to state/foster_studio_qa.jsonl for Gordon to read/relay.
"""
import json, os, re, subprocess, time, html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "foster_studio_qa.jsonl")
INVENTORY = open(os.path.join(HERE, "INVENTORY.md")).read()
PORT = int(os.environ.get("PORT", "8787"))
ORIGIN = "https://gordonusc.github.io"
MAX_CHARS = 1200
RATE_N, RATE_WINDOW = 12, 120  # 12 requests / 2 min per IP
_hits = {}

SYSTEM = f"""You are the studio companion on a private web page that Gordon built as a gift for his 40-year best friend, Foster Birch. The page envisions Foster's ~40-piece synth/studio collection as one cohesive instrument and explores what he could make in it. Foster is the person typing to you right now, on his phone, standing in his own studio.

Your job: answer Foster's questions about his gear and what's possible with it, and let him CLARIFY or CORRECT anything the site got wrong. Be warm, specific, and brief (2-5 sentences unless he asks for depth). You know synths and music production deeply. Talk to him like a sharp studio friend, not a salesperson.

Hard rules:
- NEVER invent gear, specs, prices, or facts not supported below. If unsure, say so and ask him.
- No em dashes anywhere. Use commas, periods, or parentheses.
- Do not sign off, do not use his name in every line, do not gush. Affectionate but grounded.
- When he corrects something (a wrong model, the monitors, the mic, room treatment), thank him plainly and treat his word as truth going forward. These clarifications go back to Gordon.
- Three things the site is genuinely unsure about and would love his answer on: (1) the two studio monitors (model unidentified), (2) whether there's a vocal mic despite the pop filter, (3) room acoustics/treatment. If it fits naturally, invite him to set these straight.
- Stay on his studio, his gear, his music, and what he could build. Gently redirect anything off-topic.

Here is everything the site knows about his collection (the ground truth you may use):

{INVENTORY}
"""


def ask_claude(message, mode):
    frame = "Foster is CLARIFYING or CORRECTING the site:" if mode == "clarify" else "Foster asks:"
    prompt = f"{SYSTEM}\n\n---\n{frame}\n\n{message}\n\nRespond directly to Foster now."
    try:
        r = subprocess.run(
            ["claude", "-p", prompt, "--model", "sonnet"],
            capture_output=True, text=True, timeout=90,
        )
        out = (r.stdout or "").strip()
        if not out:
            return "I hit a snag reaching my brain just now. Give it another try in a moment."
        return out.replace("—", ", ").replace("–", "-")
    except subprocess.TimeoutExpired:
        return "That one took too long to think through. Try asking it a little more simply?"
    except Exception:
        return "Something went sideways on my end. Try again in a sec."


def rate_ok(ip):
    now = time.time()
    q = [t for t in _hits.get(ip, []) if now - t < RATE_WINDOW]
    if len(q) >= RATE_N:
        _hits[ip] = q
        return False
    q.append(now)
    _hits[ip] = q
    return True


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        # health check
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def do_POST(self):
        if self.path != "/ask":
            self.send_response(404); self._cors(); self.end_headers(); return
        ip = self.headers.get("CF-Connecting-IP") or self.client_address[0]
        if not rate_ok(ip):
            self.send_response(429); self._cors()
            self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps({"answer": "Give me a breather, that was a lot at once. Try again in a minute."}).encode())
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            body = {}
        msg = (body.get("message") or "").strip()[:MAX_CHARS]
        mode = "clarify" if body.get("mode") == "clarify" else "ask"
        if not msg:
            self.send_response(400); self._cors()
            self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(b'{"answer":"Type a question or a correction and I am all ears."}')
            return
        answer = ask_claude(msg, mode)
        try:
            with open(LOG, "a") as f:
                f.write(json.dumps({"ts": time.strftime("%Y-%m-%d %H:%M:%S"),
                                    "mode": mode, "ip": ip,
                                    "q": msg, "a": answer}) + "\n")
        except Exception:
            pass
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"answer": answer}).encode())

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"Foster studio backend on :{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
