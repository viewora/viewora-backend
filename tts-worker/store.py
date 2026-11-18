"""Supabase (PostgREST over plain HTTPS) and R2 (S3 API) for the worker.

Every call opens and closes its own connection: Railway puts a service to
sleep only after it stops sending traffic, so nothing may stay connected.
"""
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from narration import MODEL


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Db:
    def __init__(self, url: str | None = None, key: str | None = None):
        self.base = (url or os.environ["SUPABASE_URL"]).rstrip("/") + "/rest/v1"
        self.key = key or os.environ["SUPABASE_SERVICE_KEY"]

    def _req(self, method: str, path: str, params: dict | None = None, body=None, prefer: str | None = None):
        url = f"{self.base}/{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json", "Connection": "close"}
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read()
        return json.loads(raw) if raw else None

    # ── jobs ──
    def claim_job(self) -> dict | None:
        """Take the oldest queued job. The status filter on the update makes it
        safe if two workers ever run: only one of them gets the row back."""
        queued = self._req("GET", "narration_jobs", {"status": "eq.queued", "order": "created_at.asc", "limit": "1", "select": "id"})
        if not queued:
            return None
        rows = self._req(
            "PATCH", "narration_jobs",
            {"id": f"eq.{queued[0]['id']}", "status": "eq.queued"},
            {"status": "running", "started_at": now_iso(), "error": None},
            prefer="return=representation",
        )
        return rows[0] if rows else self.claim_job()

    def update_job(self, job_id: str, **fields):
        self._req("PATCH", "narration_jobs", {"id": f"eq.{job_id}"}, fields)

    def requeue_stale_jobs(self, older_than_minutes: int = 30):
        """A job left 'running' by a worker that was stopped mid-way goes back on the list."""
        cutoff = datetime.now(timezone.utc).timestamp() - older_than_minutes * 60
        iso = datetime.fromtimestamp(cutoff, timezone.utc).isoformat()
        self._req("PATCH", "narration_jobs", {"status": "eq.running", "started_at": f"lt.{iso}"}, {"status": "queued"})

    # ── journeys and recordings ──
    def journey(self, journey_id: str) -> dict | None:
        rows = self._req("GET", "journeys", {"id": f"eq.{journey_id}", "select": "*"})
        return rows[0] if rows else None

    def journeys_of_space(self, space_id: str) -> list[dict]:
        return self._req("GET", "journeys", {"space_id": f"eq.{space_id}", "select": "*", "order": "order_index.asc"}) or []

    def set_voice(self, journey_id: str, voice: str):
        self._req("PATCH", "journeys", {"id": f"eq.{journey_id}"}, {"narration_voice": voice})

    def existing_hashes(self, hashes: list[str]) -> set[str]:
        found: set[str] = set()
        for i in range(0, len(hashes), 100):
            part = hashes[i:i + 100]
            rows = self._req("GET", "narration_audio", {"hash": f"in.({','.join(part)})", "select": "hash"}) or []
            found.update(r["hash"] for r in rows)
        return found

    def save_audio(self, h: str, url: str, ms: int, voice: str, words):
        self._req(
            "POST", "narration_audio", {"on_conflict": "hash"},
            {"hash": h, "url": url, "duration_ms": ms, "voice": voice, "model": MODEL, "words": words},
            prefer="resolution=merge-duplicates",
        )


class Bucket:
    """R2 via the S3 API, same bucket and public domain as the tour photos."""

    def __init__(self):
        import boto3  # only needed when uploading
        from botocore.config import Config

        account = os.environ["R2_ACCOUNT_ID"]
        self.s3 = boto3.client(
            "s3",
            endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            config=Config(tcp_keepalive=False, max_pool_connections=2),
        )
        self.bucket = os.environ["R2_BUCKET_NAME"]
        self.domain = (os.environ.get("MEDIA_DOMAIN") or f"https://pub-{account}.r2.dev").rstrip("/")

    def put_mp3(self, h: str, data: bytes) -> str:
        key = f"narration/{h}.mp3"
        # The file name is the hash of what is said, so it never changes: cache forever.
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType="audio/mpeg",
                           CacheControl="public, max-age=31536000, immutable")
        return f"{self.domain}/{key}"

    def close(self):
        try:
            self.s3.close()
        except Exception:
            pass


class LocalFolder:
    """For trying it out without R2: writes the MP3s to a folder."""

    def __init__(self, folder: str, base_url: str | None = None):
        self.folder = folder
        self.base_url = (base_url or f"file://{os.path.abspath(folder)}").rstrip("/")
        os.makedirs(folder, exist_ok=True)

    def put_mp3(self, h: str, data: bytes) -> str:
        with open(os.path.join(self.folder, f"{h}.mp3"), "wb") as f:
            f.write(data)
        return f"{self.base_url}/{h}.mp3"

    def close(self):
        pass
