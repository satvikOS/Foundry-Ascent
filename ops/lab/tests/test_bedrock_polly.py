from __future__ import annotations

import io

import pytest

from conversation_lab.bedrock import LabModelClient, ModelCallError, error_code, user
from conversation_lab.budget import BudgetExceededError, Ledger, SpendGuard
from conversation_lab.polly import synthesize_pcm
from tests.conftest import PRICES, AwsError, FakeConverse

ARN_MESSAGE = "User: arn:aws:sts::123456789012:assumed-role/FoundryAscent-ConversationLab/x is not authorized"


def client(fake: FakeConverse, guard: SpendGuard, ledger: Ledger) -> LabModelClient:
    return LabModelClient(client=fake, prices=PRICES, guard=guard, ledger=ledger)


def test_converse_meters_what_the_response_reports(guard: SpendGuard, ledger: Ledger) -> None:
    fake = FakeConverse([("  a reply  ", 1200, 80)])
    text = client(fake, guard, ledger).converse(
        "us.amazon.nova-premier-v1:0",
        system="be brief",
        messages=[user("hello")],
        max_tokens=100,
        temperature=0.0,
        purpose="judge",
    )
    assert text == "a reply"
    assert fake.requests[0]["modelId"] == "us.amazon.nova-premier-v1:0"
    assert fake.requests[0]["inferenceConfig"] == {"maxTokens": 100, "temperature": 0.0}
    assert fake.requests[0]["system"] == [{"text": "be brief"}]
    [charge] = ledger.charges
    assert (charge.purpose, charge.units_in, charge.units_out) == ("judge", 1200, 80)
    assert charge.usd == pytest.approx((1200 * 2.5 + 80 * 12.5) / 1e6)


def test_a_call_that_could_exceed_the_budget_is_never_made(ledger: Ledger) -> None:
    guard = SpendGuard(app_budget=1, lab_budget=0.001, ledger=ledger)
    fake = FakeConverse([("never", 1, 1)])
    with pytest.raises(BudgetExceededError):
        client(fake, guard, ledger).converse(
            "us.amazon.nova-premier-v1:0",
            system="x" * 3000,
            messages=[user("y")],
            max_tokens=500,
            temperature=0,
            purpose="judge",
        )
    assert fake.requests == []
    assert ledger.total == 0


def test_errors_keep_the_aws_code_and_never_the_message(guard: SpendGuard, ledger: Ledger) -> None:
    fake = FakeConverse([AwsError("AccessDeniedException", ARN_MESSAGE)])
    with pytest.raises(ModelCallError) as exc:
        client(fake, guard, ledger).converse(
            "us.amazon.nova-pro-v1:0",
            system="s",
            messages=[user("u")],
            max_tokens=4,
            temperature=0,
            purpose="probe",
        )
    assert exc.value.code == "AccessDeniedException"
    assert "123456789012" not in str(exc.value)
    assert exc.value.__cause__ is None
    assert exc.value.__suppress_context__
    assert error_code(ValueError(ARN_MESSAGE)) == "ValueError"


def test_probe_takes_the_first_model_that_answers(guard: SpendGuard, ledger: Ledger) -> None:
    fake = FakeConverse([AwsError("ValidationException", "nope"), ("ok", 12, 1)])
    result = client(fake, guard, ledger).probe(("us.amazon.nova-premier-v1:0", "us.amazon.nova-pro-v1:0"))
    assert result.chosen == "us.amazon.nova-pro-v1:0"
    assert result.outcomes == {
        "us.amazon.nova-premier-v1:0": "ValidationException",
        "us.amazon.nova-pro-v1:0": "ok",
    }
    assert [c.purpose for c in ledger.charges] == ["probe"]


def test_probe_reports_none_when_nothing_answers(guard: SpendGuard, ledger: Ledger) -> None:
    fake = FakeConverse([AwsError("AccessDeniedException", ARN_MESSAGE)])
    result = client(fake, guard, ledger).probe(("us.amazon.nova-pro-v1:0",))
    assert result.chosen is None
    assert result.outcomes == {"us.amazon.nova-pro-v1:0": "AccessDeniedException"}


class FakePolly:
    def __init__(self, pcm: bytes, billed: int | None = None) -> None:
        self.pcm = pcm
        self.billed = billed
        self.requests: list[dict[str, object]] = []

    def synthesize_speech(self, **kwargs: object) -> dict[str, object]:
        self.requests.append(kwargs)
        out: dict[str, object] = {"AudioStream": io.BytesIO(self.pcm), "ContentType": "audio/pcm"}
        if self.billed is not None:
            out["RequestCharacters"] = self.billed
        return out


def test_polly_renders_16k_pcm_and_meters_characters(guard: SpendGuard, ledger: Ledger) -> None:
    polly = FakePolly(b"\x01\x00" * 100 + b"\x07", billed=42)
    pcm = synthesize_pcm(polly, "Hi, it's Maya.", guard=guard, ledger=ledger, usd_per_million=16)
    assert len(pcm) == 200  # an odd trailing byte is dropped (16-bit samples)
    assert polly.requests == [
        {
            "Engine": "neural",
            "OutputFormat": "pcm",
            "SampleRate": "16000",
            "Text": "Hi, it's Maya.",
            "TextType": "text",
            "VoiceId": "Joanna",
        }
    ]
    [charge] = ledger.charges
    assert (charge.kind, charge.units_in, charge.usd) == ("polly", 42, 0.000672)


def test_polly_respects_the_budget(ledger: Ledger) -> None:
    guard = SpendGuard(app_budget=1, lab_budget=0.00001, ledger=ledger)
    polly = FakePolly(b"\x00\x00")
    with pytest.raises(BudgetExceededError):
        synthesize_pcm(polly, "x" * 1000, guard=guard, ledger=ledger, usd_per_million=16)
    assert polly.requests == []
