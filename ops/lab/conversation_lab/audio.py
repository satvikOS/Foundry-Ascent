"""PCM and WAV helpers for the founder's synthesized voice (16-bit little-endian mono, as Amazon Polly's `pcm`
output and Amazon Transcribe streaming both use)."""

from __future__ import annotations

import struct

SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2


def silence(seconds: float, sample_rate: int = SAMPLE_RATE) -> bytes:
    return b"\x00\x00" * round(seconds * sample_rate)


def duration_seconds(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> float:
    return len(pcm) / (BYTES_PER_SAMPLE * sample_rate)


def wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    """A canonical 44-byte-header RIFF/WAVE file around 16-bit mono PCM (what Chromium's fake audio capture
    and the Web Audio decoder both read)."""
    if len(pcm) % BYTES_PER_SAMPLE:
        raise ValueError("16-bit PCM has an even number of bytes")
    byte_rate = sample_rate * BYTES_PER_SAMPLE
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, byte_rate, BYTES_PER_SAMPLE, 16)
    data = b"data" + struct.pack("<I", len(pcm))
    return header + fmt + data + pcm


def padded(pcm: bytes, *, lead: float, tail: float, sample_rate: int = SAMPLE_RATE) -> bytes:
    return silence(lead, sample_rate) + pcm + silence(tail, sample_rate)
