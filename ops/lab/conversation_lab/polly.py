"""The founder's voice for the voice suite: Amazon Polly renders each scripted line to 16 kHz PCM, written as
WAV files Chromium plays as its microphone. Metered at the price the app meters Polly at."""

from __future__ import annotations

from typing import Any, Protocol

from conversation_lab.audio import SAMPLE_RATE
from conversation_lab.bedrock import ModelCallError, error_code
from conversation_lab.budget import Charge, Ledger, SpendGuard, micro_ceil

#: A clear adult US-English neural voice, different from the seeded vEIRs' (Matthew, Ruth).
FOUNDER_VOICE = "Joanna"
ENGINE = "neural"


class PollyClient(Protocol):
    def synthesize_speech(self, **kwargs: Any) -> dict[str, Any]: ...


def characters(text: str) -> int:
    """Characters Polly bills (code points; SSML is never sent)."""
    return len(text)


def synthesize_pcm(
    client: PollyClient,
    text: str,
    *,
    guard: SpendGuard,
    ledger: Ledger,
    usd_per_million: float,
    voice: str = FOUNDER_VOICE,
) -> bytes:
    guard.reserve_lab(micro_ceil(characters(text) * usd_per_million / 1_000_000))
    try:
        response = client.synthesize_speech(
            Engine=ENGINE,
            OutputFormat="pcm",
            SampleRate=str(SAMPLE_RATE),
            Text=text,
            TextType="text",
            VoiceId=voice,
        )
        pcm = response["AudioStream"].read()
    except Exception as exc:  # noqa: BLE001 - only the AWS error code is kept
        raise ModelCallError(error_code(exc)) from None
    billed = int(response.get("RequestCharacters") or characters(text))
    ledger.add(
        Charge(
            kind="polly",
            purpose="voice",
            model=f"polly:{ENGINE}:{voice}",
            units_in=billed,
            units_out=0,
            usd=micro_ceil(billed * usd_per_million / 1_000_000),
        )
    )
    if len(pcm) % 2:
        pcm = pcm[:-1]
    return pcm
