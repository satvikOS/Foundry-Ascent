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


def test_http_constants() -> None:
    api = _source("api.ts")
    assert f"API_PREFIX = '{client.API_PREFIX}'" in api
    assert f"CSRF_HEADER = '{client.CSRF_HEADER}'" in api
    assert f"CSRF_HEADER_VALUE = '{client.CSRF_HEADER_VALUE}'" in api
    assert f"IDEMPOTENCY_HEADER = '{client.IDEMPOTENCY_HEADER}'" in api
    assert f"SESSION_COOKIE = '{client.SESSION_COOKIE}'" in api
    assert f"REQUEST_ID_HEADER = '{client.REQUEST_ID_HEADER}'" in api


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
