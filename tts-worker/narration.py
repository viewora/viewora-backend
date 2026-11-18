"""What to record, and how lines are named. No ML, no network: easy to test.

The hash must match src/utils/narration.ts in the API exactly (same vector
in both test suites), because the API looks recordings up by it.
"""
from __future__ import annotations

import hashlib
import re

MODEL = "kokoro-82m-v1.0"
DEFAULT_VOICE = "af_heart"
# Speaking speed, as text so both languages hash the same characters.
SPEED = "1.0"

# Kokoro reads up to ~510 phonemes in one go; shorter pieces keep pauses
# natural and memory flat. A journey line is at most 400 characters.
MAX_CHUNK_CHARS = 220


def normalize_line(text: str) -> str:
    """What is actually said: trimmed, runs of whitespace as one space."""
    return re.sub(r"\s+", " ", (text or "").strip())


def narration_hash(text: str, voice: str = DEFAULT_VOICE) -> str:
    return hashlib.sha256(f"{MODEL}\n{voice}\n{SPEED}\n{normalize_line(text)}".encode("utf-8")).hexdigest()


def journey_lines(steps, voice: str = DEFAULT_VOICE) -> list[tuple[str, str]]:
    """Every distinct non-empty line of a journey, in order, as (hash, text)."""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for step in steps if isinstance(steps, list) else []:
        sentences = step.get("sentences") if isinstance(step, dict) else None
        for s in sentences if isinstance(sentences, list) else []:
            text = normalize_line(s.get("text", "") if isinstance(s, dict) else "")
            if not text:
                continue
            h = narration_hash(text, voice)
            if h in seen:
                continue
            seen.add(h)
            out.append((h, text))
    return out


def lines_to_record(lines: list[tuple[str, str]], have: set[str], force: bool = False) -> list[tuple[str, str]]:
    """The skip rule: a line whose hash already has a recording is left alone."""
    return list(lines) if force else [(h, t) for h, t in lines if h not in have]


_SENTENCE_END = re.compile(r"(?<=[.!?;:])\s+")


def split_chunks(text: str, max_chars: int = MAX_CHUNK_CHARS) -> list[str]:
    """Split a line into sentences, then pack/cut them to at most max_chars.

    A short pause is put between chunks when they are stitched together, so
    sentence breaks sound like breaths. Very long sentences are cut at commas,
    then at spaces; a word is never split.
    """
    text = normalize_line(text)
    if not text:
        return []
    pieces: list[str] = []
    for sentence in _SENTENCE_END.split(text):
        if len(sentence) <= max_chars:
            pieces.append(sentence)
            continue
        parts = re.split(r"(?<=,)\s+", sentence)
        buf = ""
        for part in parts:
            for word in part.split(" ") if len(part) > max_chars else [part]:
                candidate = f"{buf} {word}".strip()
                if len(candidate) <= max_chars:
                    buf = candidate
                else:
                    if buf:
                        pieces.append(buf)
                    buf = word
        if buf:
            pieces.append(buf)
    # Pack short neighbours together so a line isn't chopped into tiny clips.
    chunks: list[str] = []
    for p in pieces:
        if chunks and len(chunks[-1]) + 1 + len(p) <= max_chars and not re.search(r"[.!?]$", chunks[-1]):
            chunks[-1] = f"{chunks[-1]} {p}"
        else:
            chunks.append(p)
    return chunks


def lang_code(voice: str) -> str:
    """Kokoro's language comes from the voice id's first letter (af_heart -> 'a')."""
    return (voice or DEFAULT_VOICE)[0]
