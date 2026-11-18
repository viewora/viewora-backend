"""generate_narration: record every line of a journey that has no voice yet."""
from __future__ import annotations

import logging
import time

from narration import DEFAULT_VOICE, journey_lines, lines_to_record
from synth import Synth, duration_ms, encode_mp3

log = logging.getLogger("tts")


def generate_narration(journey: dict, db, bucket, synth: Synth, voice: str | None = None,
                       force: bool = False, progress=None) -> dict:
    """Record the lines of one journey that need it; returns counts.

    - db: store.Db, or None to skip the database (local trial: no skip check, no rows written)
    - bucket: store.Bucket (R2) or store.LocalFolder
    - progress(done, total): called after each line, e.g. to update the job row
    """
    voice = voice or journey.get("narration_voice") or DEFAULT_VOICE
    lines = journey_lines(journey.get("steps"), voice)
    have = db.existing_hashes([h for h, _ in lines]) if (db and not force) else set()
    todo = lines_to_record(lines, have, force)
    log.info("journey %s: %d lines, %d to record (voice %s)", journey.get("id"), len(lines), len(todo), voice)
    results = []
    for i, (h, text) in enumerate(todo):
        t0 = time.monotonic()
        samples, words = synth.synthesize(text, voice)
        mp3 = encode_mp3(samples)
        url = bucket.put_mp3(h, mp3)
        ms = duration_ms(samples)
        if db:
            db.save_audio(h, url, ms, voice, words)
        took = time.monotonic() - t0
        log.info("  %d/%d %.1fs audio in %.1fs (%.2fx realtime): %s", i + 1, len(todo), ms / 1000, took, (ms / 1000) / max(took, 1e-6), text[:60])
        results.append({"hash": h, "text": text, "url": url, "duration_ms": ms, "seconds": round(took, 2), "words": words is not None})
        if progress:
            progress(i + 1, len(todo))
    return {"lines": len(lines), "recorded": len(todo), "skipped": len(lines) - len(todo), "voice": voice, "results": results}
