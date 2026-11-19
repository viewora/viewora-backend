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
import signal
import threading
import traceback
from http.server import BaseHTTPRequestHandler

from dualstack import DualStackServer

from generate import generate_narration
from store import Bucket, Db, now_iso
from synth import Synth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts")

_synth = Synth()
_lock = threading.Lock()
_again = threading.Event()
_current: dict | None = None  # the job being recorded right now, if any
_booted = now_iso()  # jobs 'running' since before this are a stopped worker's


REQUIRED = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME")


def missing_settings() -> list[str]:
    return [k for k in REQUIRED if not os.environ.get(k, "").strip()]


def drain(startup: bool = False):
    """Record every queued job, one at a time. Safe to call any number of times.
    At start-up, a job left 'running' by the previous worker (stopped by a
    redeploy or a nap mid-job) is taken back at once, not after 30 minutes."""
    missing = missing_settings()
    if missing:
        log.error("can't record: missing variables %s (set them on this Railway service)", ", ".join(missing))
        return
    if not _lock.acquire(blocking=False):
        _again.set()  # already running: go round once more when done
        return
    try:
        while True:
            _again.clear()
            db = Db()
            try:
                db.requeue_stale_jobs(started_before=_booted if startup else None)
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
    global _current
    log.info("job %s for journey %s", job["id"], job["journey_id"])
    _current = job
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
    finally:
        _current = None


def stop(*_):
    """Railway is stopping us (redeploy or sleep): put an unfinished job back on the
    list, so the next wake-up records the rest at once (finished lines are kept)."""
    job = _current
    if job:
        try:
            Db().requeue_job(job["id"], job.get("started_at"))
            log.info("stopping: job %s back on the list", job["id"])
        except Exception:
            log.exception("stopping: could not put job %s back", job["id"])
    os._exit(0)


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
    # Railway stops a service with SIGTERM (redeploy, sleep). As PID 1, Python would
    # ignore it and be killed 10 s later. A job cut short is picked up again next time.
    signal.signal(signal.SIGTERM, stop)
    missing = missing_settings()
    if missing:
        log.error("missing variables: %s. /health works, but nothing can be recorded until they're set.", ", ".join(missing))
    if not os.environ.get("MEDIA_DOMAIN"):
        log.warning("MEDIA_DOMAIN is not set: recordings will use the r2.dev address")
    threading.Thread(target=drain, kwargs={"startup": True}, daemon=True).start()  # work left from before the nap
    # IPv6 and IPv4 on every address: Railway's private network is IPv6.
    server = DualStackServer(("::", port), Handler)
    log.info("tts worker listening on %d", port)
    server.serve_forever()


if __name__ == "__main__":
    main()
