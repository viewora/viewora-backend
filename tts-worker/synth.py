"""Text to an MP3 with Kokoro-82M on the CPU, then loudness-normalised by ffmpeg."""
from __future__ import annotations

import logging
import subprocess

import numpy as np

from narration import SPEED, lang_code, split_chunks

log = logging.getLogger("tts")

SAMPLE_RATE = 24000          # Kokoro's output rate
PAUSE_S = 0.28               # breath between sentences
EDGE_S = 0.08                # a hair of silence at the start and end of a clip
MP3_BITRATE = "64k"          # mono speech: clear, ~0.5 MB a minute
LOUDNESS = "loudnorm=I=-16:TP=-1.5:LRA=11"  # every line at the same level


class Synth:
    """Holds one Kokoro pipeline per language; the model loads once per wake-up."""

    def __init__(self):
        self._pipelines: dict[str, object] = {}

    def _pipeline(self, voice: str):
        code = lang_code(voice)
        if code not in self._pipelines:
            from kokoro import KPipeline  # heavy import: only when there is work
            log.info("loading Kokoro pipeline lang=%s", code)
            self._pipelines[code] = KPipeline(lang_code=code, repo_id="hexgrad/Kokoro-82M")
        return self._pipelines[code]

    def synthesize(self, text: str, voice: str) -> tuple[np.ndarray, list[dict] | None]:
        """Float32 mono samples at 24 kHz, plus word timings in ms when Kokoro gives them."""
        pipeline = self._pipeline(voice)
        pause = np.zeros(int(PAUSE_S * SAMPLE_RATE), dtype=np.float32)
        edge = np.zeros(int(EDGE_S * SAMPLE_RATE), dtype=np.float32)
        parts: list[np.ndarray] = [edge]
        words: list[dict] = []
        have_words = True
        offset = len(edge) / SAMPLE_RATE
        chunks = split_chunks(text)
        for i, chunk in enumerate(chunks):
            # split_pattern=None: we already split; don't let Kokoro split again.
            for result in pipeline(chunk, voice=voice, speed=float(SPEED), split_pattern=None):
                audio = getattr(result, "audio", None)
                if audio is None:
                    audio = result[2]
                samples = np.asarray(audio.detach().cpu().numpy() if hasattr(audio, "detach") else audio, dtype=np.float32).reshape(-1)
                tokens = getattr(result, "tokens", None)
                if tokens:
                    for t in tokens:
                        s, e = getattr(t, "start_ts", None), getattr(t, "end_ts", None)
                        w = (getattr(t, "text", "") or "").strip()
                        if s is None or e is None:
                            have_words = False
                        elif w:
                            words.append({"w": w, "s": round((offset + s) * 1000), "e": round((offset + e) * 1000)})
                else:
                    have_words = False
                parts.append(samples)
                offset += len(samples) / SAMPLE_RATE
            if i < len(chunks) - 1:
                parts.append(pause)
                offset += PAUSE_S
        parts.append(edge)
        return np.concatenate(parts), (words if have_words and words else None)


def encode_mp3(samples: np.ndarray) -> bytes:
    """Normalise loudness and encode to MP3 (mono, 24 kHz) with ffmpeg."""
    proc = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
            "-af", LOUDNESS,
            "-ar", str(SAMPLE_RATE), "-ac", "1",
            "-c:a", "libmp3lame", "-b:a", MP3_BITRATE, "-f", "mp3", "pipe:1",
        ],
        input=samples.astype(np.float32).tobytes(),
        capture_output=True,
        check=True,
    )
    return proc.stdout


def duration_ms(samples: np.ndarray) -> int:
    return round(len(samples) * 1000 / SAMPLE_RATE)
