"""Run once at image build: downloads Kokoro's weights, the voices we offer,
and the English language model into the image, so a cold start after a nap
loads from disk instead of the internet."""
import os

from narration import VOICES as OFFERED
from synth import Synth

VOICES = os.environ.get("WARM_VOICES", ",".join(OFFERED)).split(",")

if __name__ == "__main__":
    s = Synth()
    for v in VOICES:
        samples, _ = s.synthesize("Welcome to the hospital.", v.strip())
        print(f"warmed {v}: {len(samples)} samples")
