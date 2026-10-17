from __future__ import annotations

import io
import wave

import pytest

from conversation_lab.audio import duration_seconds, padded, silence, wav
from conversation_lab.wer import wer, words


def test_wav_is_a_standard_16_bit_mono_file() -> None:
    pcm = b"\x10\x00\xf0\xff" * 800
    data = wav(pcm)
    with wave.open(io.BytesIO(data)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 16000)
        assert w.readframes(w.getnframes()) == pcm
    with pytest.raises(ValueError, match="even"):
        wav(b"\x00")


def test_padding_and_duration() -> None:
    speech = b"\x01\x00" * 16000  # one second
    audio = padded(speech, lead=2.5, tail=1.2)
    assert duration_seconds(audio) == pytest.approx(4.7)
    assert silence(0.5) == b"\x00\x00" * 8000


def test_words_fold_case_punctuation_and_apostrophes() -> None:
    assert words("Hi, it’s Maya. Let's be quick!") == ["hi", "it's", "maya", "let's", "be", "quick"]
    assert words("single-sign-on") == ["single", "sign", "on"]


def test_wer() -> None:
    ref = "We're trying to decide between charging each library branch separately"
    assert wer(ref, "we're trying to decide between charging each library branch separately.") == 0
    assert wer(ref, "were trying to decide between charging each library branch separately") == pytest.approx(
        0.1
    )
    assert wer(ref, "") == 1.0
    assert wer("a b c d", "a x c d e") == 0.5
    with pytest.raises(ValueError, match="empty"):
        wer("", "x")
