from __future__ import annotations

import json
from pathlib import Path

import pytest

from conversation_lab import config


def test_app_models_follow_the_production_config_while_luna_is_disabled() -> None:
    models = config.app_models()
    assert models == config.AppModels(
        primary="us.amazon.nova-2-lite-v1:0",
        fallback="global.amazon.nova-2-lite-v1:0",
        embeddings="amazon.titan-embed-text-v2:0",
    )


def test_app_models_put_luna_first_once_enabled(tmp_path: Path) -> None:
    raw = json.loads(config.PRODUCTION_CONFIG.read_text(encoding="utf-8"))
    raw["models"]["luna"]["enabled"] = True
    path = tmp_path / "production.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    models = config.app_models(path)
    assert models.primary == "openai.gpt-6-luna"
    assert models.fallback == "us.amazon.nova-2-lite-v1:0"


def test_lab_models_are_priced_and_shared_with_infra() -> None:
    lab = config.lab_models()
    assert lab.simulator[0] == "us.amazon.nova-pro-v1:0"
    assert lab.judge[0] == "us.amazon.nova-premier-v1:0"
    assert lab.prices["amazon.nova-premier-v1:0"] == config.Price(2.5, 12.5)
    # infra/cdk/src/lib/lab-models.ts reads the same file to grant exactly these models.
    source = (config.REPO / "infra" / "cdk" / "src" / "lib" / "lab-models.ts").read_text(encoding="utf-8")
    assert "join(REPO_ROOT, 'ops', 'lab', 'models.json')" in source


def test_lab_models_refuse_an_unpriced_model(tmp_path: Path) -> None:
    raw = json.loads(config.MODELS_FILE.read_text(encoding="utf-8"))
    raw["judge"] = ["us.amazon.nova-micro-v1:0"]
    path = tmp_path / "models.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError, match="no price"):
        config.lab_models(path)


def test_polly_is_metered_at_the_price_the_app_meters_it_at() -> None:
    assert config.polly_usd_per_million_characters("neural") == 16
    assert config.polly_usd_per_million_characters("generative") == 30


def test_foundation_model_id_strips_profile_prefixes() -> None:
    assert config.foundation_model_id("us.amazon.nova-pro-v1:0") == "amazon.nova-pro-v1:0"
    assert config.foundation_model_id("global.amazon.nova-2-lite-v1:0") == "amazon.nova-2-lite-v1:0"
    assert config.foundation_model_id("amazon.titan-embed-text-v2:0") == "amazon.titan-embed-text-v2:0"


def test_suites_and_budget_split() -> None:
    assert config.suites_for("all") == ["recall", "voice", "matrix", "ui"]
    assert config.suites_for("voice") == ["voice"]
    with pytest.raises(ValueError, match="suite must be"):
        config.suites_for("everything")
    split = config.split_budget(5, config.suites_for("all"))
    assert split == {"recall": 0.83, "voice": 0.83, "matrix": 1.66, "ui": 1.66}
    assert sum(split.values()) <= 5
    assert config.split_budget(5, ["recall"]) == {"recall": 5.0}
    for bad in (0, -1, 50.01):
        with pytest.raises(ValueError, match="budget"):
            config.split_budget(bad, ["recall"])


def test_budget_parts_never_exceed_the_suite_budget() -> None:
    for suite in config.SUITES:
        for budget in (0.83, 1.66, 5.0, 12.34):
            app, lab = config.budget_parts(suite, budget)
            assert app >= 0
            assert lab >= 0
            assert app + lab <= budget + 1e-9
    assert config.budget_parts("ui", 1.66) == (1.66, 0.0)
    assert config.budget_parts("matrix", 1.66) == (0.91, 0.75)
