"""The Python mirrors still match the TypeScript contracts (packages/contracts/src) and the seed canary."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from foundry_evals import client, models
from foundry_evals.environment import seed_canary

CONTRACTS = Path(__file__).resolve().parents[2] / "packages" / "contracts" / "src"
SEED_IDS = Path(__file__).resolve().parents[2] / "packages" / "db" / "src" / "seed" / "ids.ts"

pytestmark = pytest.mark.skipif(not CONTRACTS.exists(), reason="contracts package not present")


def _source(name: str) -> str:
    return (CONTRACTS / name).read_text(encoding="utf-8")


def _enum(source: str, name: str) -> list[str]:
    match = re.search(rf"export const {name} = z\.enum\(\[(.*?)\]\)", source, re.DOTALL)
    assert match, name
    return re.findall(r"'([^']+)'", match.group(1))


def _object_keys(source: str, name: str) -> set[str]:
    match = re.search(rf"export const {name} = z\.object\(\{{(.*?)\n\}}\);", source, re.DOTALL)
    assert match, name
    return set(re.findall(r"^\s{2}(\w+):", match.group(1), re.MULTILINE))


def test_enums() -> None:
    domain = _source("domain.ts")
    assert tuple(_enum(domain, "CoachMode")) == models.COACH_MODES
    assert tuple(_enum(domain, "EscalationCategory")) == models.ESCALATION_CATEGORIES


def test_turn_stream_events() -> None:
    events = re.findall(r"event: z\.literal\('([^']+)'\)", _source("coach.ts"))
    assert tuple(events) == models.TURN_STREAM_EVENTS


def test_coach_response_fields() -> None:
    keys = _object_keys(_source("coach.ts"), "CoachResponse")
    assert keys == set(models.CoachResponse.model_fields)


def test_turn_view_fields() -> None:
    keys = _object_keys(_source("coach.ts"), "TurnView")
    aliases = {f.alias or name for name, f in models.TurnView.model_fields.items()}
    assert keys == aliases


def test_evidence_item_fields() -> None:
    domain = _source("domain.ts")
    keys = _object_keys(domain, "EvidenceItem")
    aliases = {f.alias or name for name, f in models.EvidenceItem.model_fields.items()}
    assert keys == aliases
    source = {f.alias or name for name, f in models.EvidenceSource.model_fields.items()}
    match = re.search(r"export const EvidenceSource = z\.object\(\{(.*?)\}\);", domain)
    assert match
    assert set(re.findall(r"(\w+):", match.group(1))) == source
    scopes = models.EvidenceSource.model_fields["scope"].annotation.__args__
    assert tuple(_enum(domain, "EvidenceSourceScope")) == scopes


def test_turn_blocked_detail_fields() -> None:
    keys = _object_keys(_source("coach.ts"), "TurnBlockedDetail")
    aliases = {f.alias or name for name, f in models.TurnBlockedDetail.model_fields.items()}
    assert keys == aliases


def test_turn_error_fields() -> None:
    match = re.search(r"event: z\.literal\('turn\.error'\),(.*?)\n  \}\)", _source("coach.ts"), re.DOTALL)
    assert match
    keys = {"event", *re.findall(r"^\s{4}(\w+):", match.group(1), re.MULTILINE)}
    aliases = {f.alias or name for name, f in models.TurnError.model_fields.items()}
    assert keys == aliases
    assert {"retryAfterSeconds", "requestId"} <= keys


def test_call_views() -> None:
    calls = _source("calls.ts")
    for model, name in (
        (models.CallView, "CallView"),
        (models.SpeechUnit, "SpeechUnit"),
        (models.StartCallResponse, "StartCallResponse"),
    ):
        aliases = {f.alias or n for n, f in model.model_fields.items()}
        assert aliases <= _object_keys(calls, name), name


def test_call_requests_the_client_sends() -> None:
    calls = _source("calls.ts")
    assert {"inputMode", "replace"} <= _object_keys(calls, "StartCallRequest")
    assert "reason" in _object_keys(calls, "EndCallRequest")
    assert "user" in _enum(calls, "CallEndReason")
    assert "typed" in _enum(calls, "CallInputMode")
    assert {"text", "mode", "rehearsalCounterpart", "channel", "callId"} <= _object_keys(
        _source("api.ts"), "CreateTurnRequest"
    )


def test_http_constants() -> None:
    api = _source("api.ts")
    assert f"API_PREFIX = '{client.API_PREFIX}'" in api
    assert f"CSRF_HEADER = '{client.CSRF_HEADER}'" in api
    assert f"CSRF_HEADER_VALUE = '{client.CSRF_HEADER_VALUE}'" in api
    assert f"IDEMPOTENCY_HEADER = '{client.IDEMPOTENCY_HEADER}'" in api
    assert f"SESSION_COOKIE = '{client.SESSION_COOKIE}'" in api
    assert f"REQUEST_ID_HEADER = '{client.REQUEST_ID_HEADER}'" in api


def test_document_viewer_views() -> None:
    api = _source("viewer.ts")
    assert tuple(_enum(api, "DocumentFileDisposition")) == models.DOCUMENT_FILE_DISPOSITIONS
    for model, name in (
        (models.DocumentFileResponse, "DocumentFileResponse"),
        (models.SourcePassage, "SourcePassage"),
        (models.SourceTextResponse, "SourceTextResponse"),
    ):
        aliases = {f.alias or n for n, f in model.model_fields.items()}
        assert aliases == _object_keys(api, name), name
    match = re.search(
        r"export const SourceTextResponse = z\.object\(\{\s*source: z\.object\(\{(.*?)\}\),", api, re.DOTALL
    )
    assert match
    source = {f.alias or n for n, f in models.SourceTextSource.model_fields.items()}
    assert set(re.findall(r"^\s{4}(\w+):", match.group(1), re.MULTILINE)) == source


def test_health_response_fields() -> None:
    keys = _object_keys(_source("api.ts"), "HealthResponse")
    assert keys == set(models.HealthResponse.model_fields)


def test_disclosure_matches_contract() -> None:
    from foundry_evals.graders.disclosure import grade_disclosure

    match = re.search(r"DEFAULT_DISCLOSURE =\s*'([^']+)'", _source("coach.ts"))
    assert match
    assert grade_disclosure(match.group(1)) == []


@pytest.mark.skipif(not SEED_IDS.exists(), reason="db package not present")
def test_seed_canary_formula_mirrors_typescript() -> None:
    source = SEED_IDS.read_text(encoding="utf-8")
    assert "foundry-ascent/canary/${ventureSlug}" in source
    assert "CANARY::${ventureSlug}::${out}" in source
    assert "% 32" in source
    assert re.fullmatch(r"CANARY::quietquad::[0-9A-HJKMNP-TV-Z]{8}", seed_canary("quietquad"))


def test_notebook_fields() -> None:
    # The mirror reads a subset of the notebook (whether it is empty, and its version for edits).
    keys = _object_keys(_source("knowledge.ts"), "VeirNotebook")
    aliases = {f.alias or name for name, f in models.VeirNotebook.model_fields.items()}
    assert aliases <= keys
    edits = re.findall(r"action: z\.literal\('([a-z_]+)'\)", _source("knowledge.ts"))
    assert {"edit_summary", "clear"} <= set(edits)


def test_memory_and_session_mirrors_name_real_fields() -> None:
    domain = _source("domain.ts")
    memory = _object_keys(domain, "MemoryObjectView")
    aliases = {f.alias or name for name, f in models.MemoryObject.model_fields.items()}
    assert aliases <= memory
    assert {"origin", "keptAutomatically"} <= aliases
    session = _object_keys(_source("coach.ts"), "SessionView")
    session_aliases = {f.alias or name for name, f in models.SessionView.model_fields.items()}
    assert session_aliases <= session
    assert "opener" in session_aliases


def test_conversation_opener_mirror() -> None:
    api = _source("api.ts")
    keys = _object_keys(api, "ConversationOpenerResponse")
    assert keys == {f.alias or name for name, f in models.ConversationOpener.model_fields.items()}
    match = re.search(r"lastConversation: z\s*\.object\(\{(.*?)\}\)", api, re.DOTALL)
    assert match
    nested = set(re.findall(r"^\s+(\w+):", match.group(1), re.MULTILINE))
    assert nested == {f.alias or name for name, f in models.LastConversation.model_fields.items()}


def test_memory_candidate_mirror_names_its_source() -> None:
    coach = _source("coach.ts")
    assert _object_keys(coach, "MemoryCandidate") == set(models.MemoryCandidate.model_fields)
    labels = models.MemoryCandidate.model_fields["source"].annotation
    assert set(_enum(coach, "MemoryCandidateSource")) == {
        value for arg in getattr(labels, "__args__", ()) for value in getattr(arg, "__args__", ())
    }
