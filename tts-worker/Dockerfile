# Kokoro TTS worker: records journey narration on the CPU, then sleeps.
# Railway service with App Sleeping on (see railway.json, README.md).
FROM python:3.11-slim

# espeak-ng: Kokoro's fallback for words its dictionary doesn't know.
# ffmpeg: loudness normalisation and MP3 encoding.
RUN apt-get update \
 && apt-get install -y --no-install-recommends espeak-ng ffmpeg \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=120 \
    PIP_RETRIES=10 \
    HF_HOME=/models

WORKDIR /app
# CPU-only PyTorch first, so kokoro doesn't pull the CUDA build.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.6.0
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY *.py ./
COPY fixtures ./fixtures
# Bake the model weights, voices and English language data into the image.
RUN python warmup.py
# From here on, never reach out to Hugging Face: everything is on disk.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

EXPOSE 8080
CMD ["python", "worker.py"]
