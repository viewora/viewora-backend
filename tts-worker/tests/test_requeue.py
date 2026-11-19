"""A job cut off by a redeploy or a nap is picked up again by the next worker.

At start-up, every job 'running' since before this worker started goes back
on the list at once (not after 30 minutes). The stopping worker only puts its
job back if no newer worker has taken it over.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from store import Db  # noqa: E402


class Recorder(Db):
    def __init__(self):
        self.calls = []

    def _req(self, method, path, params=None, body=None, prefer=None):
        self.calls.append((method, path, params, body))
        return None


class RequeueTest(unittest.TestCase):
    def test_startup_takes_back_jobs_begun_before_it_started(self):
        db = Recorder()
        db.requeue_stale_jobs(started_before="2026-11-19T12:46:52+00:00")
        method, path, params, body = db.calls[0]
        self.assertEqual((method, path), ("PATCH", "narration_jobs"))
        self.assertEqual(params, {"status": "eq.running", "started_at": "lt.2026-11-19T12:46:52+00:00"})
        self.assertEqual(body, {"status": "queued"})

    def test_otherwise_only_jobs_older_than_30_minutes(self):
        db = Recorder()
        db.requeue_stale_jobs()
        cutoff = db.calls[0][2]["started_at"]
        self.assertTrue(cutoff.startswith("lt."))

    def test_stopping_worker_only_puts_back_its_own_run(self):
        db = Recorder()
        db.requeue_job("job-1", "2026-11-19T12:45:57.833+00:00")
        _, _, params, body = db.calls[0]
        self.assertEqual(params, {"id": "eq.job-1", "status": "eq.running", "started_at": "eq.2026-11-19T12:45:57.833+00:00"})
        self.assertEqual(body, {"status": "queued", "started_at": None})


if __name__ == "__main__":
    unittest.main()
