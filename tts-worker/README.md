# TTS worker: recorded narration for patient journeys

Turns each line of a journey ("What happens here?") into a short MP3, read by
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache 2.0) on the CPU.
The files go to R2 next to the tour photos, and the journey player plays them
in place of the browser's built-in voice.

It runs **only while there is work**. It's a Railway service with *App Sleeping*
on: the API wakes it when someone presses **Generate voice**, it records
everything on its to-do list, and Railway puts it back to sleep 5–10 minutes
after its last network traffic.

```
Editor: "Generate voice"
  └─ API  POST /journeys/:id/narration
       ├─ adds a row to narration_jobs  (the to-do list: nothing is lost if the wake-up fails)
       └─ POST http://<worker>.railway.internal:8080/wake   (wakes it; retried for ~45 s)
Worker (wakes up, model loaded from the image)
  └─ for each queued job: every line without a recording →
       Kokoro → stitch sentences with a short pause → ffmpeg loudnorm → MP3 (mono, 64 kb/s)
       → R2 narration/<hash>.mp3  (cached for a year: the name is the hash of what's said)
       → narration_audio row (hash, url, duration_ms, voice, model, words?)
API, when serving a journey: adds { audio: { url, duration_ms, text } } to each line that has one.
Player: plays the line's MP3; the clip's own clock decides when the visit moves on.
```

## How lines are matched to recordings

`hash = sha256("kokoro-82m-v1.0\n<voice>\n1.0\n<line, trimmed, spaces collapsed>")`

Computed the same way by the API (`src/utils/narration.ts`) and this worker
(`narration.py`); both test suites check the same vector. So:

- an unchanged line is **never recorded twice** (pressing Generate voice again
  only records new or edited lines);
- the same sentence in two journeys shares one file;
- an edited line just "needs a voice" again, and plays as a caption until then.

## Generating narration

**From the editor:** Patient journeys tab, then **Generate voice** (left column).
It records every line that needs it, in one go, and shows progress. Switching a
journey to *Shown on your tour* also starts it if lines are missing a voice.
Press ▶ next to a line to hear it.

**From the command line** (locally or as a one-off Railway run), records straight away:

```bash
python cli.py --tour <space id>                  # every journey in a tour
python cli.py --journey <id> --voice af_bella    # one journey, in another voice (becomes its voice)
python cli.py --tour <space id> --force          # re-record everything
```

**Try it with no database or R2** (the sample hospital visit):

```bash
podman build -t viewora-tts-worker .     # or docker
podman run --rm -v "$PWD/out:/out:Z" viewora-tts-worker \
  python cli.py --fixture fixtures/hospital-sample.json --out /out
# out/*.mp3 + out/report.json (lengths, and how long each took = speed on this CPU)
```

Needs `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, and `MEDIA_DOMAIN` (same values as the API)
for anything except `--fixture`.

## Writing lines that sound good

- One idea per line, as you'd say it to a patient. A line is one recording;
  the camera turns to that line's **Facing** before it plays.
- To point at something specific (e.g. the pharmacy window), pick its info
  hotspot under the line's Facing box: its card opens for as long as the line plays.
- Write numbers and abbreviations as they should be read ("two hours", "X-ray").

## Voices

Chosen per journey in the editor's Voice box (`journeys.narration_voice`,
default `af_heart`, the only voice Kokoro grades overall A). Offered: `af_heart`,
`af_bella` (US), `bf_emma` (UK), `am_michael` (US, man): exactly the ones
baked into the image. The list lives in `narration.py`, `src/utils/narration.ts`
and the app's `shared/utils/journey.ts`; `tests/test_voices.py` fails if they
disagree. Editor samples: `viewora-app/public/voices/<id>.mp3`. Changing a
journey's voice keeps old recordings, so switching back costs nothing.
To compare: `python cli.py --fixture fixtures/hospital-sample.json --out /out --voice bf_emma`.

## Deploying on Railway

Railway stops reading `railway.json` on 2026-12-01 and new services can't opt
in, so set the service up in the dashboard (`railway.json` here only mirrors
those settings). Full click-by-click steps with a check after each, plus a
troubleshooting table: `Notes/2026-11-18 Recorded voices - setup steps, fixes and ideas.md`
at the top of the project folder. In short:

1. Run `src/utils/migration-narration.sql` in Supabase (after `migration-journeys.sql`).
2. New → Empty Service, named **`tts-worker`** (its private address is
   `tts-worker.railway.internal`). Root Directory `/tts-worker`, Connect Repo
   (this repo, `main`), Watch Paths `/tts-worker/**`, Healthcheck Path `/health`,
   **Serverless on**, no public domain. Memory: plan default; never below 2 GB.
3. Variables: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, the four `R2_*`,
   `MEDIA_DOMAIN` as references to the API's (`${{<api service>.NAME}}`), and `PORT=8080`.
4. On the **API**: `TTS_WORKER_URL=http://tts-worker.railway.internal:8080`.
5. Generate voice on a journey; the worker logs `POST /wake`, then each line and its speed.

The worker logs `missing variables: …` at start if any are unset, and the API
logs `TTS worker unreachable` if `TTS_WORKER_URL` is wrong. It listens on IPv6
and IPv4 (Railway's private network is IPv6), stops in well under a second on
SIGTERM, and puts an unfinished job back on the list when stopped. `start.sh`
exists so it also starts correctly if the repository root's `railway.json`
(`sh start.sh`) is ever applied to it.

**Fallback if wake-ups ever prove unreliable:** give the same service a cron
schedule `*/5 * * * *` and start command `python -c "import worker; worker.drain()"`;
it clears the to-do list and exits (up to 5 minutes' delay).

Things that keep a sleeping service awake: any outbound traffic. This worker opens
a fresh connection per request and closes it, and talks to nothing while idle.
Don't add telemetry or a database pool to it.

## Cost

Railway bills per minute: about $20 per vCPU-month and $10 per GB-month
(30 days = 43,200 minutes). While awake with 2 vCPU and 2 GB:

- per minute awake ≈ 2 × $20/43,200 + 2 × $10/43,200 ≈ **$0.0014**
- one batch = cold start + recording + the 5–10 idle minutes before sleep.
- Measured (sample visit, 8 lines, 48 s of speech, limited to 2 vCPU / 2 GB, no
  network): ~13 s to load the model, then **~0.85× real time** (a 6 s line takes
  ~7 s); 70 s in all. Railway's CPUs may be a little faster or slower; each run's
  `report.json` / worker log prints the speed.
- So a 9-step visit with ~30 lines (~4 minutes of speech) takes ~5 minutes to
  record, plus ~10 minutes idle before sleep: ~15 minutes awake ≈ **$0.02**.
  Regenerating after an edit records only the changed lines.
- Image size: ~2.4 GB (CPU PyTorch + model + voices), stored by Railway.
- Asleep: Railway's docs say sleeping "effectively" removes the cost; they don't
  promise exactly zero.

Serving: MP3s are ~0.5 MB a minute, served from R2 with
`Cache-Control: public, max-age=31536000, immutable`. R2 has no egress fees;
reads are billed per request (Class B), negligible at tour scale.
