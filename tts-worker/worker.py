"""The sleeping TTS service (Railway, App Sleeping on).

- POST /wake  : the API's "there's work" bell. Starts clearing the to-do list.
- GET  /health: for Railway's health check.

It also clears the list when it starts, so a job is never lost if a wake-up
request fails (the first request to a sleeping service can get a 502). When
the list is empty it does nothing and opens no connections, and Railway puts
it back to sleep 5–10 minutes later.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from generate import generate_narration
from store import Bucket, Db, now_iso
from synth import Synth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts")

_synth = Synth()
_lock = threading.Lock()
_again = threading.Event()


def drain():
    """Record every queued job, one at a time. Safe to call any number of times."""
    if not _lock.acquire(blocking=False):
        _again.set()  # already running: go round once more when done
        return
    try:
        while True:
            _again.clear()
            db = Db()
            try:
                db.requeue_stale_jobs()
            except Exception:
                log.exception("could not requeue stale jobs")
            bucket = None
            while (job := db.claim_job()) is not None:
                bucket = bucket or Bucket()
                run_job(job, db, bucket)
            if bucket:
                bucket.close()
            if not _again.is_set():
                break
    except Exception:
        log.exception("drain failed")
    finally:
        _lock.release()


def run_job(job: dict, db: Db, bucket: Bucket):
    log.info("job %s for journey %s", job["id"], job["journey_id"])
    try:
        journey = db.journey(job["journey_id"])
        if not journey:
            db.update_job(job["id"], status="failed", error="Journey not found", finished_at=now_iso())
            return
        out = generate_narration(
            journey, db, bucket, _synth, voice=job.get("voice"), force=bool(job.get("force")),
            progress=lambda done, total: db.update_job(job["id"], done_count=done, total=total),
        )
        db.update_job(job["id"], status="done", done_count=out["recorded"], total=out["recorded"], finished_at=now_iso())
    except Exception as e:
        traceback.print_exc()
        db.update_job(job["id"], status="failed", error=str(e)[:500], finished_at=now_iso())


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"ok": True}) if self.path == "/health" else self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/wake":
            return self._send(404, {"error": "not found"})
        threading.Thread(target=drain, daemon=True).start()
        self._send(202, {"ok": True})

    def log_message(self, fmt, *args):  # quieter than the default access log
        if self.path != "/health":
            log.info("%s %s", self.command, self.path)


def main():
    port = int(os.environ.get("PORT", "8080"))
    threading.Thread(target=drain, daemon=True).start()  # work left from before the nap
    # "::" listens on IPv6 too: Railway's private network is IPv6.
    server = ThreadingHTTPServer(("::", port), Handler)
    log.info("tts worker listening on %d", port)
    server.serve_forever()


if __name__ == "__main__":
    main()
