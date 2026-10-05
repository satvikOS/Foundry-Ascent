"""Offline tests for ops/aws/verify_access.py (no AWS access)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import verify_access as v


def write_config(tmp_path: Path, models: object) -> Path:
    path = tmp_path / "production.json"
    path.write_text(json.dumps({"region": "us-east-1", "models": models}), encoding="utf-8")
    return path


def test_repository_config_matches_the_documented_state() -> None:
    # Luna is gated by AWS for the account and disabled in production (ADR-0014): its probes only warn.
    required, note = v.luna_enabled()
    assert required is False
    assert "WARN" in note


@pytest.mark.parametrize(
    ("models", "required"),
    [
        ({"luna": {"modelId": v.LUNA, "enabled": True}}, True),
        ({"luna": {"modelId": v.LUNA, "enabled": False}}, False),
        ({"luna": {"modelId": v.LUNA, "enabled": "true"}}, False),  # only a JSON true enables it
        ({}, False),
        ("not an object", False),
    ],
)
def test_luna_probes_follow_the_flag(tmp_path: Path, models: object, required: bool) -> None:
    assert v.luna_enabled(write_config(tmp_path, models))[0] is required


def test_unreadable_config_fails_closed(tmp_path: Path) -> None:
    missing = v.luna_enabled(tmp_path / "missing.json")
    assert missing[0] is True
    broken = tmp_path / "broken.json"
    broken.write_text("{", encoding="utf-8")
    assert v.luna_enabled(broken)[0] is True


def test_optional_probe_failure_is_a_warning(capsys: pytest.CaptureFixture[str]) -> None:
    probe = v.run_probe("luna", lambda: ("FAIL", "HTTP 401 not available for this account", {}), required=False)
    assert probe.status == "WARN"
    assert not probe.failed
    required = v.run_probe("nova", lambda: ("FAIL", "AccessDeniedException", {}))
    assert required.failed
    assert "[WARN]" in capsys.readouterr().out
