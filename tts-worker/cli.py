"""generate-narration: record journey voices from the command line.

  generate-narration --tour <space id> [--journey <id>] [--voice af_bella] [--force]
      Records straight away (no queue) and writes to R2 + the database.
      --voice also becomes that journey's voice from now on.

  generate-narration --fixture fixtures/hospital-sample.json --out out/ [--voice X]
      A local trial: no database, no R2. Writes MP3s and a timings report to --out.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time

from generate import generate_narration
from narration import VOICES
from synth import Synth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="generate-narration", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tour", help="space (tour) id: every journey in it")
    ap.add_argument("--journey", help="only this journey")
    ap.add_argument("--voice", choices=VOICES, help="Kokoro voice id (default: the journey's own voice)")
    ap.add_argument("--force", action="store_true", help="re-record lines that already have a voice")
    ap.add_argument("--fixture", help="local trial: a JSON file with {title, steps}")
    ap.add_argument("--out", help="local trial: folder for the MP3s")
    ap.add_argument("--base-url", help="local trial: URL prefix to write into the report")
    a = ap.parse_args(argv)

    synth = Synth()
    if a.fixture:
        from store import LocalFolder
        with open(a.fixture) as f:
            journey = json.load(f)
        out = a.out or "out"
        t0 = time.monotonic()
        report = generate_narration(journey, None, LocalFolder(out, a.base_url), synth, voice=a.voice, force=True)
        report["wall_seconds"] = round(time.monotonic() - t0, 1)
        report["audio_seconds"] = round(sum(r["duration_ms"] for r in report["results"]) / 1000, 1)
        with open(os.path.join(out, "report.json"), "w") as f:
            json.dump(report, f, indent=2)
        print(json.dumps({k: v for k, v in report.items() if k != "results"}, indent=2))
        return 0

    if not (a.tour or a.journey):
        ap.error("give --tour, --journey or --fixture")
    from store import Bucket, Db
    db, bucket = Db(), Bucket()
    journeys = [db.journey(a.journey)] if a.journey else db.journeys_of_space(a.tour)
    for j in journeys:
        if not j:
            print("journey not found", file=sys.stderr)
            return 1
        if a.voice and a.voice != j.get("narration_voice"):
            db.set_voice(j["id"], a.voice)
        r = generate_narration(j, db, bucket, synth, voice=a.voice, force=a.force)
        print(f"{j.get('title')}: {r['recorded']} recorded, {r['skipped']} already had a voice ({r['voice']})")
    bucket.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
